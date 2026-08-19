import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  canonicalizeReleaseJson,
  fetchAndVerifyReleaseManifest,
  fetchPinnedGithubResource,
  isReleaseVersion,
  parseAndVerifyReleaseManifest,
  type GithubFetchOptions,
  type ReleaseArchitecture,
  type ReleaseAsset,
  ReleaseManifestError,
  type ReleasePlatform,
  type ReleaseTrust,
  selectReleaseAsset,
  type VerifiedReleaseManifest,
  verifyReleaseAssetSignature,
} from "./release-manifest";

const UPDATE_JOURNAL_SCHEMA_VERSION = 1 as const;
const VERSION_STATE_SCHEMA_VERSION = 1 as const;
const MAX_JOURNAL_BYTES = 16 * 1024;
const MAX_VERSION_STATE_BYTES = 64 * 1024;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETAINED_VERSIONS = 3;
const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxEntries: 20_000,
  maxSingleFileBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxPathBytes: 1_024,
  maxPathDepth: 32,
});
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;
const WINDOWS_INVALID_PATH_CHARACTERS = /[<>:"|?*\u0000-\u001f\u007f]/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const RANDOM_ID_PATTERN = /^[a-f0-9]{32}$/;
const JOURNAL_PHASES = new Set<UpdateJournalPhase>([
  "downloading",
  "inspecting",
  "extracting",
  "publishing",
  "candidate-health",
  "switch-pending",
  "current-health",
  "committing",
  "rollback-pending",
  "cleanup-pending",
]);

export type UpdateEngineErrorCode =
  | "invalid_configuration"
  | "invalid_manifest"
  | "no_compatible_asset"
  | "downgrade_blocked"
  | "version_conflict"
  | "concurrent_update"
  | "journal_corrupt"
  | "download_failed"
  | "integrity_failed"
  | "unsafe_archive"
  | "extraction_failed"
  | "health_failed"
  | "health_timeout"
  | "switch_failed"
  | "storage_failure"
  | "rollback_failed"
  | "recovery_failed";

export class UpdateEngineError extends Error {
  readonly code: UpdateEngineErrorCode;

  constructor(code: UpdateEngineErrorCode, message: string) {
    super(message);
    this.name = "UpdateEngineError";
    this.code = code;
  }
}

/** Storage adapters use this exact error to distinguish lock contention. */
export class UpdateLockBusyError extends Error {
  constructor() {
    super("Update lock is already held");
    this.name = "UpdateLockBusyError";
  }
}

function updateFail(code: UpdateEngineErrorCode, message: string): never {
  throw new UpdateEngineError(code, message);
}

export type ArchiveEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "block-device"
  | "character-device"
  | "fifo"
  | "sparse"
  | "unknown";

export interface ArchiveEntry {
  path: string;
  kind: ArchiveEntryKind;
  size: number;
  compressedSize?: number;
  mode?: number;
}

export interface ValidatedArchiveEntry {
  path: string;
  kind: "file" | "directory";
  size: number;
}

export interface ValidatedArchive {
  entries: readonly ValidatedArchiveEntry[];
  fileCount: number;
  totalUncompressedBytes: number;
}

export interface ArchiveLimits {
  maxEntries: number;
  maxSingleFileBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
  maxPathBytes: number;
  maxPathDepth: number;
  requiredRoot?: string;
}

export interface ExtractionPolicy {
  /** Extractor must ignore archived ownership and special permission bits. */
  ignoreOwnership: true;
  fileMode: 0o644;
  directoryMode: 0o755;
  allowLinks: false;
  allowSpecialFiles: false;
}

const EXTRACTION_POLICY: ExtractionPolicy = Object.freeze({
  ignoreOwnership: true,
  fileMode: 0o644,
  directoryMode: 0o755,
  allowLinks: false,
  allowSpecialFiles: false,
});

export interface UpdateExtractor {
  /** Must inspect the same effective entry names that extract() will consume. */
  inspect(archiveReference: string): Promise<Iterable<ArchiveEntry> | AsyncIterable<ArchiveEntry>>;
  /** Must use a proven archive library; system shell/tar invocation is not allowed. */
  extract(
    archiveReference: string,
    candidateReference: string,
    policy: ExtractionPolicy,
  ): Promise<void>;
}

export interface UpdateWriteHandle {
  write(chunk: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateLock {
  release(): Promise<void>;
}

export interface UpdateStagingArea {
  readonly id: string;
  readonly archiveReference: string;
  readonly candidateReference: string;
}

export interface InstalledVersion {
  version: string;
  installedAt: number;
}

/**
 * Platform adapters own every filesystem and current-pointer operation.
 * createPrivateStaging must use a new 0700-equivalent directory, openArchiveExclusive
 * must use O_EXCL/CREATE_NEW with 0600-equivalent permissions, and pointer/state
 * writes must be durable atomic replacements on macOS, Linux and Windows.
 */
export interface UpdateStorage {
  acquireLock(): Promise<UpdateLock>;
  readJournal(maxBytes: number): Promise<string | null>;
  writeJournalAtomic(contents: string): Promise<void>;
  clearJournal(): Promise<void>;
  createPrivateStaging(id: string): Promise<UpdateStagingArea>;
  openArchiveExclusive(staging: UpdateStagingArea): Promise<UpdateWriteHandle>;
  removeStaging(id: string): Promise<void>;
  publishCandidate(staging: UpdateStagingArea, version: string): Promise<void>;
  versionExists(version: string): Promise<boolean>;
  currentVersion(): Promise<string | null>;
  switchCurrentAtomically(version: string | null): Promise<void>;
  auditExtractedTree(
    staging: UpdateStagingArea,
    archive: ValidatedArchive,
    policy: ExtractionPolicy,
  ): Promise<void>;
  readVersionState(maxBytes: number): Promise<string | null>;
  writeVersionStateAtomic(contents: string): Promise<void>;
  listInstalledVersions(): Promise<InstalledVersion[]>;
  removeVersion(version: string): Promise<void>;
}

export type HealthCheckPhase = "candidate" | "current" | "rollback";

export interface UpdateHealthCheck {
  /** Must verify the exact expected version/release, never only a generic 200/ok. */
  check(input: {
    phase: HealthCheckPhase;
    version: string;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<boolean>;
}

interface KnownGoodVersion {
  version: string;
  verifiedAt: number;
}

interface VersionState {
  schemaVersion: typeof VERSION_STATE_SCHEMA_VERSION;
  previousVersion: string | null;
  knownGood: KnownGoodVersion[];
}

type UpdateJournalPhase =
  | "downloading"
  | "inspecting"
  | "extracting"
  | "publishing"
  | "candidate-health"
  | "switch-pending"
  | "current-health"
  | "committing"
  | "rollback-pending"
  | "cleanup-pending";

interface UpdateJournal {
  schemaVersion: typeof UPDATE_JOURNAL_SCHEMA_VERSION;
  operationId: string;
  stagingId: string;
  phase: UpdateJournalPhase;
  candidateVersion: string;
  previousVersion: string | null;
  startedAt: number;
}

export type UpdateEngineNetworkOptions = Omit<
  GithubFetchOptions,
  "maxBodyBytes" | "signal" | "accept"
>;

export interface UpdateEngineOptions {
  trust: ReleaseTrust;
  platform: ReleasePlatform;
  arch: ReleaseArchitecture;
  storage: UpdateStorage;
  extractor: UpdateExtractor;
  health: UpdateHealthCheck;
  network?: UpdateEngineNetworkOptions;
  archiveLimits?: Partial<ArchiveLimits>;
  healthTimeoutMs?: number;
  maxRetainedVersions?: number;
  now?: () => number;
  randomId?: () => string;
}

export interface UpdateResult {
  status: "updated" | "up-to-date";
  version: string;
  previousVersion: string | null;
  cleanupPending: boolean;
}

export interface RecoveryResult {
  status: "clean" | "rolled-back" | "committed" | "cleanup-pending";
  version?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseCanonicalInternalJson(raw: string, maxBytes: number): unknown {
  if (!raw || Buffer.byteLength(raw, "utf8") > maxBytes) {
    updateFail("journal_corrupt", "Update recovery state is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    updateFail("journal_corrupt", "Update recovery state is invalid");
  }
  try {
    if (canonicalizeReleaseJson(parsed) !== raw) {
      updateFail("journal_corrupt", "Update recovery state is invalid");
    }
  } catch (error) {
    if (error instanceof UpdateEngineError) throw error;
    updateFail("journal_corrupt", "Update recovery state is invalid");
  }
  return parsed;
}

function parseJournal(raw: string): UpdateJournal {
  const value = parseCanonicalInternalJson(raw, MAX_JOURNAL_BYTES);
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "operationId",
      "stagingId",
      "phase",
      "candidateVersion",
      "previousVersion",
      "startedAt",
    ])
    || value.schemaVersion !== UPDATE_JOURNAL_SCHEMA_VERSION
    || typeof value.operationId !== "string"
    || !RANDOM_ID_PATTERN.test(value.operationId)
    || typeof value.stagingId !== "string"
    || !RANDOM_ID_PATTERN.test(value.stagingId)
    || typeof value.phase !== "string"
    || !JOURNAL_PHASES.has(value.phase as UpdateJournalPhase)
    || !isReleaseVersion(value.candidateVersion)
    || (value.previousVersion !== null && !isReleaseVersion(value.previousVersion))
    || !safeTimestamp(value.startedAt)
  ) {
    updateFail("journal_corrupt", "Update recovery state is invalid");
  }
  return value as unknown as UpdateJournal;
}

function emptyVersionState(): VersionState {
  return { schemaVersion: VERSION_STATE_SCHEMA_VERSION, previousVersion: null, knownGood: [] };
}

function parseVersionState(raw: string | null): VersionState {
  if (raw === null) return emptyVersionState();
  const value = parseCanonicalInternalJson(raw, MAX_VERSION_STATE_BYTES);
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "previousVersion", "knownGood"])
    || value.schemaVersion !== VERSION_STATE_SCHEMA_VERSION
    || (value.previousVersion !== null && !isReleaseVersion(value.previousVersion))
    || !Array.isArray(value.knownGood)
    || value.knownGood.length > 128
  ) {
    updateFail("journal_corrupt", "Installed version state is invalid");
  }
  const knownGood: KnownGoodVersion[] = [];
  const seen = new Set<string>();
  for (const entry of value.knownGood) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ["version", "verifiedAt"])
      || !isReleaseVersion(entry.version)
      || !safeTimestamp(entry.verifiedAt)
      || seen.has(entry.version)
    ) {
      updateFail("journal_corrupt", "Installed version state is invalid");
    }
    seen.add(entry.version);
    knownGood.push({ version: entry.version, verifiedAt: entry.verifiedAt });
  }
  return {
    schemaVersion: VERSION_STATE_SCHEMA_VERSION,
    previousVersion: value.previousVersion as string | null,
    knownGood,
  };
}

function normalizedArchiveLimits(overrides: Partial<ArchiveLimits> | undefined): ArchiveLimits {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  const integers = [
    limits.maxEntries,
    limits.maxSingleFileBytes,
    limits.maxTotalBytes,
    limits.maxPathBytes,
    limits.maxPathDepth,
  ];
  if (
    integers.some((value) => !Number.isSafeInteger(value) || value <= 0)
    || !Number.isFinite(limits.maxCompressionRatio)
    || limits.maxCompressionRatio < 1
    || limits.maxEntries > 100_000
    || limits.maxTotalBytes > Number.MAX_SAFE_INTEGER
    || limits.maxSingleFileBytes > limits.maxTotalBytes
    || limits.maxPathBytes > 32_768
    || limits.maxPathDepth > 256
    || (limits.requiredRoot !== undefined && !isPortableArchiveRoot(limits.requiredRoot))
  ) {
    updateFail("invalid_configuration", "Update archive limits are invalid");
  }
  return limits;
}

function isPortableArchiveRoot(value: string): boolean {
  return Boolean(value)
    && value.normalize("NFC") === value
    && !value.includes("/")
    && !value.includes("\\")
    && value !== "."
    && value !== ".."
    && !WINDOWS_INVALID_PATH_CHARACTERS.test(value)
    && !/[. ]$/.test(value)
    && !WINDOWS_RESERVED_STEM.test(value.split(".", 1)[0]);
}

function normalizeArchiveEntryPath(entry: ArchiveEntry, limits: ArchiveLimits): string {
  if (
    typeof entry.path !== "string"
    || !entry.path
    || entry.path.normalize("NFC") !== entry.path
    || CONTROL_CHARACTERS.test(entry.path)
    || entry.path.includes("\\")
    || entry.path.startsWith("/")
    || entry.path.startsWith("//")
    || /^[A-Za-z]:/.test(entry.path)
    || /^(?:\\\\|\\\?\\|\\\.\\)/.test(entry.path)
    || Buffer.byteLength(entry.path, "utf8") > limits.maxPathBytes
  ) {
    updateFail("unsafe_archive", "Release archive contains an unsafe entry");
  }
  let candidate = entry.path;
  if (candidate.endsWith("/")) {
    if (entry.kind !== "directory") updateFail("unsafe_archive", "Release archive contains an unsafe entry");
    candidate = candidate.replace(/\/+$/, "");
  }
  const segments = candidate.split("/");
  if (
    !candidate
    || segments.length > limits.maxPathDepth
    || segments.some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || segment.normalize("NFC") !== segment
      || Buffer.byteLength(segment, "utf8") > 255
      || WINDOWS_INVALID_PATH_CHARACTERS.test(segment)
      || /[. ]$/.test(segment)
      || WINDOWS_RESERVED_STEM.test(segment.split(".", 1)[0])
    ))
    || (limits.requiredRoot !== undefined && segments[0] !== limits.requiredRoot)
  ) {
    updateFail("unsafe_archive", "Release archive contains an unsafe entry");
  }
  return candidate;
}

/** Validate portable archive semantics before the extractor writes any entry. */
export async function validateArchiveEntries(
  source: Iterable<ArchiveEntry> | AsyncIterable<ArchiveEntry>,
  archiveBytes: number,
  overrides?: Partial<ArchiveLimits>,
): Promise<ValidatedArchive> {
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0) {
    updateFail("unsafe_archive", "Release archive size is invalid");
  }
  const limits = normalizedArchiveLimits(overrides);
  const entries: ValidatedArchiveEntry[] = [];
  const knownPaths = new Set<string>();
  const knownFiles = new Set<string>();
  const descendantParents = new Set<string>();
  let totalUncompressedBytes = 0;
  let fileCount = 0;

  for await (const entry of source) {
    if (!isRecord(entry) || (entry.kind !== "file" && entry.kind !== "directory")) {
      updateFail("unsafe_archive", "Release archive contains a link or special entry");
    }
    if (
      typeof entry.size !== "number"
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || (entry.kind === "directory" && entry.size !== 0)
      || (entry.kind === "file" && entry.size > limits.maxSingleFileBytes)
      || (entry.compressedSize !== undefined && (
        !Number.isSafeInteger(entry.compressedSize)
        || entry.compressedSize < 0
        || (entry.size > 0 && entry.compressedSize === 0)
      ))
      || (entry.mode !== undefined && (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777))
    ) {
      updateFail("unsafe_archive", "Release archive entry metadata is invalid");
    }
    if (entries.length >= limits.maxEntries) {
      updateFail("unsafe_archive", "Release archive contains too many entries");
    }

    const entryPath = normalizeArchiveEntryPath(entry, limits);
    const portableKey = entryPath.toLowerCase();
    if (knownPaths.has(portableKey)) {
      updateFail("unsafe_archive", "Release archive contains colliding paths");
    }
    const segments = portableKey.split("/");
    let parent = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      parent = parent ? `${parent}/${segments[index]}` : segments[index];
      if (knownFiles.has(parent)) {
        updateFail("unsafe_archive", "Release archive contains conflicting file paths");
      }
      descendantParents.add(parent);
    }
    if (entry.kind === "file" && descendantParents.has(portableKey)) {
      updateFail("unsafe_archive", "Release archive contains conflicting file paths");
    }
    knownPaths.add(portableKey);
    if (entry.kind === "file") knownFiles.add(portableKey);

    totalUncompressedBytes += entry.size;
    if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > limits.maxTotalBytes) {
      updateFail("unsafe_archive", "Release archive expands beyond the size limit");
    }
    if (
      entry.compressedSize !== undefined
      && entry.compressedSize > 0
      && entry.size / entry.compressedSize > limits.maxCompressionRatio
    ) {
      updateFail("unsafe_archive", "Release archive exceeds the compression ratio limit");
    }
    if (entry.kind === "file") fileCount += 1;
    entries.push({ path: entryPath, kind: entry.kind, size: entry.size });
  }

  if (
    entries.length === 0
    || fileCount === 0
    || totalUncompressedBytes / archiveBytes > limits.maxCompressionRatio
  ) {
    updateFail("unsafe_archive", "Release archive contents are invalid");
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    fileCount,
    totalUncompressedBytes,
  });
}

interface ParsedSemver {
  core: [bigint, bigint, bigint];
  prerelease: string[];
}

function parsedSemver(version: string): ParsedSemver {
  const withoutBuild = version.split("+", 1)[0];
  const [core, prerelease = ""] = withoutBuild.split("-", 2);
  const parts = core.split(".");
  return {
    core: [BigInt(parts[0]), BigInt(parts[1]), BigInt(parts[2])],
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

/** SemVer precedence; build metadata does not affect update ordering. */
export function compareReleaseVersions(left: string, right: string): number {
  if (!isReleaseVersion(left) || !isReleaseVersion(right)) {
    updateFail("invalid_configuration", "Release version is invalid");
  }
  const a = parsedSemver(left);
  const b = parsedSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] < b.core[index]) return -1;
    if (a.core[index] > b.core[index]) return 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) return aPart === undefined ? -1 : 1;
    if (aPart === bPart) continue;
    const aNumeric = /^\d+$/.test(aPart);
    const bNumeric = /^\d+$/.test(bPart);
    if (aNumeric && bNumeric) return BigInt(aPart) < BigInt(bPart) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

function defaultRandomId(): string {
  return randomBytes(16).toString("hex");
}

function normalizedEngineError(error: unknown, stage: UpdateJournalPhase): UpdateEngineError {
  if (error instanceof UpdateEngineError) return error;
  if (error instanceof ReleaseManifestError) {
    if (stage === "downloading") return new UpdateEngineError("download_failed", "Release download failed");
    return new UpdateEngineError("invalid_manifest", "Release manifest validation failed");
  }
  if (stage === "downloading") return new UpdateEngineError("download_failed", "Release download failed");
  if (stage === "inspecting") return new UpdateEngineError("unsafe_archive", "Release archive inspection failed");
  if (stage === "extracting") return new UpdateEngineError("extraction_failed", "Release extraction failed");
  if (stage === "candidate-health" || stage === "current-health") {
    return new UpdateEngineError("health_failed", "Release health check failed");
  }
  if (stage === "switch-pending") return new UpdateEngineError("switch_failed", "Release activation failed");
  return new UpdateEngineError("storage_failure", "Release storage operation failed");
}

export class UpdateEngine {
  private readonly trust: ReleaseTrust;
  private readonly platform: ReleasePlatform;
  private readonly arch: ReleaseArchitecture;
  private readonly storage: UpdateStorage;
  private readonly extractor: UpdateExtractor;
  private readonly health: UpdateHealthCheck;
  private readonly network: UpdateEngineNetworkOptions;
  private readonly archiveLimits: ArchiveLimits;
  private readonly healthTimeoutMs: number;
  private readonly maxRetainedVersions: number;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(options: UpdateEngineOptions) {
    if (!options || !options.trust || !options.storage || !options.extractor || !options.health) {
      updateFail("invalid_configuration", "Update engine configuration is invalid");
    }
    if (!new Set(["darwin", "linux", "win32"]).has(options.platform)) {
      updateFail("invalid_configuration", "Update platform is invalid");
    }
    if (!new Set(["arm64", "x64"]).has(options.arch)) {
      updateFail("invalid_configuration", "Update architecture is invalid");
    }
    const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    const maxRetainedVersions = options.maxRetainedVersions ?? DEFAULT_MAX_RETAINED_VERSIONS;
    if (
      !Number.isSafeInteger(healthTimeoutMs)
      || healthTimeoutMs <= 0
      || healthTimeoutMs > 10 * 60 * 1000
      || !Number.isSafeInteger(maxRetainedVersions)
      || maxRetainedVersions < 2
      || maxRetainedVersions > 32
    ) {
      updateFail("invalid_configuration", "Update engine limits are invalid");
    }
    this.trust = options.trust;
    this.platform = options.platform;
    this.arch = options.arch;
    this.storage = options.storage;
    this.extractor = options.extractor;
    this.health = options.health;
    this.network = Object.freeze({ ...(options.network ?? {}) });
    this.archiveLimits = normalizedArchiveLimits(options.archiveLimits);
    this.healthTimeoutMs = healthTimeoutMs;
    this.maxRetainedVersions = maxRetainedVersions;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? defaultRandomId;
  }

  async applyManifest(input: string | Uint8Array): Promise<UpdateResult> {
    return this.withLock(async () => {
      await this.recoverLocked();
      let manifest: VerifiedReleaseManifest;
      try {
        manifest = parseAndVerifyReleaseManifest(input, this.trust);
      } catch {
        updateFail("invalid_manifest", "Release manifest validation failed");
      }
      return this.applyVerifiedLocked(manifest);
    });
  }

  async applyManifestUrl(url: string | URL): Promise<UpdateResult> {
    return this.withLock(async () => {
      await this.recoverLocked();
      let manifest: VerifiedReleaseManifest;
      try {
        manifest = await fetchAndVerifyReleaseManifest(url, this.trust, this.network);
      } catch {
        updateFail("invalid_manifest", "Release manifest download or validation failed");
      }
      return this.applyVerifiedLocked(manifest);
    });
  }

  async recover(): Promise<RecoveryResult> {
    return this.withLock(() => this.recoverLocked());
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    let lock: UpdateLock;
    try {
      lock = await this.storage.acquireLock();
    } catch (error) {
      if (error instanceof UpdateLockBusyError) {
        updateFail("concurrent_update", "Another release update is already running");
      }
      updateFail("storage_failure", "Release update lock could not be acquired");
    }

    let operationError: unknown;
    try {
      return await operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await lock.release();
      } catch {
        if (operationError === undefined) {
          updateFail("storage_failure", "Release update lock could not be released");
        }
      }
    }
  }

  private async readJournal(): Promise<UpdateJournal | null> {
    let raw: string | null;
    try {
      raw = await this.storage.readJournal(MAX_JOURNAL_BYTES);
    } catch {
      updateFail("storage_failure", "Release recovery state could not be read");
    }
    return raw === null ? null : parseJournal(raw);
  }

  private async writeJournal(journal: UpdateJournal, phase: UpdateJournalPhase): Promise<void> {
    journal.phase = phase;
    try {
      await this.storage.writeJournalAtomic(canonicalizeReleaseJson(journal));
    } catch {
      updateFail("storage_failure", "Release recovery state could not be persisted");
    }
  }

  private async recoverLocked(): Promise<RecoveryResult> {
    const journal = await this.readJournal();
    if (!journal) return { status: "clean" };

    if (journal.phase === "committing" || journal.phase === "cleanup-pending") {
      let current: string | null;
      try {
        current = await this.storage.currentVersion();
      } catch {
        updateFail("recovery_failed", "Release recovery could not determine the current version");
      }
      if (current === journal.candidateVersion) {
        const complete = await this.finalizeCommit(journal);
        return {
          status: complete ? "committed" : "cleanup-pending",
          version: journal.candidateVersion,
        };
      }
    }

    await this.rollback(journal, "recovery_failed");
    return { status: "rolled-back", version: journal.previousVersion ?? undefined };
  }

  private async applyVerifiedLocked(manifest: VerifiedReleaseManifest): Promise<UpdateResult> {
    let asset: Readonly<ReleaseAsset>;
    try {
      asset = selectReleaseAsset(manifest, this.platform, this.arch);
    } catch {
      updateFail("no_compatible_asset", "No release asset supports this platform and architecture");
    }

    let previousVersion: string | null;
    try {
      previousVersion = await this.storage.currentVersion();
    } catch {
      updateFail("storage_failure", "Current release version could not be read");
    }
    if (previousVersion !== null && !isReleaseVersion(previousVersion)) {
      updateFail("storage_failure", "Current release version state is invalid");
    }
    if (previousVersion === asset.version) {
      return {
        status: "up-to-date",
        version: asset.version,
        previousVersion,
        cleanupPending: false,
      };
    }
    if (previousVersion !== null && compareReleaseVersions(asset.version, previousVersion) <= 0) {
      updateFail("downgrade_blocked", "Release version is not newer than the installed version");
    }
    try {
      if (await this.storage.versionExists(asset.version)) {
        updateFail("version_conflict", "Release version already exists outside the active update");
      }
    } catch (error) {
      if (error instanceof UpdateEngineError) throw error;
      updateFail("storage_failure", "Installed release versions could not be inspected");
    }

    const operationId = this.randomId();
    const stagingId = this.randomId();
    const startedAt = this.now();
    if (
      !RANDOM_ID_PATTERN.test(operationId)
      || !RANDOM_ID_PATTERN.test(stagingId)
      || operationId === stagingId
      || !safeTimestamp(startedAt)
    ) {
      updateFail("invalid_configuration", "Update randomness or clock is invalid");
    }
    const journal: UpdateJournal = {
      schemaVersion: UPDATE_JOURNAL_SCHEMA_VERSION,
      operationId,
      stagingId,
      phase: "downloading",
      candidateVersion: asset.version,
      previousVersion,
      startedAt,
    };

    let staging: UpdateStagingArea | undefined;
    let journalPersisted = false;
    try {
      await this.writeJournal(journal, "downloading");
      journalPersisted = true;
      try {
        staging = await this.storage.createPrivateStaging(stagingId);
      } catch {
        updateFail("storage_failure", "Private release staging could not be created");
      }
      if (staging.id !== stagingId || !staging.archiveReference || !staging.candidateReference) {
        updateFail("storage_failure", "Private release staging is invalid");
      }

      await this.downloadAsset(asset, staging);
      await this.writeJournal(journal, "inspecting");

      let archive: ValidatedArchive;
      try {
        const entries = await this.extractor.inspect(staging.archiveReference);
        archive = await validateArchiveEntries(entries, asset.size, this.archiveLimits);
      } catch (error) {
        if (error instanceof UpdateEngineError) throw error;
        updateFail("unsafe_archive", "Release archive inspection failed");
      }

      await this.writeJournal(journal, "extracting");
      try {
        await this.extractor.extract(staging.archiveReference, staging.candidateReference, EXTRACTION_POLICY);
        await this.storage.auditExtractedTree(staging, archive, EXTRACTION_POLICY);
      } catch {
        updateFail("extraction_failed", "Release extraction or tree audit failed");
      }

      await this.writeJournal(journal, "publishing");
      try {
        await this.storage.publishCandidate(staging, asset.version);
      } catch {
        updateFail("storage_failure", "Release candidate could not be published");
      }

      await this.writeJournal(journal, "candidate-health");
      await this.runHealthCheck("candidate", asset.version);
      await this.writeJournal(journal, "switch-pending");
      try {
        await this.storage.switchCurrentAtomically(asset.version);
      } catch {
        updateFail("switch_failed", "Release activation failed");
      }
      await this.writeJournal(journal, "current-health");
      await this.runHealthCheck("current", asset.version);
      await this.writeJournal(journal, "committing");
      const cleanupComplete = await this.finalizeCommit(journal);
      return {
        status: "updated",
        version: asset.version,
        previousVersion,
        cleanupPending: !cleanupComplete,
      };
    } catch (error) {
      const primary = normalizedEngineError(error, journal.phase);
      if (journalPersisted) {
        try {
          await this.rollback(journal, "rollback_failed");
        } catch {
          updateFail("rollback_failed", "Release update failed and rollback is incomplete");
        }
      } else if (staging) {
        try { await this.storage.removeStaging(staging.id); } catch { /* no durable journal exists */ }
      }
      throw primary;
    }
  }

  private async downloadAsset(asset: Readonly<ReleaseAsset>, staging: UpdateStagingArea): Promise<void> {
    let response: Response;
    try {
      response = await fetchPinnedGithubResource(asset.url, this.trust, {
        ...this.network,
        maxBodyBytes: asset.size,
        accept: "application/octet-stream",
      });
    } catch {
      updateFail("download_failed", "Release asset download failed");
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      updateFail("download_failed", "Release asset download failed");
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) !== asset.size)) {
      await response.body.cancel();
      updateFail("integrity_failed", "Release asset size verification failed");
    }

    let output: UpdateWriteHandle;
    try {
      output = await this.storage.openArchiveExclusive(staging);
    } catch {
      await response.body.cancel();
      updateFail("storage_failure", "Exclusive release archive creation failed");
    }
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let received = 0;
    let completed = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > asset.size) updateFail("integrity_failed", "Release asset exceeds its signed size");
        hash.update(chunk.value);
        try {
          await output.write(chunk.value);
        } catch {
          updateFail("storage_failure", "Release archive could not be written");
        }
      }
      if (received !== asset.size) updateFail("integrity_failed", "Release asset size verification failed");
      const actualHash = hash.digest();
      const expectedHash = Buffer.from(asset.sha256, "hex");
      if (actualHash.byteLength !== expectedHash.byteLength || !timingSafeEqual(actualHash, expectedHash)) {
        updateFail("integrity_failed", "Release asset hash verification failed");
      }
      try {
        verifyReleaseAssetSignature(asset as ReleaseAsset, this.trust);
      } catch {
        updateFail("integrity_failed", "Release asset signature verification failed");
      }
      try {
        await output.sync();
      } catch {
        updateFail("storage_failure", "Release archive could not be synchronized");
      }
      completed = true;
    } catch (error) {
      try { await reader.cancel(); } catch { /* stream already failed */ }
      if (error instanceof UpdateEngineError) throw error;
      updateFail("download_failed", "Release asset streaming failed");
    } finally {
      try {
        await output.close();
      } catch {
        if (completed) updateFail("storage_failure", "Release archive could not be closed durably");
      }
    }
  }

  private async runHealthCheck(phase: HealthCheckPhase, version: string): Promise<void> {
    const controller = new AbortController();
    const deadlineAt = this.now() + this.healthTimeoutMs;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new UpdateEngineError("health_timeout", "Release health check timed out"));
      }, this.healthTimeoutMs);
    });
    try {
      const healthy = await Promise.race([
        this.health.check({ phase, version, deadlineAt, signal: controller.signal }),
        timeout,
      ]);
      if (healthy !== true) updateFail("health_failed", "Release health check failed");
    } catch (error) {
      if (error instanceof UpdateEngineError) throw error;
      if (timedOut) updateFail("health_timeout", "Release health check timed out");
      updateFail("health_failed", "Release health check failed");
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  private async rollback(
    journal: UpdateJournal,
    failureCode: "rollback_failed" | "recovery_failed",
  ): Promise<void> {
    try {
      await this.writeJournal(journal, "rollback-pending");
      const current = await this.storage.currentVersion();
      if (current === journal.candidateVersion) {
        await this.storage.switchCurrentAtomically(journal.previousVersion);
        if (journal.previousVersion !== null) {
          await this.runHealthCheck("rollback", journal.previousVersion);
        }
      } else if (current !== journal.previousVersion) {
        updateFail(failureCode, "Release rollback found an unexpected current version");
      }

      const currentAfterRollback = await this.storage.currentVersion();
      if (currentAfterRollback !== journal.previousVersion) {
        updateFail(failureCode, "Release rollback did not restore the previous version");
      }
      const rawVersionState = await this.storage.readVersionState(MAX_VERSION_STATE_BYTES);
      if (rawVersionState !== null) {
        const versionState = parseVersionState(rawVersionState);
        const knownGood = versionState.knownGood.filter(
          (entry) => entry.version !== journal.candidateVersion,
        );
        if (knownGood.length !== versionState.knownGood.length) {
          await this.storage.writeVersionStateAtomic(canonicalizeReleaseJson({
            ...versionState,
            knownGood,
          }));
        }
      }
      if (
        journal.candidateVersion !== currentAfterRollback
        && journal.candidateVersion !== journal.previousVersion
        && await this.storage.versionExists(journal.candidateVersion)
      ) {
        await this.storage.removeVersion(journal.candidateVersion);
      }
      await this.storage.removeStaging(journal.stagingId);
      await this.storage.clearJournal();
    } catch (error) {
      if (error instanceof UpdateEngineError && error.code === failureCode) throw error;
      updateFail(failureCode, "Release rollback is incomplete");
    }
  }

  private async finalizeCommit(journal: UpdateJournal): Promise<boolean> {
    let state: VersionState;
    try {
      state = parseVersionState(await this.storage.readVersionState(MAX_VERSION_STATE_BYTES));
      const knownGood = state.knownGood.filter((entry) => entry.version !== journal.candidateVersion);
      knownGood.push({ version: journal.candidateVersion, verifiedAt: this.now() });
      knownGood.sort((left, right) => right.verifiedAt - left.verifiedAt);
      state = {
        schemaVersion: VERSION_STATE_SCHEMA_VERSION,
        previousVersion: journal.previousVersion,
        knownGood: knownGood.slice(0, 128),
      };
      await this.storage.writeVersionStateAtomic(canonicalizeReleaseJson(state));
      await this.writeJournal(journal, "cleanup-pending");
    } catch (error) {
      if (error instanceof UpdateEngineError) throw error;
      updateFail("storage_failure", "Committed release state could not be persisted");
    }

    try {
      await this.cleanupVersions(state);
      await this.storage.removeStaging(journal.stagingId);
      await this.storage.clearJournal();
      return true;
    } catch {
      return false;
    }
  }

  private async cleanupVersions(state: VersionState): Promise<void> {
    const current = await this.storage.currentVersion();
    if (current === null || !isReleaseVersion(current)) {
      updateFail("storage_failure", "Current release version state is invalid");
    }
    const installed = await this.storage.listInstalledVersions();
    if (installed.some((entry) => !isReleaseVersion(entry.version) || !safeTimestamp(entry.installedAt))) {
      updateFail("storage_failure", "Installed release version state is invalid");
    }
    const protectedVersions = new Set<string>([current]);
    if (state.previousVersion) protectedVersions.add(state.previousVersion);
    const newestKnownGood = [...state.knownGood].sort((a, b) => b.verifiedAt - a.verifiedAt)[0];
    if (newestKnownGood) protectedVersions.add(newestKnownGood.version);

    const retained = new Set(protectedVersions);
    for (const entry of [...installed].sort((a, b) => b.installedAt - a.installedAt)) {
      if (retained.size >= this.maxRetainedVersions) break;
      retained.add(entry.version);
    }
    for (const entry of installed) {
      if (retained.has(entry.version)) continue;
      const currentBeforeDelete = await this.storage.currentVersion();
      if (entry.version === currentBeforeDelete || entry.version === state.previousVersion) continue;
      await this.storage.removeVersion(entry.version);
    }
  }
}
