import { realpathSync } from "node:fs";
import path from "node:path";
import { isWindowsAbsolutePath, samePath } from "./paths";

interface ComparablePath {
  flavor: "posix" | "windows";
  comparable: string;
  separator: "/" | "\\";
  filesystemRoot: string;
}

function hasWindowsDevicePrefix(value: string): boolean {
  return /^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(value);
}

function hasWindowsAlternateDataStream(value: string): boolean {
  const withoutDrive = /^[a-zA-Z]:/.test(value) ? value.slice(2) : value;
  return withoutDrive.includes(":");
}

function comparableAbsolutePath(value: string): ComparablePath | null {
  if (!value || value.includes("\0")) return null;

  if (isWindowsAbsolutePath(value)) {
    if (hasWindowsDevicePrefix(value) || hasWindowsAlternateDataStream(value)) return null;
    const normalized = path.win32.normalize(value);
    if (!path.win32.isAbsolute(normalized)) return null;
    return {
      flavor: "windows",
      comparable: normalized.toLowerCase(),
      separator: "\\",
      filesystemRoot: path.win32.parse(normalized).root.toLowerCase(),
    };
  }

  if (!path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  return {
    flavor: "posix",
    comparable: normalized,
    separator: "/",
    filesystemRoot: path.posix.parse(normalized).root,
  };
}

/** True for POSIX `/`, Windows drive roots and UNC share roots. */
export function isFilesystemRootPath(value: string): boolean {
  const comparable = comparableAbsolutePath(value);
  return comparable !== null && comparable.comparable === comparable.filesystemRoot;
}

/**
 * Absolute lexical containment. Windows separator/case variants compare as the
 * same path, while device paths, ADS paths and filesystem roots fail closed.
 */
export function isPathWithinRoots(target: string, roots: ReadonlySet<string>): boolean {
  const comparableTarget = comparableAbsolutePath(target);
  if (!comparableTarget) return false;

  for (const root of roots) {
    const comparableRoot = comparableAbsolutePath(root);
    if (!comparableRoot || comparableRoot.flavor !== comparableTarget.flavor) continue;
    if (isFilesystemRootPath(root)) continue;

    const rootWithSeparator = comparableRoot.comparable.endsWith(comparableRoot.separator)
      ? comparableRoot.comparable
      : comparableRoot.comparable + comparableRoot.separator;
    if (
      comparableTarget.comparable === comparableRoot.comparable
      || comparableTarget.comparable.startsWith(rootWithSeparator)
    ) {
      return true;
    }
  }
  return false;
}

/** Resolve the target and verify stored canonical roots have not been rebound. */
export function isExistingPathWithinRoots(target: string, roots: ReadonlySet<string>): boolean {
  let realTarget: string;
  try {
    realTarget = realpathSync.native(target);
  } catch {
    return false;
  }

  return isPathWithinRoots(realTarget, canonicalExistingRoots(roots));
}

function canonicalExistingRoots(roots: ReadonlySet<string>): Set<string> {
  const realRoots = new Set<string>();
  for (const root of roots) {
    try {
      const realRoot = realpathSync.native(root);
      // Grants store canonical roots. If that path is later replaced by a
      // symlink/junction, do not silently transfer the grant to its new target.
      if (samePath(realRoot, root)) realRoots.add(realRoot);
    } catch {
      // Ignore stale roots derived from removed sessions or worktrees.
    }
  }
  return realRoots;
}

/** Return the canonical authorized path so callers need not use a symlink path. */
export function resolveExistingPathWithinRoots(
  target: string,
  roots: ReadonlySet<string>,
): string | null {
  let realTarget: string;
  try {
    realTarget = realpathSync.native(target);
  } catch {
    return null;
  }
  return isPathWithinRoots(realTarget, canonicalExistingRoots(roots)) ? realTarget : null;
}
