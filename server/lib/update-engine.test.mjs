import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  UpdateEngine,
  UpdateEngineError,
  UpdateLockBusyError,
} = await jiti.import("./update-engine.ts");
const {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  canonicalizeReleaseJson,
  createReleaseTrust,
  releaseAssetSigningPayload,
  releaseManifestSigningPayload,
} = await jiti.import("./release-manifest.ts");

const OWNER = "pihub-org";
const REPO = "pihub";
const CHANNEL = "stable";
const CURRENT_VERSION = "0.0.2";
const NEXT_VERSION = "0.0.3";
const DEFAULT_ASSET_BYTES = Buffer.from("pihub-signed-release-archive", "utf8");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trust = createReleaseTrust({ owner: OWNER, repo: REPO, channel: CHANNEL, publicKey });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function corruptSignature(signature) {
  return `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
}

function signedManifest({
  bytes = DEFAULT_ASSET_BYTES,
  version = NEXT_VERSION,
  owner = OWNER,
  repo = REPO,
  channel = CHANNEL,
  url = `https://github.com/${owner}/${repo}/releases/download/v${version}/pihub-server-linux-x64.tar.gz`,
  assetHash = sha256(bytes),
  corruptAssetSignature = false,
  corruptManifestSignature = false,
} = {}) {
  const unsignedAsset = {
    version,
    platform: "linux",
    arch: "x64",
    url,
    sha256: assetHash,
    size: bytes.byteLength,
  };
  let assetSignature = sign(null, releaseAssetSigningPayload(unsignedAsset), privateKey)
    .toString("base64url");
  if (corruptAssetSignature) assetSignature = corruptSignature(assetSignature);
  const asset = { ...unsignedAsset, signature: assetSignature };
  const unsignedManifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    owner,
    repo,
    channel,
    version,
    assets: [asset],
  };
  let manifestSignature = sign(null, releaseManifestSigningPayload(unsignedManifest), privateKey)
    .toString("base64url");
  if (corruptManifestSignature) manifestSignature = corruptSignature(manifestSignature);
  return canonicalizeReleaseJson({ ...unsignedManifest, signature: manifestSignature });
}

function defaultEntries() {
  return [
    { path: "pihub/", kind: "directory", size: 0, mode: 0o755 },
    { path: "pihub/bin/", kind: "directory", size: 0, mode: 0o755 },
    {
      path: "pihub/bin/pi-web.js",
      kind: "file",
      size: 20,
      compressedSize: 10,
      mode: 0o755,
    },
  ];
}

function defaultVersionState() {
  return canonicalizeReleaseJson({
    schemaVersion: 1,
    previousVersion: "0.0.1",
    knownGood: [
      { version: CURRENT_VERSION, verifiedAt: 900 },
      { version: "0.0.1", verifiedAt: 800 },
    ],
  });
}

class MemoryStorage {
  constructor({
    currentVersion = CURRENT_VERSION,
    journal = null,
    versionState = defaultVersionState(),
    installed = [
      { version: "0.0.1", installedAt: 100 },
      { version: CURRENT_VERSION, installedAt: 200 },
    ],
  } = {}) {
    this.current = currentVersion;
    this.journal = journal;
    this.versionState = versionState;
    this.versions = new Map(installed.map((entry) => [entry.version, { ...entry }]));
    this.staging = new Map();
    this.calls = [];
    this.failures = new Map();
    this.lockHeld = false;
    this.installSequence = 300;
  }

  failNext(point, error) {
    const pending = this.failures.get(point) ?? [];
    pending.push(error);
    this.failures.set(point, pending);
  }

  maybeFail(point) {
    const pending = this.failures.get(point);
    if (!pending?.length) return;
    const error = pending.shift();
    if (pending.length === 0) this.failures.delete(point);
    throw error;
  }

  record(name, detail = {}) {
    this.calls.push({ name, ...detail });
  }

  async acquireLock() {
    this.record("lock.acquire");
    this.maybeFail("lock.acquire");
    if (this.lockHeld) throw new UpdateLockBusyError();
    this.lockHeld = true;
    return {
      release: async () => {
        this.record("lock.release");
        this.maybeFail("lock.release");
        this.lockHeld = false;
      },
    };
  }

  async readJournal(maxBytes) {
    this.record("journal.read", { maxBytes });
    this.maybeFail("journal.read");
    return this.journal;
  }

  async writeJournalAtomic(contents) {
    this.record("journal.write-atomic", { phase: JSON.parse(contents).phase });
    this.maybeFail("journal.write");
    this.journal = contents;
  }

  async clearJournal() {
    this.record("journal.clear");
    this.maybeFail("journal.clear");
    this.journal = null;
  }

  async createPrivateStaging(id) {
    this.record("staging.create-private", { id, mode: 0o700 });
    this.maybeFail("staging.create");
    if (this.staging.has(id)) throw new Error("private staging already exists");
    const area = {
      id,
      archiveReference: `memory:staging/${id}/archive`,
      candidateReference: `memory:staging/${id}/candidate`,
      archiveCreated: false,
      archiveChunks: [],
      synced: false,
      closed: false,
    };
    this.staging.set(id, area);
    return {
      id,
      archiveReference: area.archiveReference,
      candidateReference: area.candidateReference,
    };
  }

  areaFor(staging) {
    const area = this.staging.get(staging.id);
    if (!area) throw new Error("staging is missing");
    return area;
  }

  async openArchiveExclusive(staging) {
    this.record("archive.open-exclusive", { id: staging.id, flag: "wx", mode: 0o600 });
    this.maybeFail("archive.open");
    const area = this.areaFor(staging);
    if (area.archiveCreated) throw new Error("CREATE_NEW/O_EXCL refused an existing archive");
    area.archiveCreated = true;
    return {
      write: async (chunk) => {
        this.record("archive.write", { bytes: chunk.byteLength });
        this.maybeFail("archive.write");
        area.archiveChunks.push(Buffer.from(chunk));
      },
      sync: async () => {
        this.record("archive.sync");
        this.maybeFail("archive.sync");
        area.synced = true;
      },
      close: async () => {
        this.record("archive.close");
        this.maybeFail("archive.close");
        area.closed = true;
      },
    };
  }

  async removeStaging(id) {
    this.record("staging.remove", { id });
    this.maybeFail("staging.remove");
    this.staging.delete(id);
  }

  async publishCandidate(staging, version) {
    this.record("candidate.publish", { id: staging.id, version });
    this.maybeFail("candidate.publish");
    this.areaFor(staging);
    if (this.versions.has(version)) throw new Error("version already exists");
    this.versions.set(version, { version, installedAt: this.installSequence++ });
  }

  async versionExists(version) {
    this.record("version.exists", { version });
    this.maybeFail("version.exists");
    return this.versions.has(version);
  }

  async currentVersion() {
    this.record("current.read");
    this.maybeFail("current.read");
    return this.current;
  }

  async switchCurrentAtomically(version) {
    this.record("current.switch-atomic", { version });
    this.maybeFail("current.switch");
    this.current = version;
  }

  async auditExtractedTree(staging, archive, policy) {
    this.record("candidate.audit", {
      id: staging.id,
      fileCount: archive.fileCount,
      policy: { ...policy },
    });
    this.maybeFail("candidate.audit");
  }

  async readVersionState(maxBytes) {
    this.record("versions-state.read", { maxBytes });
    this.maybeFail("versions-state.read");
    return this.versionState;
  }

  async writeVersionStateAtomic(contents) {
    this.record("versions-state.write-atomic");
    this.maybeFail("versions-state.write");
    this.versionState = contents;
  }

  async listInstalledVersions() {
    this.record("versions.list");
    this.maybeFail("versions.list");
    return [...this.versions.values()].map((entry) => ({ ...entry }));
  }

  async removeVersion(version) {
    this.record("version.remove", { version });
    this.maybeFail("version.remove");
    this.versions.delete(version);
  }
}

class FakeExtractor {
  constructor(entries = defaultEntries()) {
    this.entries = entries;
    this.inspectCalls = [];
    this.extractCalls = [];
    this.inspectError = undefined;
    this.extractError = undefined;
  }

  async inspect(archiveReference) {
    this.inspectCalls.push(archiveReference);
    if (this.inspectError) throw this.inspectError;
    return this.entries;
  }

  async extract(archiveReference, candidateReference, policy) {
    this.extractCalls.push({ archiveReference, candidateReference, policy: { ...policy } });
    if (this.extractError) throw this.extractError;
  }
}

class FakeHealth {
  constructor(behavior = {}) {
    this.behavior = { candidate: true, current: true, rollback: true, ...behavior };
    this.calls = [];
  }

  async check(input) {
    this.calls.push({ ...input });
    const outcome = this.behavior[input.phase];
    if (typeof outcome === "function") return outcome(input);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

function responseFor(bytes) {
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Length": String(bytes.byteLength) },
  });
}

function fixture({
  bytes = DEFAULT_ASSET_BYTES,
  entries = defaultEntries(),
  storage = new MemoryStorage(),
  health = new FakeHealth(),
  fetchImpl,
  network = {},
  archiveLimits,
  healthTimeoutMs = 100,
  maxRetainedVersions = 3,
  manifestOptions = {},
} = {}) {
  const extractor = new FakeExtractor(entries);
  const fetchCalls = [];
  const resolvedFetch = fetchImpl ?? (async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return responseFor(bytes);
  });
  const ids = ["a".repeat(32), "b".repeat(32)];
  let timestamp = 1_000;
  const engine = new UpdateEngine({
    trust,
    platform: "linux",
    arch: "x64",
    storage,
    extractor,
    health,
    network: { fetchImpl: resolvedFetch, timeoutMs: 1_000, ...network },
    archiveLimits,
    healthTimeoutMs,
    maxRetainedVersions,
    now: () => timestamp++,
    randomId: () => ids.shift(),
  });
  return {
    engine,
    extractor,
    fetchCalls,
    health,
    manifest: signedManifest({ bytes, ...manifestOptions }),
    storage,
  };
}

async function expectEngineError(operation, code) {
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof UpdateEngineError, `expected UpdateEngineError, got ${String(failure)}`);
  assert.equal(failure.code, code);
  return failure;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("applies a signed update with private exclusive staging and retains rollback versions", async () => {
  const context = fixture();

  const result = await context.engine.applyManifest(context.manifest);

  assert.deepEqual(result, {
    status: "updated",
    version: NEXT_VERSION,
    previousVersion: CURRENT_VERSION,
    cleanupPending: false,
  });
  assert.equal(context.storage.current, NEXT_VERSION);
  assert.equal(context.storage.journal, null);
  assert.equal(context.storage.staging.size, 0);
  assert.deepEqual([...context.storage.versions.keys()].sort(), ["0.0.1", CURRENT_VERSION, NEXT_VERSION]);

  const state = JSON.parse(context.storage.versionState);
  assert.equal(state.previousVersion, CURRENT_VERSION);
  assert.deepEqual(state.knownGood.map((entry) => entry.version), [
    NEXT_VERSION,
    CURRENT_VERSION,
    "0.0.1",
  ]);
  assert.deepEqual(context.health.calls.map((call) => [call.phase, call.version]), [
    ["candidate", NEXT_VERSION],
    ["current", NEXT_VERSION],
  ]);

  const privateStaging = context.storage.calls.find((call) => call.name === "staging.create-private");
  const exclusiveArchive = context.storage.calls.find((call) => call.name === "archive.open-exclusive");
  assert.equal(privateStaging.mode, 0o700);
  assert.deepEqual(
    { flag: exclusiveArchive.flag, mode: exclusiveArchive.mode },
    { flag: "wx", mode: 0o600 },
  );
  assert.ok(context.storage.calls.some((call) => call.name === "archive.sync"));
  assert.ok(context.storage.calls.some((call) => call.name === "current.switch-atomic"));
  assert.deepEqual(context.extractor.extractCalls[0].policy, {
    ignoreOwnership: true,
    fileMode: 0o644,
    directoryMode: 0o755,
    allowLinks: false,
    allowSpecialFiles: false,
  });
});

test("rejects a signed asset whose downloaded hash is wrong", async () => {
  const context = fixture({ manifestOptions: { assetHash: "0".repeat(64) } });

  await expectEngineError(() => context.engine.applyManifest(context.manifest), "integrity_failed");

  assert.equal(context.storage.current, CURRENT_VERSION);
  assert.equal(context.storage.journal, null);
  assert.equal(context.storage.staging.size, 0);
  assert.equal(context.storage.versions.has(NEXT_VERSION), false);
});

for (const manifestCase of [
  { name: "manifest signature", options: { corruptManifestSignature: true } },
  { name: "asset signature", options: { corruptAssetSignature: true } },
  { name: "repository owner", options: { owner: "attacker" } },
]) {
  test(`rejects a manifest with the wrong ${manifestCase.name} before staging`, async () => {
    const context = fixture({ manifestOptions: manifestCase.options });

    await expectEngineError(() => context.engine.applyManifest(context.manifest), "invalid_manifest");

    assert.equal(context.fetchCalls.length, 0);
    assert.equal(context.storage.staging.size, 0);
    assert.equal(context.storage.current, CURRENT_VERSION);
  });
}

const unsafeArchives = [
  {
    name: "zip-slip traversal",
    entries: [{ path: "../escape.js", kind: "file", size: 1, compressedSize: 1 }],
  },
  {
    name: "symbolic links",
    entries: [{ path: "pihub/link", kind: "symlink", size: 0 }],
  },
  {
    name: "hard links",
    entries: [{ path: "pihub/link", kind: "hardlink", size: 0 }],
  },
  {
    name: "NTFS alternate data streams",
    entries: [{ path: "pihub/config.json:secret", kind: "file", size: 1, compressedSize: 1 }],
  },
  {
    name: "special device entries",
    entries: [{ path: "pihub/device", kind: "character-device", size: 0 }],
  },
  {
    name: "Windows device names",
    entries: [{ path: "pihub/CON.txt", kind: "file", size: 1, compressedSize: 1 }],
  },
  {
    name: "case-insensitive path collisions",
    entries: [
      { path: "pihub/App.js", kind: "file", size: 1, compressedSize: 1 },
      { path: "pihub/app.js", kind: "file", size: 1, compressedSize: 1 },
    ],
  },
  {
    name: "excessive compression ratio",
    entries: [{ path: "pihub/app.js", kind: "file", size: 100, compressedSize: 10 }],
    archiveLimits: { maxCompressionRatio: 2 },
  },
  {
    name: "excessive entry count",
    entries: [
      { path: "pihub/a", kind: "file", size: 1, compressedSize: 1 },
      { path: "pihub/b", kind: "file", size: 1, compressedSize: 1 },
    ],
    archiveLimits: { maxEntries: 1 },
  },
];

for (const archiveCase of unsafeArchives) {
  test(`rejects ${archiveCase.name} before extraction`, async () => {
    const context = fixture({
      entries: archiveCase.entries,
      archiveLimits: archiveCase.archiveLimits,
    });

    await expectEngineError(() => context.engine.applyManifest(context.manifest), "unsafe_archive");

    assert.equal(context.extractor.extractCalls.length, 0);
    assert.equal(context.storage.current, CURRENT_VERSION);
    assert.equal(context.storage.versions.has(NEXT_VERSION), false);
    assert.equal(context.storage.journal, null);
  });
}

test("normalizes offline failures without exposing a token or private absolute path", async () => {
  const token = "sensitive-value-canary";
  const unixPath = "/Users/private-user/.pihub/staging/archive";
  const windowsPath = "C:\\Users\\private-user\\PiHub\\archive";
  const assetUrl = `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/123`;
  const context = fixture({
    manifestOptions: { url: assetUrl },
    network: { token, allowToken: true },
    fetchImpl: async () => {
      throw new Error(`offline ${token} ${unixPath} ${windowsPath}`);
    },
  });

  const error = await expectEngineError(
    () => context.engine.applyManifest(context.manifest),
    "download_failed",
  );
  const exposed = `${error.name}:${error.code}:${error.message}`;
  assert.equal(exposed.includes(token), false);
  assert.equal(exposed.includes(unixPath), false);
  assert.equal(exposed.includes(windowsPath), false);
  assert.equal(context.storage.current, CURRENT_VERSION);
});

test("classifies a private archive write failure as storage failure and rolls back staging", async () => {
  const token = "disk-token-canary";
  const privatePath = "/Users/private-user/.pihub/staging/archive";
  const storage = new MemoryStorage();
  storage.failNext("archive.write", new Error(`ENOSPC ${privatePath} ${token}`));
  const context = fixture({ storage });

  const error = await expectEngineError(
    () => context.engine.applyManifest(context.manifest),
    "storage_failure",
  );

  assert.equal(error.message.includes(token), false);
  assert.equal(error.message.includes(privatePath), false);
  assert.equal(storage.current, CURRENT_VERSION);
  assert.equal(storage.journal, null);
  assert.equal(storage.staging.size, 0);
});

for (const healthCase of [
  { name: "port activation error", outcome: new Error("EADDRINUSE /Users/private-user/server.sock") },
  { name: "unhealthy current release", outcome: false },
]) {
  test(`rolls back the atomic current pointer after ${healthCase.name}`, async () => {
    const health = new FakeHealth({ current: healthCase.outcome });
    const context = fixture({ health });

    const error = await expectEngineError(
      () => context.engine.applyManifest(context.manifest),
      "health_failed",
    );

    assert.equal(error.message.includes("/Users/private-user"), false);
    assert.equal(context.storage.current, CURRENT_VERSION);
    assert.equal(context.storage.versions.has(NEXT_VERSION), false);
    assert.equal(context.storage.journal, null);
    assert.deepEqual(
      context.storage.calls
        .filter((call) => call.name === "current.switch-atomic")
        .map((call) => call.version),
      [NEXT_VERSION, CURRENT_VERSION],
    );
    assert.deepEqual(context.health.calls.map((call) => call.phase), [
      "candidate",
      "current",
      "rollback",
    ]);
  });
}

test("recovers an interruption after the atomic pointer switch by restoring known-good", async () => {
  const operationId = "c".repeat(32);
  const stagingId = "d".repeat(32);
  const journal = canonicalizeReleaseJson({
    schemaVersion: 1,
    operationId,
    stagingId,
    phase: "switch-pending",
    candidateVersion: NEXT_VERSION,
    previousVersion: CURRENT_VERSION,
    startedAt: 1_000,
  });
  const storage = new MemoryStorage({
    currentVersion: NEXT_VERSION,
    journal,
    installed: [
      { version: "0.0.1", installedAt: 100 },
      { version: CURRENT_VERSION, installedAt: 200 },
      { version: NEXT_VERSION, installedAt: 300 },
    ],
  });
  const health = new FakeHealth();
  const context = fixture({ storage, health });

  const result = await context.engine.recover();

  assert.deepEqual(result, { status: "rolled-back", version: CURRENT_VERSION });
  assert.equal(storage.current, CURRENT_VERSION);
  assert.equal(storage.versions.has(NEXT_VERSION), false);
  assert.equal(storage.versions.has(CURRENT_VERSION), true);
  assert.equal(storage.versionState, defaultVersionState());
  assert.equal(storage.journal, null);
  assert.deepEqual(health.calls.map((call) => [call.phase, call.version]), [
    ["rollback", CURRENT_VERSION],
  ]);
});

test("enforces the candidate health deadline and removes the unpublished candidate", async () => {
  const health = new FakeHealth({
    candidate: () => new Promise(() => undefined),
  });
  const context = fixture({ health, healthTimeoutMs: 10 });

  await expectEngineError(() => context.engine.applyManifest(context.manifest), "health_timeout");

  assert.equal(context.storage.current, CURRENT_VERSION);
  assert.equal(context.storage.versions.has(NEXT_VERSION), false);
  assert.equal(context.storage.journal, null);
});

test("rolls back when activation changes current and then reports an interrupted switch", async () => {
  const storage = new MemoryStorage();
  const originalSwitch = storage.switchCurrentAtomically.bind(storage);
  let interruptNextActivation = true;
  storage.switchCurrentAtomically = async (version) => {
    if (version === NEXT_VERSION && interruptNextActivation) {
      interruptNextActivation = false;
      storage.record("current.switch-atomic", { version });
      storage.current = version;
      throw new Error("simulated crash after atomic replacement /Users/private-user/current.json");
    }
    await originalSwitch(version);
  };
  const context = fixture({ storage });

  const error = await expectEngineError(
    () => context.engine.applyManifest(context.manifest),
    "switch_failed",
  );

  assert.equal(error.message.includes("/Users/private-user"), false);
  assert.equal(storage.current, CURRENT_VERSION);
  assert.equal(storage.versions.has(NEXT_VERSION), false);
  assert.equal(storage.journal, null);
});

test("holds one update lock across download so a concurrent mutation is rejected", async () => {
  const enteredFetch = deferred();
  const releaseFetch = deferred();
  const fetchImpl = async () => {
    enteredFetch.resolve();
    await releaseFetch.promise;
    return responseFor(DEFAULT_ASSET_BYTES);
  };
  const context = fixture({ fetchImpl });

  const firstUpdate = context.engine.applyManifest(context.manifest);
  await enteredFetch.promise;
  await expectEngineError(() => context.engine.recover(), "concurrent_update");

  releaseFetch.resolve();
  const result = await firstUpdate;
  assert.equal(result.status, "updated");
  assert.equal(context.storage.lockHeld, false);
  assert.equal(
    context.storage.calls.filter((call) => call.name === "lock.acquire").length,
    2,
  );
});
