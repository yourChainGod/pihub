import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { extract as extractTar, list as listTar, type ReadEntry } from "tar";
import {
  canonicalizeReleaseJson,
  isReleaseVersion,
  type ReleaseArchitecture,
  type ReleasePlatform,
} from "./release-manifest";
import { createServerReleaseTrust, SERVER_RELEASE_MANIFEST_URL } from "./server-release";
import {
  UpdateEngine,
  UpdateLockBusyError,
  type ArchiveEntry,
  type ArchiveEntryKind,
  type ExtractionPolicy,
  type HealthCheckPhase,
  type InstalledVersion,
  type RecoveryResult,
  type UpdateExtractor,
  type UpdateHealthCheck,
  type UpdateLock,
  type UpdateResult,
  type UpdateStagingArea,
  type UpdateStorage,
  type UpdateWriteHandle,
  type ValidatedArchive,
} from "./update-engine";

const CURRENT_POINTER_SCHEMA_VERSION = 1 as const;
const STAGING_ID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const UPDATE_LOCK_STALE_MS = 2 * 60 * 1000;
const UPDATE_LOCK_REFRESH_MS = 30 * 1000;
const TAR_MAX_DECOMPRESSION_RATIO = 100;
const TAR_MAX_ENTRIES = 20_000;

interface CurrentPointer {
  schemaVersion: typeof CURRENT_POINTER_SCHEMA_VERSION;
  version: string | null;
}

export interface ServerUpdateDataRootOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface SupervisorReleaseHealthCheck {
  check(input: {
    phase: HealthCheckPhase;
    version: string;
    packageRoot: string;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<boolean>;
}

export interface ProductionServerUpdateRuntimeOptions {
  bootstrapPackageRoot: string;
  bootstrapVersion: string;
  platform: ReleasePlatform;
  arch: ReleaseArchitecture;
  health: SupervisorReleaseHealthCheck;
  dataRoot?: string;
  fetchImpl?: typeof globalThis.fetch;
}

type PathOperations = Pick<typeof path, "isAbsolute" | "join" | "resolve">;

function safeAbsolutePath(
  value: string,
  description: string,
  pathOperations: PathOperations = path,
): string {
  if (!pathOperations.isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(`${description} must be an absolute path without control characters`);
  }
  return pathOperations.resolve(value);
}

export function getServerUpdateDataRoot(options: ServerUpdateDataRootOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathOperations = platform === "win32" ? path.win32 : path.posix;
  let root: string;
  if (platform === "darwin") {
    const home = safeAbsolutePath(options.home ?? homedir(), "Home directory", pathOperations);
    root = pathOperations.join(home, "Library", "Application Support", "PiHub", "Server");
  } else if (platform === "linux") {
    const home = safeAbsolutePath(options.home ?? homedir(), "Home directory", pathOperations);
    const dataHome = env.XDG_DATA_HOME?.trim()
      ? safeAbsolutePath(env.XDG_DATA_HOME.trim(), "XDG_DATA_HOME", pathOperations)
      : pathOperations.join(home, ".local", "share");
    root = pathOperations.join(dataHome, "pihub", "server");
  } else if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) throw new Error("LOCALAPPDATA is required for PiHub Server updates");
    root = pathOperations.join(
      safeAbsolutePath(localAppData, "LOCALAPPDATA", pathOperations),
      "PiHub",
      "Server",
    );
  } else {
    throw new Error(`Unsupported update platform: ${platform}`);
  }
  return safeAbsolutePath(root, "PiHub Server update root", pathOperations);
}

function assertVersion(value: string): string {
  if (!isReleaseVersion(value)) throw new Error("Invalid release version");
  return value;
}

function assertStagingId(value: string): string {
  if (!STAGING_ID_PATTERN.test(value)) throw new Error("Invalid update staging identifier");
  return value;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Refusing to use a non-directory or symbolic link for update state");
  }
  await chmod(directory, 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (process.platform !== "win32" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readRegularFileBounded(file: string, maxBytes: number): Promise<string | null> {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new Error("Update state file is invalid");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(file, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error("Update state file changed while it was being opened");
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(contents, "utf8") > maxBytes) throw new Error("Update state file is too large");
    return contents;
  } finally {
    await handle.close();
  }
}

async function atomicWritePrivateFile(file: string, contents: string): Promise<void> {
  const directory = path.dirname(file);
  await ensurePrivateDirectory(directory);
  try {
    const existing = await lstat(file);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Refusing to replace a non-regular update state file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function unlinkRegularFile(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Refusing to remove invalid update state");
    await unlink(file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

function parseCurrentPointer(raw: string): CurrentPointer {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Current release pointer is invalid");
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !("schemaVersion" in value)
    || !("version" in value)
    || value.schemaVersion !== CURRENT_POINTER_SCHEMA_VERSION
    || (value.version !== null && !isReleaseVersion(value.version))
    || canonicalizeReleaseJson(value) !== raw
  ) {
    throw new Error("Current release pointer is invalid");
  }
  return value as CurrentPointer;
}

class ExclusiveArchiveWriteHandle implements UpdateWriteHandle {
  private closed = false;

  constructor(private readonly handle: Awaited<ReturnType<typeof open>>) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("Archive handle is closed");
    let offset = 0;
    while (offset < chunk.byteLength) {
      const result = await this.handle.write(chunk, offset, chunk.byteLength - offset, null);
      if (result.bytesWritten <= 0) throw new Error("Archive write made no progress");
      offset += result.bytesWritten;
    }
  }

  async sync(): Promise<void> {
    if (this.closed) throw new Error("Archive handle is closed");
    await this.handle.sync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

function tarEntryKind(entry: ReadEntry): ArchiveEntryKind {
  if (entry.type === "File" || entry.type === "OldFile" || entry.type === "ContiguousFile") return "file";
  if (entry.type === "Directory") return "directory";
  if (entry.type === "SymbolicLink") return "symlink";
  if (entry.type === "Link") return "hardlink";
  if (entry.type === "BlockDevice") return "block-device";
  if (entry.type === "CharacterDevice") return "character-device";
  if (entry.type === "FIFO") return "fifo";
  if (entry.type === "SparseFile") return "sparse";
  return "unknown";
}

function archiveEntryFromTar(entry: ReadEntry): ArchiveEntry {
  return {
    path: entry.path,
    kind: tarEntryKind(entry),
    size: entry.size,
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
  };
}

export class TarUpdateExtractor implements UpdateExtractor {
  async inspect(archiveReference: string): Promise<ArchiveEntry[]> {
    const archive = safeAbsolutePath(archiveReference, "Update archive");
    const info = await lstat(archive);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Update archive must be a regular file");
    const entries: ArchiveEntry[] = [];
    await listTar({
      file: archive,
      strict: true,
      maxDecompressionRatio: TAR_MAX_DECOMPRESSION_RATIO,
      onReadEntry: (entry) => {
        if (entries.length >= TAR_MAX_ENTRIES) {
          throw new Error("Release archive contains too many entries");
        }
        entries.push(archiveEntryFromTar(entry));
      },
    });
    return entries;
  }

  async extract(
    archiveReference: string,
    candidateReference: string,
    policy: ExtractionPolicy,
  ): Promise<void> {
    const archive = safeAbsolutePath(archiveReference, "Update archive");
    const candidate = safeAbsolutePath(candidateReference, "Update candidate");
    const inspected = await this.inspect(archive);
    const accepted = new Map<string, ArchiveEntry>();
    for (const entry of inspected) {
      if (entry.kind !== "file" && entry.kind !== "directory") {
        throw new Error("Release archive contains a link or special entry");
      }
      if (accepted.has(entry.path)) throw new Error("Release archive contains duplicate paths");
      accepted.set(entry.path, entry);
    }
    await ensurePrivateDirectory(candidate);
    const extracted = new Set<string>();
    await extractTar({
      file: archive,
      cwd: candidate,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      unlink: false,
      keep: true,
      noMtime: true,
      chmod: true,
      processUmask: 0o022,
      maxDepth: 32,
      maxDecompressionRatio: TAR_MAX_DECOMPRESSION_RATIO,
      filter: (entryPath, rawEntry) => {
        const entry = rawEntry as ReadEntry;
        const actual = archiveEntryFromTar(entry);
        const expected = accepted.get(entryPath);
        if (
          !expected
          || extracted.has(entryPath)
          || actual.kind !== expected.kind
          || actual.size !== expected.size
          || (actual.kind !== "file" && actual.kind !== "directory")
        ) {
          throw new Error("Release archive changed between inspection and extraction");
        }
        extracted.add(entryPath);
        entry.mode = actual.kind === "directory" ? policy.directoryMode : policy.fileMode;
        entry.uid = undefined;
        entry.gid = undefined;
        return true;
      },
    });
    if (extracted.size !== accepted.size) throw new Error("Release archive was not fully extracted");
  }
}

export interface FileUpdateStorageOptions {
  dataRoot: string;
  bootstrapPackageRoot: string;
  bootstrapVersion: string;
}

export class FileUpdateStorage implements UpdateStorage {
  readonly dataRoot: string;
  readonly bootstrapPackageRoot: string;
  readonly bootstrapVersion: string;
  private readonly versionsDirectory: string;
  private readonly stagingDirectory: string;
  private readonly stateDirectory: string;
  private readonly currentFile: string;
  private readonly journalFile: string;
  private readonly versionStateFile: string;
  private readonly lockTarget: string;

  constructor(options: FileUpdateStorageOptions) {
    this.dataRoot = safeAbsolutePath(options.dataRoot, "Update data root");
    this.bootstrapPackageRoot = safeAbsolutePath(options.bootstrapPackageRoot, "Bootstrap package root");
    this.bootstrapVersion = assertVersion(options.bootstrapVersion);
    this.versionsDirectory = path.join(this.dataRoot, "versions");
    this.stagingDirectory = path.join(this.dataRoot, "staging");
    this.stateDirectory = path.join(this.dataRoot, "state");
    this.currentFile = path.join(this.stateDirectory, "current.json");
    this.journalFile = path.join(this.stateDirectory, "journal.json");
    this.versionStateFile = path.join(this.stateDirectory, "versions.json");
    this.lockTarget = path.join(this.stateDirectory, "update");
  }

  async initialize(): Promise<void> {
    const bootstrapInfo = await lstat(this.bootstrapPackageRoot);
    if (!bootstrapInfo.isDirectory() || bootstrapInfo.isSymbolicLink()) {
      throw new Error("Bootstrap package root is invalid");
    }
    await ensurePrivateDirectory(this.dataRoot);
    await ensurePrivateDirectory(this.versionsDirectory);
    await ensurePrivateDirectory(this.stagingDirectory);
    await ensurePrivateDirectory(this.stateDirectory);
    try {
      const lockInfo = await lstat(this.lockTarget);
      if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) throw new Error("Update lock target is invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      const handle = await open(this.lockTarget, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.sync();
      await handle.close();
    }
    await chmod(this.lockTarget, 0o600);
    const current = await readRegularFileBounded(this.currentFile, 16 * 1024);
    if (current === null) {
      await this.switchCurrentAtomically(this.bootstrapVersion);
    } else {
      const pointer = parseCurrentPointer(current);
      if (pointer.version === null || !(await this.versionExists(pointer.version))) {
        throw new Error("Current release pointer references an unavailable version");
      }
    }
  }

  async acquireLock(): Promise<UpdateLock> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.lockTarget, {
        realpath: false,
        retries: 0,
        stale: UPDATE_LOCK_STALE_MS,
        update: UPDATE_LOCK_REFRESH_MS,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ELOCKED") throw new UpdateLockBusyError();
      throw error;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await release?.();
      },
    };
  }

  readJournal(maxBytes: number): Promise<string | null> {
    return readRegularFileBounded(this.journalFile, maxBytes);
  }

  writeJournalAtomic(contents: string): Promise<void> {
    return atomicWritePrivateFile(this.journalFile, contents);
  }

  clearJournal(): Promise<void> {
    return unlinkRegularFile(this.journalFile);
  }

  async createPrivateStaging(id: string): Promise<UpdateStagingArea> {
    const safeId = assertStagingId(id);
    const root = path.join(this.stagingDirectory, safeId);
    await mkdir(root, { mode: 0o700 });
    await ensurePrivateDirectory(root);
    const candidate = path.join(root, "candidate");
    await mkdir(candidate, { mode: 0o700 });
    await ensurePrivateDirectory(candidate);
    return {
      id: safeId,
      archiveReference: path.join(root, "release.tar.gz"),
      candidateReference: candidate,
    };
  }

  async openArchiveExclusive(staging: UpdateStagingArea): Promise<UpdateWriteHandle> {
    const expected = this.stagingArea(staging.id);
    if (staging.archiveReference !== expected.archiveReference || staging.candidateReference !== expected.candidateReference) {
      throw new Error("Invalid staging references");
    }
    const handle = await open(
      expected.archiveReference,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    return new ExclusiveArchiveWriteHandle(handle);
  }

  async removeStaging(id: string): Promise<void> {
    const root = this.stagingArea(id).root;
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid staging directory");
      await rm(root, { recursive: true, force: false, maxRetries: 2 });
      await syncDirectory(this.stagingDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }

  async publishCandidate(staging: UpdateStagingArea, version: string): Promise<void> {
    const safeVersion = assertVersion(version);
    const expected = this.stagingArea(staging.id);
    if (staging.candidateReference !== expected.candidateReference) throw new Error("Invalid candidate reference");
    await this.assertRunnablePackage(expected.candidateReference, safeVersion);
    const destination = this.versionDirectory(safeVersion);
    try {
      await lstat(destination);
      throw new Error("Release version already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    await rename(expected.candidateReference, destination);
    await chmod(destination, 0o700);
    await syncDirectory(this.versionsDirectory);
  }

  async versionExists(version: string): Promise<boolean> {
    const safeVersion = assertVersion(version);
    if (safeVersion === this.bootstrapVersion) return true;
    try {
      const info = await lstat(this.versionDirectory(safeVersion));
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Installed release path is invalid");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    }
  }

  async currentVersion(): Promise<string | null> {
    const raw = await readRegularFileBounded(this.currentFile, 16 * 1024);
    if (raw === null) return null;
    return parseCurrentPointer(raw).version;
  }

  async switchCurrentAtomically(version: string | null): Promise<void> {
    if (version !== null) {
      assertVersion(version);
      if (!(await this.versionExists(version))) throw new Error("Cannot activate an unavailable release version");
    }
    await atomicWritePrivateFile(this.currentFile, canonicalizeReleaseJson({
      schemaVersion: CURRENT_POINTER_SCHEMA_VERSION,
      version,
    }));
  }

  async auditExtractedTree(
    staging: UpdateStagingArea,
    archive: ValidatedArchive,
    policy: ExtractionPolicy,
  ): Promise<void> {
    const expectedStaging = this.stagingArea(staging.id);
    if (staging.candidateReference !== expectedStaging.candidateReference) throw new Error("Invalid candidate reference");
    const expectedFiles = new Map<string, number>();
    const expectedDirectories = new Set<string>();
    for (const entry of archive.entries) {
      if (entry.kind === "file") expectedFiles.set(entry.path, entry.size);
      else expectedDirectories.add(entry.path);
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        expectedDirectories.add(segments.slice(0, index).join("/"));
      }
    }

    let fileCount = 0;
    let totalBytes = 0;
    const visit = async (directory: string, relative: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new Error("Extracted release contains a symbolic link");
        if (info.isDirectory()) {
          if (!expectedDirectories.has(relativePath)) throw new Error("Extracted release contains an unexpected directory");
          await chmod(absolute, policy.directoryMode);
          await visit(absolute, relativePath);
        } else if (info.isFile()) {
          const expectedSize = expectedFiles.get(relativePath);
          if (expectedSize === undefined || info.size !== expectedSize || info.nlink !== 1) {
            throw new Error("Extracted release file tree does not match the signed archive");
          }
          await chmod(absolute, policy.fileMode);
          fileCount += 1;
          totalBytes += info.size;
        } else {
          throw new Error("Extracted release contains a special file");
        }
      }
    };
    await visit(expectedStaging.candidateReference, "");
    if (fileCount !== archive.fileCount || totalBytes !== archive.totalUncompressedBytes) {
      throw new Error("Extracted release file totals do not match the signed archive");
    }
    await this.assertRunnablePackage(expectedStaging.candidateReference);
  }

  readVersionState(maxBytes: number): Promise<string | null> {
    return readRegularFileBounded(this.versionStateFile, maxBytes);
  }

  writeVersionStateAtomic(contents: string): Promise<void> {
    return atomicWritePrivateFile(this.versionStateFile, contents);
  }

  async listInstalledVersions(): Promise<InstalledVersion[]> {
    const installed = new Map<string, InstalledVersion>();
    const bootstrapInfo = await stat(this.bootstrapPackageRoot);
    installed.set(this.bootstrapVersion, {
      version: this.bootstrapVersion,
      installedAt: Math.max(0, Math.trunc(bootstrapInfo.mtimeMs)),
    });
    for (const entry of await readdir(this.versionsDirectory, { withFileTypes: true })) {
      if (!isReleaseVersion(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("Installed release directory is invalid");
      }
      const info = await lstat(this.versionDirectory(entry.name));
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Installed release directory is invalid");
      installed.set(entry.name, {
        version: entry.name,
        installedAt: Math.max(0, Math.trunc(info.mtimeMs)),
      });
    }
    return [...installed.values()];
  }

  async removeVersion(version: string): Promise<void> {
    const safeVersion = assertVersion(version);
    if (safeVersion === this.bootstrapVersion) throw new Error("The bootstrap release cannot be removed");
    if (await this.currentVersion() === safeVersion) throw new Error("The active release cannot be removed");
    const directory = this.versionDirectory(safeVersion);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Installed release directory is invalid");
      await rm(directory, { recursive: true, force: false, maxRetries: 2 });
      await syncDirectory(this.versionsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }

  async resolveVersionRoot(version: string): Promise<string> {
    const safeVersion = assertVersion(version);
    const installed = this.versionDirectory(safeVersion);
    try {
      const info = await lstat(installed);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Installed release directory is invalid");
      return await realpath(installed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    if (safeVersion !== this.bootstrapVersion) throw new Error("Release version is not installed");
    return await realpath(this.bootstrapPackageRoot);
  }

  private versionDirectory(version: string): string {
    return path.join(this.versionsDirectory, assertVersion(version));
  }

  private stagingArea(id: string): UpdateStagingArea & { root: string } {
    const safeId = assertStagingId(id);
    const root = path.join(this.stagingDirectory, safeId);
    return {
      id: safeId,
      root,
      archiveReference: path.join(root, "release.tar.gz"),
      candidateReference: path.join(root, "candidate"),
    };
  }

  private async assertRunnablePackage(packageRoot: string, expectedVersion?: string): Promise<void> {
    const raw = await readRegularFileBounded(path.join(packageRoot, "package.json"), MAX_PACKAGE_JSON_BYTES);
    if (raw === null) throw new Error("Release package metadata is missing");
    let metadata: unknown;
    try {
      metadata = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("Release package metadata is invalid");
    }
    if (
      typeof metadata !== "object"
      || metadata === null
      || Array.isArray(metadata)
      || (metadata as { name?: unknown }).name !== "@pihub/server"
      || !isReleaseVersion((metadata as { version?: unknown }).version)
      || (expectedVersion !== undefined && (metadata as { version: string }).version !== expectedVersion)
    ) {
      throw new Error("Release package identity does not match the signed release");
    }
    const requiredFiles = [
      ".next/BUILD_ID",
      "node_modules/next/package.json",
      "node_modules/next/dist/bin/next",
    ];
    for (const relative of requiredFiles) {
      const info = await lstat(path.join(packageRoot, ...relative.split("/")));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Release package is not a complete runnable bundle");
    }
  }
}

export class ProductionServerUpdateRuntime {
  readonly storage: FileUpdateStorage;
  readonly extractor: TarUpdateExtractor;
  readonly engine: UpdateEngine;

  constructor(private readonly options: ProductionServerUpdateRuntimeOptions) {
    this.storage = new FileUpdateStorage({
      dataRoot: options.dataRoot ?? getServerUpdateDataRoot({ platform: options.platform }),
      bootstrapPackageRoot: options.bootstrapPackageRoot,
      bootstrapVersion: options.bootstrapVersion,
    });
    this.extractor = new TarUpdateExtractor();
    const health: UpdateHealthCheck = {
      check: async (input) => options.health.check({
        ...input,
        packageRoot: await this.storage.resolveVersionRoot(input.version),
      }),
    };
    this.engine = new UpdateEngine({
      trust: createServerReleaseTrust(),
      platform: options.platform,
      arch: options.arch,
      storage: this.storage,
      extractor: this.extractor,
      health,
      network: {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        timeoutMs: 30_000,
        maxRedirects: 3,
        allowToken: false,
      },
    });
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  recover(): Promise<RecoveryResult> {
    return this.engine.recover();
  }

  apply(): Promise<UpdateResult> {
    return this.engine.applyManifestUrl(SERVER_RELEASE_MANIFEST_URL);
  }

  async currentVersion(): Promise<string> {
    const version = await this.storage.currentVersion();
    if (version === null) throw new Error("No active PiHub Server release is configured");
    return version;
  }
}
