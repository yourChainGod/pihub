import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  allowedRootKey,
  allowedRootScopeKey,
  canonicalizeAllowedFileRoot,
  DEFAULT_ALLOWED_ROOT_SCOPE,
  getAdditionalAllowedRoots,
  getRevokedAllowedRoots,
  type AllowedRootScope,
} from "./allowed-roots";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { listAllSessions } from "./session-reader";
import { getSessionOwners } from "./session-ownership";

export {
  allowFileRoot,
  AllowedRootError,
  allowedRootKey,
  canonicalizeAllowedFileRoot,
  DEFAULT_ALLOWED_ROOT_SCOPE,
  normalizeSlashes,
  revokeFileRoot,
  type AllowedRootScope,
} from "./allowed-roots";
export { isWindowsAbsolutePath } from "./paths";

const ALLOWED_ROOTS_TTL_MS = 5_000;

function addSafeRoot(roots: Set<string>, candidate: string | null | undefined): void {
  if (!candidate) return;
  try {
    roots.add(allowedRootKey(canonicalizeAllowedFileRoot(candidate)));
  } catch {
    // Stale, malformed, sensitive and attacker-forged session roots are ignored.
  }
}

function cacheByOwner() {
  globalThis.__piAllowedRootsCacheByOwner ??= new Map();
  return globalThis.__piAllowedRootsCacheByOwner;
}

/**
 * Return a scoped snapshot of canonical roots. Persisted session roots are
 * included only for their durable owner; unclaimed legacy sessions never grant
 * a remotely authenticated device filesystem access.
 */
export async function getAllowedFileRoots(
  scope: AllowedRootScope = DEFAULT_ALLOWED_ROOT_SCOPE,
): Promise<Set<string>> {
  const ownerId = allowedRootScopeKey(scope);
  const now = Date.now();
  const cached = cacheByOwner().get(ownerId);
  if (cached && cached.expiresAt > now) return new Set(cached.roots);

  const roots = new Set<string>();
  const sessions = await listAllSessions({ includeProjectInfo: false });
  const owners = getSessionOwners(sessions.map((session) => session.id));
  for (const session of sessions) {
    if (owners.get(session.id) === ownerId) addSafeRoot(roots, session.cwd);
  }

  if (ownerId === allowedRootScopeKey(DEFAULT_ALLOWED_ROOT_SCOPE)) {
    // The managed scratch roots are safe children of home, never home itself.
    try {
      for (const name of readdirSync(homedir())) {
        if (name === "pi-cwd" || /^pi-cwd-\d{8}$/.test(name)) {
          addSafeRoot(roots, path.join(homedir(), name));
        }
      }
    } catch {
      // An unreadable home contributes no implicit authorization.
    }
  }

  for (const root of getAdditionalAllowedRoots(scope)) roots.add(root);
  for (const root of getRevokedAllowedRoots(scope)) roots.delete(root);

  cacheByOwner().set(ownerId, {
    roots: new Set(roots),
    expiresAt: now + ALLOWED_ROOTS_TTL_MS,
  });
  return roots;
}

/** Authorize an absolute path lexically, without touching the filesystem. */
export function isFilePathAllowed(target: string, allowedRoots: ReadonlySet<string>): boolean {
  return isPathWithinRoots(target, allowedRoots);
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(
  target: string,
  allowedRoots: ReadonlySet<string>,
): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}
