import type { Dirent } from "fs";
import { opendir, realpath, stat } from "fs/promises";
import { homedir } from "os";
import path from "path";

export const MAX_BROWSE_DIRECTORY_ENTRIES = 10_000;
const SYMLINK_STAT_BATCH_SIZE = 64;

export class DirectoryEntryLimitError extends Error {
  constructor() {
    super("Directory contains too many entries");
    this.name = "DirectoryEntryLimitError";
  }
}

export interface BrowsableDirectory {
  name: string;
  path: string;
}

export function shouldShowWindowsDrivePicker(
  directory?: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && !directory;
}

export function getBrowseStartDirectory(directory?: string): string {
  return directory || homedir();
}

export function getWindowsDriveCandidates(): BrowsableDirectory[] {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => ({
    name: `${letter}:`,
    path: `${letter}:\\`,
  }));
}

export async function listWindowsDrives(): Promise<BrowsableDirectory[]> {
  const candidates = await Promise.all(getWindowsDriveCandidates().map(async (drive) => {
    try {
      const driveStat = await stat(drive.path);
      return driveStat.isDirectory() ? drive : null;
    } catch {
      return null;
    }
  }));

  return candidates.filter((drive): drive is BrowsableDirectory => drive !== null);
}

export function normalizeDirectory(directory: string): string {
  if (directory === "~") return homedir();
  if (directory.startsWith("~/")) return path.resolve(homedir(), directory.slice(2));
  return path.resolve(directory);
}

export function getParentDirectory(directory: string): string | null {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith("\\\\")
    ? path.win32
    : path.posix;
  const normalized = pathApi.normalize(directory);
  const parent = pathApi.dirname(normalized);
  return parent === normalized ? null : parent;
}

export async function resolveDirectory(directory: string): Promise<string> {
  return realpath(normalizeDirectory(directory));
}

async function resolveBrowsableEntry(
  directory: string,
  entry: Dirent,
): Promise<BrowsableDirectory | null> {
  if (entry.isDirectory()) {
    return { name: entry.name, path: path.join(directory, entry.name) };
  }
  if (!entry.isSymbolicLink()) return null;

  try {
    const entryPath = path.join(directory, entry.name);
    const realEntryPath = await realpath(entryPath);
    const entryStat = await stat(realEntryPath);
    if (!entryStat.isDirectory()) return null;
    return { name: entry.name, path: entryPath };
  } catch {
    return null;
  }
}

export async function listDirectories(
  directory: string,
  entryLimit = MAX_BROWSE_DIRECTORY_ENTRIES,
): Promise<BrowsableDirectory[]> {
  if (
    !Number.isSafeInteger(entryLimit)
    || entryLimit < 1
    || entryLimit > MAX_BROWSE_DIRECTORY_ENTRIES
  ) {
    throw new TypeError("Invalid directory entry limit");
  }

  const entries: Dirent[] = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    if (entries.length >= entryLimit) throw new DirectoryEntryLimitError();
    entries.push(entry);
  }

  // Ignore inaccessible symlinks and bound concurrent filesystem probes.
  const directories: BrowsableDirectory[] = [];
  for (let index = 0; index < entries.length; index += SYMLINK_STAT_BATCH_SIZE) {
    const candidates = await Promise.all(
      entries.slice(index, index + SYMLINK_STAT_BATCH_SIZE)
        .map((entry) => resolveBrowsableEntry(directory, entry)),
    );
    directories.push(...candidates.filter(
      (entry): entry is BrowsableDirectory => entry !== null,
    ));
  }

  return directories.sort((left, right) => left.name.localeCompare(right.name));
}
