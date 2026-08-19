import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { sessionPathKey } from "./session-path";

const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;

interface SessionHeaderRecord extends Record<string, unknown> {
  type: "session";
  id: string;
  parentSession?: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface HeaderSnapshot {
  filePath: string;
  identity: FileIdentity;
  header: SessionHeaderRecord;
  headerPrefix: Buffer;
  bodyOffset: number;
  lineEnding: Buffer;
}

interface RewrittenChild {
  original: HeaderSnapshot;
  current: HeaderSnapshot;
}

class CommittedHeaderReplacementError extends Error {
  readonly cause: unknown;
  readonly committed: HeaderSnapshot;

  constructor(cause: unknown, committed: HeaderSnapshot) {
    super("Session header replacement committed before an I/O failure was reported");
    this.name = "CommittedHeaderReplacementError";
    this.cause = cause;
    this.committed = committed;
  }
}

export interface SessionRepositoryIO {
  close(fd: number): void;
  fstat(fd: number): Stats;
  fsync(fd: number): void;
  lstat(filePath: string): Stats;
  open(filePath: string, flags: string, mode?: number): number;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  readdir(directoryPath: string): string[];
  rename(sourcePath: string, destinationPath: string): void;
  unlink(filePath: string): void;
  write(fd: number, buffer: Buffer, offset: number, length: number): number;
}

export interface DeleteSessionTransactionOptions {
  sessionId: string;
  filePath: string;
  ownerId: string;
  resolveOwner(sessionId: string): string | null | Promise<string | null>;
  shutdownSession(sessionId: string): void | Promise<void>;
  invalidatePath(sessionId: string): void;
  /** Optional filesystem adapter for deterministic repository tests. */
  io?: Partial<SessionRepositoryIO>;
}

export interface DeleteSessionTransactionResult {
  reparentedSessionIds: string[];
}

export class SessionRepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRepositoryConflictError";
  }
}

export class SessionRepositoryOwnershipError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Cannot reparent session ${sessionId}: ownership does not match`);
    this.name = "SessionRepositoryOwnershipError";
    this.sessionId = sessionId;
  }
}

export class SessionRepositoryRollbackError extends Error {
  readonly cause: unknown;
  readonly rollbackErrors: unknown[];

  constructor(cause: unknown, rollbackErrors: unknown[]) {
    super("Session deletion failed and could not be fully rolled back");
    this.name = "SessionRepositoryRollbackError";
    this.cause = cause;
    this.rollbackErrors = rollbackErrors;
  }
}

const defaultIO: SessionRepositoryIO = {
  close: (fd) => closeSync(fd),
  fstat: (fd) => fstatSync(fd),
  fsync: (fd) => fsyncSync(fd),
  lstat: (filePath) => lstatSync(filePath),
  open: (filePath, flags, mode) => openSync(filePath, flags, mode),
  read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  readdir: (directoryPath) => readdirSync(directoryPath),
  rename: (sourcePath, destinationPath) => renameSync(sourcePath, destinationPath),
  unlink: (filePath) => unlinkSync(filePath),
  write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
};

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function identityFromStats(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameRenamedFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function assertRegularFile(filePath: string, stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new SessionRepositoryConflictError(`Session path is not a regular file: ${filePath}`);
  }
}

function parseHeader(buffer: Buffer): SessionHeaderRecord | null {
  const text = buffer.toString("utf8").trimEnd();
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (
      typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || (value as { type?: unknown }).type !== "session"
      || typeof (value as { id?: unknown }).id !== "string"
    ) {
      return null;
    }
    const parentSession = (value as { parentSession?: unknown }).parentSession;
    if (parentSession !== undefined && typeof parentSession !== "string") return null;
    return value as SessionHeaderRecord;
  } catch {
    return null;
  }
}

function readBoundedHeader(
  fd: number,
  filePath: string,
  io: SessionRepositoryIO,
): Pick<HeaderSnapshot, "header" | "headerPrefix" | "bodyOffset" | "lineEnding"> | null {
  const chunks: Buffer[] = [];
  let position = 0;
  let newlineOffset = -1;

  while (position < MAX_SESSION_HEADER_BYTES && newlineOffset === -1) {
    const buffer = Buffer.allocUnsafe(Math.min(4096, MAX_SESSION_HEADER_BYTES - position));
    const bytesRead = io.read(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const data = buffer.subarray(0, bytesRead);
    const relativeNewline = data.indexOf(0x0a);
    if (relativeNewline === -1) {
      chunks.push(Buffer.from(data));
      position += bytesRead;
    } else {
      chunks.push(Buffer.from(data.subarray(0, relativeNewline)));
      newlineOffset = position + relativeNewline;
      position = newlineOffset + 1;
    }
  }

  if (newlineOffset === -1 && position >= MAX_SESSION_HEADER_BYTES) {
    throw new SessionRepositoryConflictError(`Session header exceeds ${MAX_SESSION_HEADER_BYTES} bytes: ${filePath}`);
  }

  const rawLine = Buffer.concat(chunks);
  const header = parseHeader(rawLine);
  if (!header) return null;
  const hasCrlf = newlineOffset !== -1 && rawLine.at(-1) === 0x0d;
  const headerBytes = hasCrlf ? rawLine.subarray(0, rawLine.length - 1) : rawLine;
  const lineEnding = newlineOffset === -1
    ? Buffer.alloc(0)
    : Buffer.from(hasCrlf ? "\r\n" : "\n");

  return {
    header,
    headerPrefix: Buffer.concat([Buffer.from(headerBytes), lineEnding]),
    bodyOffset: newlineOffset === -1 ? rawLine.length : newlineOffset + 1,
    lineEnding,
  };
}

function snapshotHeader(filePath: string, io: SessionRepositoryIO): HeaderSnapshot | null {
  const pathStatsBefore = io.lstat(filePath);
  assertRegularFile(filePath, pathStatsBefore);
  const identity = identityFromStats(pathStatsBefore);
  const fd = io.open(filePath, "r");
  try {
    const fdIdentityBefore = identityFromStats(io.fstat(fd));
    if (!sameIdentity(identity, fdIdentityBefore)) {
      throw new SessionRepositoryConflictError(`Session changed while opening: ${filePath}`);
    }
    const headerData = readBoundedHeader(fd, filePath, io);
    const fdIdentityAfter = identityFromStats(io.fstat(fd));
    const pathIdentityAfter = identityFromStats(io.lstat(filePath));
    if (!sameIdentity(identity, fdIdentityAfter) || !sameIdentity(identity, pathIdentityAfter)) {
      throw new SessionRepositoryConflictError(`Session changed while reading its header: ${filePath}`);
    }
    return headerData ? { filePath, identity, ...headerData } : null;
  } finally {
    io.close(fd);
  }
}

function trySnapshotHeader(filePath: string, io: SessionRepositoryIO): HeaderSnapshot | null | undefined {
  try {
    return snapshotHeader(filePath, io);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function scanDirectChildren(
  directoryPath: string,
  targetPathKey: string,
  io: SessionRepositoryIO,
): HeaderSnapshot[] {
  const paths = io.readdir(directoryPath)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(directoryPath, name))
    .filter((filePath) => sessionPathKey(filePath) !== targetPathKey)
    .sort((left, right) => sessionPathKey(left).localeCompare(sessionPathKey(right)));
  const children: HeaderSnapshot[] = [];
  const seenPaths = new Set<string>();

  for (const filePath of paths) {
    const pathKey = sessionPathKey(filePath);
    if (seenPaths.has(pathKey)) {
      throw new SessionRepositoryConflictError(`Duplicate session path: ${filePath}`);
    }
    seenPaths.add(pathKey);
    const snapshot = trySnapshotHeader(filePath, io);
    if (!snapshot) continue;
    if (
      typeof snapshot.header.parentSession === "string"
      && sessionPathKey(snapshot.header.parentSession) === targetPathKey
    ) {
      children.push(snapshot);
    }
  }

  return children;
}

function assertSnapshotUnchanged(before: HeaderSnapshot, after: HeaderSnapshot): void {
  if (
    !sameIdentity(before.identity, after.identity)
    || !before.headerPrefix.equals(after.headerPrefix)
  ) {
    throw new SessionRepositoryConflictError(`Session changed during deletion: ${before.filePath}`);
  }
}

function writeAll(fd: number, buffer: Buffer, io: SessionRepositoryIO): void {
  let offset = 0;
  while (offset < buffer.length) {
    const bytesWritten = io.write(fd, buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) throw new Error("Failed to write session replacement file");
    offset += bytesWritten;
  }
}

function replacementPrefix(snapshot: HeaderSnapshot, parentSessionPath: string | undefined): Buffer {
  const header: Record<string, unknown> = { ...snapshot.header };
  if (parentSessionPath === undefined) delete header.parentSession;
  else header.parentSession = parentSessionPath;
  return Buffer.concat([Buffer.from(JSON.stringify(header), "utf8"), snapshot.lineEnding]);
}

function atomicReplaceHeader(
  expected: HeaderSnapshot,
  newHeaderPrefix: Buffer,
  io: SessionRepositoryIO,
): HeaderSnapshot {
  const current = snapshotHeader(expected.filePath, io);
  if (!current) throw new SessionRepositoryConflictError(`Invalid session header: ${expected.filePath}`);
  assertSnapshotUnchanged(expected, current);

  const directoryPath = dirname(expected.filePath);
  const tempPath = join(directoryPath, `.${basename(expected.filePath)}.rewrite-${randomUUID()}.tmp`);
  const sourceFd = io.open(expected.filePath, "r");
  let sourceOpen = true;
  let tempFd: number | undefined;
  let operationFailed = false;
  let renameAttempted = false;

  try {
    if (!sameIdentity(expected.identity, identityFromStats(io.fstat(sourceFd)))) {
      throw new SessionRepositoryConflictError(`Session changed before rewrite: ${expected.filePath}`);
    }
    tempFd = io.open(tempPath, "wx", expected.identity.mode & 0o777);
    writeAll(tempFd, newHeaderPrefix, io);

    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = expected.bodyOffset;
    while (true) {
      const bytesRead = io.read(sourceFd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      writeAll(tempFd, buffer.subarray(0, bytesRead), io);
      position += bytesRead;
    }

    if (!sameIdentity(expected.identity, identityFromStats(io.fstat(sourceFd)))) {
      throw new SessionRepositoryConflictError(`Session changed while copying: ${expected.filePath}`);
    }
    io.fsync(tempFd);
    const sourceIdentityAfterSync = identityFromStats(io.fstat(sourceFd));
    const pathIdentityAfterSync = identityFromStats(io.lstat(expected.filePath));
    if (
      !sameIdentity(expected.identity, sourceIdentityAfterSync)
      || !sameIdentity(expected.identity, pathIdentityAfterSync)
    ) {
      throw new SessionRepositoryConflictError(`Session changed before replacement: ${expected.filePath}`);
    }
    io.close(tempFd);
    tempFd = undefined;
    io.close(sourceFd);
    sourceOpen = false;
    renameAttempted = true;
    io.rename(tempPath, expected.filePath);

    const replaced = snapshotHeader(expected.filePath, io);
    if (!replaced || !replaced.headerPrefix.equals(newHeaderPrefix)) {
      throw new SessionRepositoryConflictError(`Session replacement could not be verified: ${expected.filePath}`);
    }
    return replaced;
  } catch (error) {
    operationFailed = true;
    if (renameAttempted) {
      try {
        const committed = snapshotHeader(expected.filePath, io);
        if (
          committed
          && committed.headerPrefix.equals(newHeaderPrefix)
          && !sameIdentity(expected.identity, committed.identity)
        ) {
          throw new CommittedHeaderReplacementError(error, committed);
        }
      } catch (verificationError) {
        if (verificationError instanceof CommittedHeaderReplacementError) throw verificationError;
      }
    }
    throw error;
  } finally {
    if (tempFd !== undefined) {
      try { io.close(tempFd); } catch { /* retain the primary error */ }
    }
    if (sourceOpen) {
      try { io.close(sourceFd); } catch { /* retain the primary error */ }
    }
    try {
      io.unlink(tempPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && !operationFailed) throw error;
    }
  }
}

function uniqueTombstonePath(filePath: string, io: SessionRepositoryIO): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(dirname(filePath), `.${basename(filePath)}.delete-${randomUUID()}.tombstone`);
    try {
      io.lstat(candidate);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error("Could not reserve a session tombstone path");
}

function assertNoUnexpectedChildren(
  directoryPath: string,
  targetPathKey: string,
  expectedChildren: Map<string, HeaderSnapshot>,
  io: SessionRepositoryIO,
): HeaderSnapshot[] {
  const currentChildren = scanDirectChildren(directoryPath, targetPathKey, io);
  const currentKeys = new Set(currentChildren.map((child) => sessionPathKey(child.filePath)));
  for (const [pathKey, expected] of expectedChildren) {
    if (!currentKeys.has(pathKey)) continue;
    const current = currentChildren.find((child) => sessionPathKey(child.filePath) === pathKey)!;
    assertSnapshotUnchanged(expected, current);
  }
  for (const child of currentChildren) {
    if (!expectedChildren.has(sessionPathKey(child.filePath))) {
      throw new SessionRepositoryConflictError(`A direct child appeared during deletion: ${child.filePath}`);
    }
  }
  return currentChildren;
}

function restoreTarget(
  tombstonePath: string,
  targetPath: string,
  targetIdentity: FileIdentity,
  io: SessionRepositoryIO,
): void {
  const tombstoneIdentity = identityFromStats(io.lstat(tombstonePath));
  if (!sameRenamedFile(targetIdentity, tombstoneIdentity)) {
    throw new SessionRepositoryConflictError("Session tombstone changed before rollback");
  }
  try {
    io.lstat(targetPath);
    throw new SessionRepositoryConflictError("Session path was occupied before rollback");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  io.rename(tombstonePath, targetPath);
  const restoredIdentity = identityFromStats(io.lstat(targetPath));
  if (!sameRenamedFile(targetIdentity, restoredIdentity)) {
    throw new SessionRepositoryConflictError("Restored session could not be verified");
  }
}

function assertPathAbsent(filePath: string, io: SessionRepositoryIO): void {
  try {
    io.lstat(filePath);
    throw new SessionRepositoryConflictError(`Session path was replaced during deletion: ${filePath}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

/**
 * Deletes one session file and reparents its direct children as a single
 * recoverable filesystem transaction. Callers must serialize deletion of the
 * same session; unrelated concurrent writers are detected optimistically.
 */
export async function deleteSessionTransaction(
  options: DeleteSessionTransactionOptions,
): Promise<DeleteSessionTransactionResult> {
  const io: SessionRepositoryIO = { ...defaultIO, ...options.io };
  const targetPathKey = sessionPathKey(options.filePath);
  const directoryPath = dirname(options.filePath);
  const targetBefore = snapshotHeader(options.filePath, io);
  if (!targetBefore || targetBefore.header.id !== options.sessionId) {
    throw new SessionRepositoryConflictError("Session file does not match the requested session");
  }
  if (
    typeof targetBefore.header.parentSession === "string"
    && sessionPathKey(targetBefore.header.parentSession) === targetPathKey
  ) {
    throw new SessionRepositoryConflictError("Session cannot be its own parent");
  }

  const childrenBefore = scanDirectChildren(directoryPath, targetPathKey, io);
  const childIds = new Set<string>();
  for (const child of childrenBefore) {
    if (child.header.id === options.sessionId || childIds.has(child.header.id)) {
      throw new SessionRepositoryConflictError(`Duplicate direct child session id: ${child.header.id}`);
    }
    childIds.add(child.header.id);
    if (await options.resolveOwner(child.header.id) !== options.ownerId) {
      throw new SessionRepositoryOwnershipError(child.header.id);
    }
  }

  await options.shutdownSession(options.sessionId);
  for (const child of childrenBefore) await options.shutdownSession(child.header.id);

  const targetAfter = trySnapshotHeader(options.filePath, io);
  if (targetAfter === null) {
    throw new SessionRepositoryConflictError("Session header became invalid during shutdown");
  }
  if (targetAfter) assertSnapshotUnchanged(targetBefore, targetAfter);

  const expectedChildren = new Map(
    childrenBefore.map((child) => [sessionPathKey(child.filePath), child]),
  );
  const childrenAfter = assertNoUnexpectedChildren(
    directoryPath,
    targetPathKey,
    expectedChildren,
    io,
  );
  const remainingKeys = new Set(childrenAfter.map((child) => sessionPathKey(child.filePath)));
  const disappearedChildren = childrenBefore.filter(
    (child) => !remainingKeys.has(sessionPathKey(child.filePath)),
  );
  for (const child of childrenAfter) {
    if (await options.resolveOwner(child.header.id) !== options.ownerId) {
      throw new SessionRepositoryOwnershipError(child.header.id);
    }
  }

  let tombstonePath: string | undefined;
  const rewritten: RewrittenChild[] = [];
  try {
    if (targetAfter) {
      const currentTarget = snapshotHeader(options.filePath, io);
      if (!currentTarget) throw new SessionRepositoryConflictError("Session header became invalid before deletion");
      assertSnapshotUnchanged(targetAfter, currentTarget);
      const candidateTombstonePath = uniqueTombstonePath(options.filePath, io);
      try {
        io.rename(options.filePath, candidateTombstonePath);
        tombstonePath = candidateTombstonePath;
      } catch (error) {
        try {
          const hiddenIdentity = identityFromStats(io.lstat(candidateTombstonePath));
          let targetMissing = false;
          try { io.lstat(options.filePath); } catch (targetError) {
            targetMissing = errorCode(targetError) === "ENOENT";
          }
          if (targetMissing && sameRenamedFile(targetAfter.identity, hiddenIdentity)) {
            tombstonePath = candidateTombstonePath;
          }
        } catch { /* the rename did not commit */ }
        throw error;
      }
      const hiddenIdentity = identityFromStats(io.lstat(candidateTombstonePath));
      if (!sameRenamedFile(targetAfter.identity, hiddenIdentity)) {
        throw new SessionRepositoryConflictError("Session tombstone could not be verified");
      }
    }
    assertPathAbsent(options.filePath, io);

    assertNoUnexpectedChildren(directoryPath, targetPathKey, new Map(
      childrenAfter.map((child) => [sessionPathKey(child.filePath), child]),
    ), io);

    for (const child of childrenAfter) {
      const newPrefix = replacementPrefix(child, targetBefore.header.parentSession);
      try {
        const current = atomicReplaceHeader(child, newPrefix, io);
        rewritten.push({ original: child, current });
      } catch (error) {
        if (error instanceof CommittedHeaderReplacementError) {
          rewritten.push({ original: child, current: error.committed });
          throw error.cause;
        }
        throw error;
      }
    }

    const lingeringChildren = scanDirectChildren(directoryPath, targetPathKey, io);
    if (lingeringChildren.length > 0) {
      throw new SessionRepositoryConflictError("A direct child appeared before deletion committed");
    }
    assertPathAbsent(options.filePath, io);

    const affectedIds = [
      options.sessionId,
      ...childrenAfter.map((child) => child.header.id),
      ...disappearedChildren.map((child) => child.header.id),
    ];
    for (const sessionId of affectedIds) options.invalidatePath(sessionId);
    if (tombstonePath) {
      const activeTombstonePath = tombstonePath;
      try {
        io.unlink(activeTombstonePath);
        tombstonePath = undefined;
      } catch (error) {
        try {
          io.lstat(activeTombstonePath);
          throw error;
        } catch (verificationError) {
          if (errorCode(verificationError) !== "ENOENT") throw error;
          tombstonePath = undefined;
        }
      }
    }
    return { reparentedSessionIds: childrenAfter.map((child) => child.header.id) };
  } catch (cause) {
    const rollbackErrors: unknown[] = [];
    for (const child of [...rewritten].reverse()) {
      try {
        atomicReplaceHeader(child.current, child.original.headerPrefix, io);
      } catch (error) {
        if (!(error instanceof CommittedHeaderReplacementError)) rollbackErrors.push(error);
      }
    }
    if (tombstonePath) {
      try {
        restoreTarget(tombstonePath, options.filePath, targetBefore.identity, io);
        tombstonePath = undefined;
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new SessionRepositoryRollbackError(cause, rollbackErrors);
    }
    throw cause;
  }
}
