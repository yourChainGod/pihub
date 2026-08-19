import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { samePath } from "./paths";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);
const WINDOWS_RESERVED_FILE_STEMS = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com(?:[1-9]|[\u00b9\u00b2\u00b3])|lpt(?:[1-9]|[\u00b9\u00b2\u00b3]))$/i;
const WINDOWS_INVALID_FILE_CHARS = /[<>:"|?*\u0000-\u001f]/;
const MAX_FILE_NAME_BYTES = 255;
export const MAX_PORTABLE_COLLISION_SCAN_ENTRIES = 10_000;

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export interface UploadDirectoryGuard {
  readonly canonicalPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

interface StagedUploadProof {
  readonly directory: UploadDirectoryGuard;
  readonly file: FileIdentity;
}

const STAGED_UPLOAD_PROOFS = Symbol.for("pihub.staged-upload-proofs");
const stagedUploadProofs = (() => {
  const runtime = globalThis as typeof globalThis & {
    [STAGED_UPLOAD_PROOFS]?: Map<string, StagedUploadProof>;
  };
  runtime[STAGED_UPLOAD_PROOFS] ??= new Map<string, StagedUploadProof>();
  return runtime[STAGED_UPLOAD_PROOFS];
})();

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
      return `File names must not contain a path: ${fileName}`;
    }
    if (Buffer.byteLength(fileName, "utf8") > MAX_FILE_NAME_BYTES) {
      return `File name is too long: ${fileName}`;
    }
    if (WINDOWS_INVALID_FILE_CHARS.test(fileName)) {
      return `File name contains characters that are not portable: ${fileName}`;
    }
    if (/[. ]$/.test(fileName)) {
      return `File names must not end in a dot or space: ${fileName}`;
    }
    const stem = fileName.split(".", 1)[0].replace(/[. ]+$/g, "");
    if (WINDOWS_RESERVED_FILE_STEMS.test(stem)) {
      return `Reserved Windows file name: ${fileName}`;
    }

    // Windows and the default macOS filesystem compare names without case;
    // normalize first so a batch cannot overwrite itself cross-platform.
    const comparisonKey = portableFileNameKey(fileName);
    if (seen.has(comparisonKey)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(comparisonKey);
  }

  return null;
}

export class UploadTargetNotReplaceableError extends Error {
  constructor() {
    super("Cannot replace a directory or symbolic link");
  }
}

export class UploadDirectoryChangedError extends Error {
  constructor() {
    super("Upload directory changed during file operation");
  }
}

export class UploadDirectoryScanLimitError extends Error {
  constructor() {
    super("Upload directory contains too many entries for a portable collision check");
  }
}

interface UploadPublishOperations {
  linkSync(source: string, destination: string): void;
  lstatSync(filePath: string): fs.Stats;
  renameSync(source: string, destination: string): void;
  unlinkSync(filePath: string): void;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function fileIdentity(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function matchesFileIdentity(stat: fs.Stats, expected: FileIdentity): boolean {
  return stat.dev === expected.dev
    && stat.ino === expected.ino
    && stat.birthtimeMs === expected.birthtimeMs;
}

function portableFileNameKey(fileName: string): string {
  // Upper-casing also collapses Unicode pairs such as Greek sigma/final sigma,
  // matching Windows' case-insensitive comparison more closely than lower-case.
  return fileName.normalize("NFC").toUpperCase();
}

function collisionError(): NodeJS.ErrnoException {
  const error = new Error("Destination already exists") as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
}

function readPortableNameMatches(
  directory: string,
  fileNames: readonly string[],
  maxEntries = MAX_PORTABLE_COLLISION_SCAN_ENTRIES,
): { complete: boolean; matches: Map<string, string[]> } {
  const requestedKeys = new Set(fileNames.map(portableFileNameKey));
  const matches = new Map<string, string[]>();
  const opened = fs.opendirSync(directory);
  let count = 0;
  try {
    while (true) {
      const entry = opened.readSync();
      if (!entry) return { complete: true, matches };
      count += 1;
      if (count > maxEntries) return { complete: false, matches };
      const key = portableFileNameKey(entry.name);
      if (!requestedKeys.has(key)) continue;
      const names = matches.get(key) ?? [];
      names.push(entry.name);
      matches.set(key, names);
    }
  } finally {
    opened.closeSync();
  }
}

export function captureUploadDirectoryGuard(directory: string): UploadDirectoryGuard {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UploadDirectoryChangedError();
  const canonicalPath = fs.realpathSync.native(directory);
  const canonicalStat = fs.lstatSync(canonicalPath);
  if (!sameFileIdentity(stat, canonicalStat)) throw new UploadDirectoryChangedError();
  return { canonicalPath, ...fileIdentity(canonicalStat) };
}

export function assertUploadDirectoryGuard(directory: string, expected: UploadDirectoryGuard): void {
  const current = captureUploadDirectoryGuard(directory);
  if (
    !samePath(current.canonicalPath, expected.canonicalPath)
    || current.dev !== expected.dev
    || current.ino !== expected.ino
    || current.birthtimeMs !== expected.birthtimeMs
  ) {
    throw new UploadDirectoryChangedError();
  }
}

/** Fail closed when an existing name would alias this name on Windows/macOS. */
export function assertPortableFileNameAvailable(
  directory: string,
  fileName: string,
  allowExistingExact = false,
  maxEntries = MAX_PORTABLE_COLLISION_SCAN_ENTRIES,
): UploadDirectoryGuard {
  const validationError = validateUploadFileNames([fileName]);
  if (validationError) throw new Error(validationError);
  const guard = captureUploadDirectoryGuard(directory);
  const scan = readPortableNameMatches(directory, [fileName], maxEntries);
  assertUploadDirectoryGuard(directory, guard);
  if (!scan.complete) throw new UploadDirectoryScanLimitError();
  const matches = scan.matches.get(portableFileNameKey(fileName)) ?? [];
  if (matches.length === 0) return guard;
  if (allowExistingExact && matches.length === 1 && matches[0] === fileName) return guard;
  throw collisionError();
}

export function registerStagedUploadTemporaryFile(
  temporaryPath: string,
  directory: UploadDirectoryGuard,
  openedStat: fs.Stats,
): void {
  assertUploadDirectoryGuard(path.dirname(temporaryPath), directory);
  const namedStat = fs.lstatSync(temporaryPath);
  if (
    !namedStat.isFile()
    || namedStat.isSymbolicLink()
    || !sameFileIdentity(namedStat, openedStat)
  ) {
    throw new UploadDirectoryChangedError();
  }
  stagedUploadProofs.set(temporaryPath, { directory, file: fileIdentity(openedStat) });
}

export function forgetStagedUploadTemporaryFile(temporaryPath: string): void {
  stagedUploadProofs.delete(temporaryPath);
}

/** Publish a complete same-directory temporary file without following links. */
export function publishUploadTemporaryFile(
  temporary: string,
  destination: string,
  existing: fs.Stats | null,
  _platform: NodeJS.Platform = process.platform,
  operations: UploadPublishOperations = fs,
  expectedDirectory?: UploadDirectoryGuard,
): void {
  // Retained for source compatibility with existing platform-simulation tests.
  void _platform;
  const directory = path.dirname(destination);
  if (!samePath(path.dirname(temporary), directory)) throw new UploadDirectoryChangedError();
  const stagedProof = stagedUploadProofs.get(temporary);
  const directoryGuard = expectedDirectory ?? stagedProof?.directory ?? captureUploadDirectoryGuard(directory);
  assertUploadDirectoryGuard(directory, directoryGuard);
  const temporaryStat = operations.lstatSync(temporary);
  if (
    !temporaryStat.isFile()
    || temporaryStat.isSymbolicLink()
    || (stagedProof && !matchesFileIdentity(temporaryStat, stagedProof.file))
  ) {
    throw new UploadDirectoryChangedError();
  }
  assertPortableFileNameAvailable(directory, path.basename(destination), existing !== null);

  if (!existing) {
    // A hard link publishes the already-complete inode and fails if another
    // writer created the destination first. Removing the temp keeps one link.
    operations.linkSync(temporary, destination);
    operations.unlinkSync(temporary);
    stagedUploadProofs.delete(temporary);
    return;
  }

  const current = operations.lstatSync(destination);
  if (
    !current.isFile()
    || current.isSymbolicLink()
    || !sameFileIdentity(existing, current)
  ) {
    throw new UploadTargetNotReplaceableError();
  }
  assertUploadDirectoryGuard(directory, directoryGuard);

  // libuv implements same-volume file replacement with one rename operation
  // on Windows, macOS and Linux. A backup dance creates a visible missing-file
  // window and is therefore deliberately avoided.
  operations.renameSync(temporary, destination);
  stagedUploadProofs.delete(temporary);
}

/** Replace an existing regular file without an unlink/write data-loss window. */
export function writeUploadFileAtomically(
  directory: string,
  fileName: string,
  contents: Uint8Array,
  overwrite: boolean,
): void {
  const validationError = validateUploadFileNames([fileName]);
  if (validationError) throw new Error(validationError);

  const destination = path.join(directory, fileName);
  const directoryGuard = captureUploadDirectoryGuard(directory);
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (existing && !overwrite) {
    const error = new Error("File already exists") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new UploadTargetNotReplaceableError();
  }
  assertPortableFileNameAvailable(directory, fileName, existing !== null);

  const temporary = path.join(directory, `.${fileName}.${randomUUID()}.upload`);
  let temporaryIdentity: FileIdentity | null = null;
  let descriptor: number | null = null;
  let published = false;
  try {
    const noFollow = process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
      ? fs.constants.O_NOFOLLOW
      : 0;
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    const openedStat = fs.fstatSync(descriptor);
    temporaryIdentity = fileIdentity(openedStat);
    assertUploadDirectoryGuard(directory, directoryGuard);
    const namedStat = fs.lstatSync(temporary);
    if (
      !namedStat.isFile()
      || namedStat.isSymbolicLink()
      || !sameFileIdentity(openedStat, namedStat)
    ) {
      throw new UploadDirectoryChangedError();
    }
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    assertUploadDirectoryGuard(directory, directoryGuard);
    publishUploadTemporaryFile(
      temporary,
      destination,
      existing,
      process.platform,
      fs,
      directoryGuard,
    );
    published = true;
    if (process.platform !== "win32") {
      fs.fchmodSync(descriptor, existing ? existing.mode & 0o777 : 0o666 & ~process.umask());
    }
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (!published) {
      try {
        const current = fs.lstatSync(temporary);
        if (temporaryIdentity && matchesFileIdentity(current, temporaryIdentity)) {
          fs.unlinkSync(temporary);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];
  const guard = captureUploadDirectoryGuard(directory);
  const scan = readPortableNameMatches(directory, fileNames);
  assertUploadDirectoryGuard(directory, guard);

  if (!scan.complete) {
    return { conflicts: [...fileNames], nonReplaceable: [...fileNames] };
  }

  for (const fileName of fileNames) {
    const names = scan.matches.get(portableFileNameKey(fileName)) ?? [];
    if (names.length === 0) continue;
    conflicts.push(fileName);
    if (names.length !== 1 || names[0] !== fileName) {
      nonReplaceable.push(fileName);
      continue;
    }

    const destination = path.join(directory, names[0]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        nonReplaceable.push(fileName);
        continue;
      }
      throw error;
    }

    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}
