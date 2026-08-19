import fs from "node:fs";
import path from "node:path";
import { getSessionEntries, resolveSessionPath } from "./session-reader";
import { isSessionOwnedBy } from "./session-ownership";
export { isFilePathReferencedByEntries } from "./session-file-references-core";
import {
  isBashOutputPathReferencedByEntries,
  isFilePathReferencedByEntries,
  isValidSessionId,
} from "./session-file-references-core";

export function isExistingPathSymlinkFree(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const { root } = path.parse(resolved);
  let current = root;

  try {
    for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    return fs.lstatSync(resolved).isFile();
  } catch {
    return false;
  }
}

export async function isFilePathReferencedBySession(
  filePath: string,
  sessionId: string | null,
  ownerId: string,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    if (!isSessionOwnedBy(sessionId, ownerId)) return false;
    if (!isExistingPathSymlinkFree(filePath)) return false;
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    return isFilePathReferencedByEntries(filePath, getSessionEntries(sessionPath));
  } catch {
    return false;
  }
}

export async function isBashOutputPathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    return isBashOutputPathReferencedByEntries(filePath, getSessionEntries(sessionPath));
  } catch {
    return false;
  }
}
