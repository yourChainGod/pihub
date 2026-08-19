import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { isFilesystemRootPath, isPathWithinRoots } from "./path-security";
import { isWindowsAbsolutePath, samePath, toSlashPath } from "./paths";

export interface AllowedRootScope {
  /** Stable authenticated identity. Never populate this from request input. */
  readonly ownerId: string;
}

export const DEFAULT_ALLOWED_ROOT_SCOPE: AllowedRootScope = Object.freeze({
  ownerId: "legacy-server",
});

export type AllowedRootErrorCode =
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "NOT_DIRECTORY"
  | "UNSAFE_ROOT";

export class AllowedRootError extends Error {
  constructor(
    readonly code: AllowedRootErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AllowedRootError";
  }
}

interface AllowedRootRegistry {
  version: 1;
  grantsByOwner: Map<string, Set<string>>;
  revocationsByOwner: Map<string, Set<string>>;
}

export interface AllowedRootsCacheEntry {
  roots: Set<string>;
  expiresAt: number;
}

declare global {
  // Stored on globalThis so grants and revocations survive Next.js hot reload.
  var __piAllowedRootRegistry: AllowedRootRegistry | undefined;
  var __piAllowedRootsCacheByOwner: Map<string, AllowedRootsCacheEntry> | undefined;
}

function registry(): AllowedRootRegistry {
  if (!globalThis.__piAllowedRootRegistry || globalThis.__piAllowedRootRegistry.version !== 1) {
    globalThis.__piAllowedRootRegistry = {
      version: 1,
      grantsByOwner: new Map(),
      revocationsByOwner: new Map(),
    };
  }
  return globalThis.__piAllowedRootRegistry;
}

export function allowedRootScopeKey(scope: AllowedRootScope = DEFAULT_ALLOWED_ROOT_SCOPE): string {
  const ownerId = scope.ownerId;
  if (
    typeof ownerId !== "string"
    || ownerId.length === 0
    || ownerId.length > 256
    || /[\0\r\n]/.test(ownerId)
  ) {
    throw new TypeError("Allowed-root scope requires a valid ownerId");
  }
  return ownerId;
}

/** Slash-normalization for URL/path interop. Do not use it as authorization. */
export function normalizeSlashes(filePath: string): string {
  return toSlashPath(filePath);
}

/**
 * Stable internal key for a canonical path. Windows paths are case-insensitive,
 * including UNC server/share names, so casing cannot create a second grant.
 */
export function allowedRootKey(filePath: string): string {
  const normalized = isWindowsAbsolutePath(filePath)
    ? path.win32.normalize(filePath).replace(/\\/g, "/")
    : path.posix.normalize(filePath);
  return isWindowsAbsolutePath(filePath) ? normalized.toLowerCase() : normalized;
}

function canonicalIfPresent(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function exactSensitiveRoots(home: string): string[] {
  const candidates = [
    tmpdir(),
    path.parse(home).root,
    ...(process.platform === "win32"
      ? [
          process.env.PUBLIC,
        ]
      : ["/home", "/Users", "/Volumes", "/mnt", "/media", "/tmp", "/opt", "/var"]),
  ];
  return candidates
    .filter((candidate): candidate is string => Boolean(candidate))
    .map(canonicalIfPresent);
}

function sensitiveTrees(home: string): string[] {
  const homeTrees = [
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".cache",
    ".config",
    ".kube",
    ".docker",
    ".local/share",
    ".npm",
    ".password-store",
    ".pi",
    ".codex",
  ].map((relative) => path.join(home, relative));

  if (process.platform === "win32") {
    const systemDrive = path.parse(home).root;
    return [
      ...homeTrees,
      path.join(home, "AppData"),
      process.env.SystemRoot,
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.ProgramData,
      path.join(systemDrive, "Windows"),
      path.join(systemDrive, "Program Files"),
      path.join(systemDrive, "Program Files (x86)"),
      path.join(systemDrive, "ProgramData"),
    ].filter((candidate): candidate is string => Boolean(candidate)).map(canonicalIfPresent);
  }

  const systemTrees = [
    "/boot",
    "/dev",
    "/etc",
    "/proc",
    "/root",
    "/run",
    "/sys",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/var/lib",
    "/var/log",
    "/var/run",
  ];
  if (process.platform === "darwin") {
    systemTrees.push(
      "/Applications",
      "/Library",
      "/System",
      "/private/etc",
      "/private/var/db",
      "/private/var/log",
      "/private/var/root",
      "/private/var/run",
    );
    homeTrees.push(path.join(home, "Library"));
  }
  return [...homeTrees, ...systemTrees].map(canonicalIfPresent);
}

function isUnsafeCanonicalRoot(canonicalRoot: string): boolean {
  if (isFilesystemRootPath(canonicalRoot)) return true;
  const home = canonicalIfPresent(homedir());
  if (samePath(canonicalRoot, home)) return true;
  if (exactSensitiveRoots(home).some((candidate) => samePath(canonicalRoot, candidate))) {
    return true;
  }
  return sensitiveTrees(home).some((sensitiveRoot) => (
    isPathWithinRoots(canonicalRoot, new Set([sensitiveRoot]))
  ));
}

/** Resolve and validate a workspace directory without granting it. */
export function canonicalizeAllowedFileRoot(root: string): string {
  if (
    typeof root !== "string"
    || root.length === 0
    || root.includes("\0")
    || !path.isAbsolute(root)
  ) {
    throw new AllowedRootError("INVALID_PATH", "Workspace path must be absolute");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch {
    throw new AllowedRootError("NOT_FOUND", "Workspace directory does not exist");
  }

  let stats;
  try {
    stats = statSync(canonicalRoot);
  } catch {
    throw new AllowedRootError("NOT_FOUND", "Workspace directory does not exist");
  }
  if (!stats.isDirectory()) {
    throw new AllowedRootError("NOT_DIRECTORY", "Workspace path is not a directory");
  }
  if (isUnsafeCanonicalRoot(canonicalRoot)) {
    throw new AllowedRootError("UNSAFE_ROOT", "Workspace directory is protected");
  }
  return canonicalRoot;
}

function rootsForOwner(
  map: Map<string, Set<string>>,
  scope: AllowedRootScope,
): Set<string> {
  const ownerId = allowedRootScopeKey(scope);
  let roots = map.get(ownerId);
  if (!roots) {
    roots = new Set();
    map.set(ownerId, roots);
  }
  return roots;
}

/** Return a snapshot so callers cannot mutate the authorization registry. */
export function getAdditionalAllowedRoots(
  scope: AllowedRootScope = DEFAULT_ALLOWED_ROOT_SCOPE,
): ReadonlySet<string> {
  return new Set(rootsForOwner(registry().grantsByOwner, scope));
}

export function getRevokedAllowedRoots(
  scope: AllowedRootScope = DEFAULT_ALLOWED_ROOT_SCOPE,
): ReadonlySet<string> {
  return new Set(rootsForOwner(registry().revocationsByOwner, scope));
}

/** Validate, canonicalize and grant a root to one authenticated identity scope. */
export function allowFileRoot(
  root: string,
  scope: AllowedRootScope = DEFAULT_ALLOWED_ROOT_SCOPE,
): string {
  const canonicalRoot = canonicalizeAllowedFileRoot(root);
  const key = allowedRootKey(canonicalRoot);
  const ownerId = allowedRootScopeKey(scope);
  rootsForOwner(registry().grantsByOwner, scope).add(key);
  rootsForOwner(registry().revocationsByOwner, scope).delete(key);
  globalThis.__piAllowedRootsCacheByOwner?.get(ownerId)?.roots.add(key);
  return canonicalRoot;
}

/**
 * Revoke an explicit or session-derived root. The tombstone prevents an old
 * session header from silently granting it again until allowFileRoot is called.
 */
export function revokeFileRoot(
  root: string,
  scope: AllowedRootScope = DEFAULT_ALLOWED_ROOT_SCOPE,
): boolean {
  let key: string;
  try {
    key = allowedRootKey(realpathSync.native(root));
  } catch {
    if (!path.isAbsolute(root) || root.includes("\0")) return false;
    key = allowedRootKey(path.resolve(root));
  }

  const ownerId = allowedRootScopeKey(scope);
  const grants = rootsForOwner(registry().grantsByOwner, scope);
  const revocations = rootsForOwner(registry().revocationsByOwner, scope);
  const cacheRoots = globalThis.__piAllowedRootsCacheByOwner?.get(ownerId)?.roots;
  const changed = grants.delete(key) || cacheRoots?.has(key) === true || !revocations.has(key);
  revocations.add(key);
  cacheRoots?.delete(key);
  return changed;
}
