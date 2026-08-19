import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { create as createTar, Header as TarHeader } from "tar";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  FileUpdateStorage,
  TarUpdateExtractor,
  getServerUpdateDataRoot,
} = await jiti.import("./server-update-runtime.ts");
const {
  UpdateEngine,
  UpdateLockBusyError,
  validateArchiveEntries,
} = await jiti.import("./update-engine.ts");
const {
  canonicalizeReleaseJson,
  createReleaseTrust,
} = await jiti.import("./release-manifest.ts");

const BOOTSTRAP_VERSION = "0.0.1";
const CANDIDATE_VERSION = "0.0.2";
const EXTRACTION_POLICY = Object.freeze({
  ignoreOwnership: true,
  fileMode: 0o644,
  directoryMode: 0o755,
  allowLinks: false,
  allowSpecialFiles: false,
});

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-server-update-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bootstrapPackageRoot = path.join(root, "bootstrap");
  await writeRunnableBundle(bootstrapPackageRoot, BOOTSTRAP_VERSION);
  return {
    root,
    bootstrapPackageRoot,
    dataRoot: path.join(root, "data"),
  };
}

function storageFor(paths, dataRoot = paths.dataRoot) {
  return new FileUpdateStorage({
    dataRoot,
    bootstrapPackageRoot: paths.bootstrapPackageRoot,
    bootstrapVersion: BOOTSTRAP_VERSION,
  });
}

async function writeRunnableBundle(root, version, { omit = [] } = {}) {
  const omitted = new Set(omit);
  const files = new Map([
    [
      "package.json",
      `${JSON.stringify({ name: "@pihub/server", version })}\n`,
    ],
    [".next/BUILD_ID", `build-${version}\n`],
    ["node_modules/next/package.json", `${JSON.stringify({ name: "next", version: "16.3.1" })}\n`],
    ["node_modules/next/dist/bin/next", "process.stdout.write('next');\n"],
  ]);
  await mkdir(root, { recursive: true });
  for (const [relative, contents] of files) {
    if (omitted.has(relative)) continue;
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

async function createBundleArchive(source, destination) {
  await createTar({
    cwd: source,
    file: destination,
    gzip: true,
    noMtime: true,
    portable: true,
  }, ["package.json", ".next", "node_modules"]);
}

function rawTarEntry({ path: entryPath, type, body = Buffer.alloc(0), linkpath = "" }) {
  const header = new TarHeader({
    path: entryPath,
    type,
    linkpath,
    mode: type === "Directory" ? 0o755 : 0o644,
    uid: 0,
    gid: 0,
    size: type === "File" ? body.byteLength : 0,
    mtime: new Date(0),
    uname: "",
    gname: "",
  });
  header.encode();
  assert.equal(header.needPax, false, "test archive entries must fit in a standard tar header");
  const padding = Buffer.alloc((512 - (body.byteLength % 512)) % 512);
  return Buffer.concat([header.block, body, padding]);
}

async function writeRawTar(destination, entries) {
  const body = Buffer.concat([
    ...entries.map(rawTarEntry),
    Buffer.alloc(1024),
  ]);
  await writeFile(destination, gzipSync(body));
}

async function waitForChildText(child, expected, timeoutMs = 10_000) {
  child.stdout.setEncoding("utf8");
  let output = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child output: ${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Lock child exited before readiness (${code ?? signal})`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

test("derives private update roots with the target platform's path semantics", () => {
  assert.equal(
    getServerUpdateDataRoot({ platform: "darwin", home: "/Users/alice", env: {} }),
    "/Users/alice/Library/Application Support/PiHub/Server",
  );
  assert.equal(
    getServerUpdateDataRoot({ platform: "linux", home: "/home/alice", env: {} }),
    "/home/alice/.local/share/pihub/server",
  );
  assert.equal(
    getServerUpdateDataRoot({
      platform: "linux",
      home: "/home/alice",
      env: { XDG_DATA_HOME: " /srv/pihub-data " },
    }),
    "/srv/pihub-data/pihub/server",
  );
  assert.equal(
    getServerUpdateDataRoot({
      platform: "win32",
      home: "C:\\Users\\Alice",
      env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
    }),
    "C:\\Users\\Alice\\AppData\\Local\\PiHub\\Server",
  );

  assert.throws(
    () => getServerUpdateDataRoot({ platform: "win32", env: {}, home: "C:\\Users\\Alice" }),
    /LOCALAPPDATA is required/,
  );
  assert.throws(
    () => getServerUpdateDataRoot({
      platform: "win32",
      env: { LOCALAPPDATA: "relative\\data" },
      home: "C:\\Users\\Alice",
    }),
    /must be an absolute path/,
  );
  assert.throws(
    () => getServerUpdateDataRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: "relative/data" },
      home: "/home/alice",
    }),
    /must be an absolute path/,
  );
  assert.throws(
    () => getServerUpdateDataRoot({ platform: "freebsd", env: {}, home: "/home/alice" }),
    /Unsupported update platform/,
  );
});

test("initializes a canonical bootstrap pointer and rejects unavailable persisted releases", async (t) => {
  const paths = await fixture(t);
  const storage = storageFor(paths);

  await storage.initialize();
  await storage.initialize();

  assert.equal(await storage.currentVersion(), BOOTSTRAP_VERSION);
  assert.equal(
    await storage.resolveVersionRoot(BOOTSTRAP_VERSION),
    await realpath(paths.bootstrapPackageRoot),
  );
  assert.equal(
    await readFile(path.join(paths.dataRoot, "state", "current.json"), "utf8"),
    canonicalizeReleaseJson({ schemaVersion: 1, version: BOOTSTRAP_VERSION }),
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(paths.dataRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(paths.dataRoot, "state"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(paths.dataRoot, "state", "current.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(paths.dataRoot, "state", "update"))).mode & 0o777, 0o600);
  }

  const unavailableRoot = path.join(paths.root, "unavailable-data");
  await mkdir(path.join(unavailableRoot, "state"), { recursive: true });
  await writeFile(
    path.join(unavailableRoot, "state", "current.json"),
    canonicalizeReleaseJson({ schemaVersion: 1, version: "9.9.9" }),
  );
  await assert.rejects(storageFor(paths, unavailableRoot).initialize(), /unavailable version/);
});

test("serializes update ownership across independent processes", async (t) => {
  const paths = await fixture(t);
  const storage = storageFor(paths);
  await storage.initialize();

  const runtimeModule = path.join(process.cwd(), "lib", "server-update-runtime.ts");
  const childSource = `
    import { createJiti } from "jiti";
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const { FileUpdateStorage } = await jiti.import(${JSON.stringify(runtimeModule)});
    const storage = new FileUpdateStorage({
      dataRoot: process.env.PIHUB_TEST_DATA_ROOT,
      bootstrapPackageRoot: process.env.PIHUB_TEST_BOOTSTRAP_ROOT,
      bootstrapVersion: process.env.PIHUB_TEST_BOOTSTRAP_VERSION,
    });
    await storage.initialize();
    const lock = await storage.acquireLock();
    const guard = setTimeout(() => process.exit(2), 30000);
    process.stdout.write("locked\\n");
    process.stdin.once("data", async () => {
      clearTimeout(guard);
      await lock.release();
      process.exit(0);
    });
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PIHUB_TEST_DATA_ROOT: paths.dataRoot,
      PIHUB_TEST_BOOTSTRAP_ROOT: paths.bootstrapPackageRoot,
      PIHUB_TEST_BOOTSTRAP_VERSION: BOOTSTRAP_VERSION,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitPromise = once(child, "exit");
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  await waitForChildText(child, "locked\n");
  await assert.rejects(
    storage.acquireLock(),
    (error) => error instanceof UpdateLockBusyError || error?.name === "UpdateLockBusyError",
  );

  child.stdin.end("release\n");
  const [code, signal] = await exitPromise;
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);

  const lock = await storage.acquireLock();
  await lock.release();
});

test("inspects, safely extracts, and audits a complete runnable tar bundle", async (t) => {
  const paths = await fixture(t);
  const storage = storageFor(paths);
  const extractor = new TarUpdateExtractor();
  await storage.initialize();
  const staging = await storage.createPrivateStaging("1".repeat(32));
  const source = path.join(paths.root, "archive-source");
  await writeRunnableBundle(source, CANDIDATE_VERSION);
  await createBundleArchive(source, staging.archiveReference);

  const entries = await extractor.inspect(staging.archiveReference);
  assert.ok(entries.some((entry) => entry.kind === "directory"));
  assert.ok(entries.some((entry) => entry.kind === "file"));
  const archive = await validateArchiveEntries(
    entries,
    (await stat(staging.archiveReference)).size,
  );
  assert.equal(archive.fileCount, 4);

  await extractor.extract(staging.archiveReference, staging.candidateReference, EXTRACTION_POLICY);
  await storage.auditExtractedTree(staging, archive, EXTRACTION_POLICY);
  assert.equal(
    JSON.parse(await readFile(path.join(staging.candidateReference, "package.json"), "utf8")).version,
    CANDIDATE_VERSION,
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(staging.candidateReference, ".next"))).mode & 0o777, 0o755);
    assert.equal(
      (await stat(path.join(staging.candidateReference, "node_modules", "next", "dist", "bin", "next"))).mode & 0o777,
      0o644,
    );
  }

  await writeFile(path.join(staging.candidateReference, "unexpected.txt"), "tampered");
  await assert.rejects(
    storage.auditExtractedTree(staging, archive, EXTRACTION_POLICY),
    /unexpected directory|does not match the signed archive/,
  );
  await rm(path.join(staging.candidateReference, "unexpected.txt"));
  await storage.auditExtractedTree(staging, archive, EXTRACTION_POLICY);
});

test("rejects duplicate archive entries and links before extraction", async (t) => {
  const paths = await fixture(t);
  const extractor = new TarUpdateExtractor();
  const duplicateArchive = path.join(paths.root, "duplicate.tar.gz");
  const duplicateBody = Buffer.from("duplicate", "utf8");
  await writeRawTar(duplicateArchive, [
    { path: "package.json", type: "File", body: duplicateBody },
    { path: "package.json", type: "File", body: duplicateBody },
  ]);
  const duplicateEntries = await extractor.inspect(duplicateArchive);
  assert.equal(duplicateEntries.length, 2);
  await assert.rejects(
    validateArchiveEntries(duplicateEntries, (await stat(duplicateArchive)).size),
    (error) => error?.code === "unsafe_archive",
  );
  await assert.rejects(
    extractor.extract(
      duplicateArchive,
      path.join(paths.root, "duplicate-candidate"),
      EXTRACTION_POLICY,
    ),
    /duplicate paths/,
  );

  const linkArchive = path.join(paths.root, "link.tar.gz");
  await writeRawTar(linkArchive, [
    { path: "next-link", type: "SymbolicLink", linkpath: "node_modules/next/dist/bin/next" },
  ]);
  const linkEntries = await extractor.inspect(linkArchive);
  assert.equal(linkEntries[0].kind, "symlink");
  await assert.rejects(
    validateArchiveEntries(linkEntries, (await stat(linkArchive)).size),
    (error) => error?.code === "unsafe_archive",
  );
  await assert.rejects(
    extractor.extract(linkArchive, path.join(paths.root, "link-candidate"), EXTRACTION_POLICY),
    /link or special entry/,
  );
  assert.equal(await exists(path.join(paths.root, "link-candidate")), false);
});

test("rejects incomplete bundles and package versions that do not match the release", async (t) => {
  const paths = await fixture(t);
  const storage = storageFor(paths);
  await storage.initialize();
  const cases = [
    {
      id: "2".repeat(32),
      version: CANDIDATE_VERSION,
      omit: ["package.json"],
      expected: /metadata is missing/,
    },
    {
      id: "3".repeat(32),
      version: CANDIDATE_VERSION,
      omit: ["node_modules/next/dist/bin/next"],
      expected: /complete runnable bundle|ENOENT/,
    },
    {
      id: "4".repeat(32),
      version: "0.0.9",
      omit: [],
      expected: /identity does not match/,
    },
  ];

  for (const testCase of cases) {
    const staging = await storage.createPrivateStaging(testCase.id);
    await writeRunnableBundle(staging.candidateReference, testCase.version, { omit: testCase.omit });
    await assert.rejects(
      storage.publishCandidate(staging, CANDIDATE_VERSION),
      testCase.expected,
    );
    assert.equal(await exists(staging.candidateReference), true);
    await storage.removeStaging(staging.id);
  }
});

test("publishes, activates, resolves, and removes releases without losing bootstrap", async (t) => {
  const paths = await fixture(t);
  const storage = storageFor(paths);
  await storage.initialize();
  const staging = await storage.createPrivateStaging("5".repeat(32));
  await writeRunnableBundle(staging.candidateReference, CANDIDATE_VERSION);

  await storage.publishCandidate(staging, CANDIDATE_VERSION);
  assert.equal(await storage.versionExists(CANDIDATE_VERSION), true);
  assert.equal(await exists(staging.candidateReference), false);
  assert.equal(
    await storage.resolveVersionRoot(CANDIDATE_VERSION),
    await realpath(path.join(paths.dataRoot, "versions", CANDIDATE_VERSION)),
  );
  assert.deepEqual(
    new Set((await storage.listInstalledVersions()).map(({ version }) => version)),
    new Set([BOOTSTRAP_VERSION, CANDIDATE_VERSION]),
  );

  await storage.switchCurrentAtomically(CANDIDATE_VERSION);
  assert.equal(await storage.currentVersion(), CANDIDATE_VERSION);
  await assert.rejects(storage.removeVersion(CANDIDATE_VERSION), /active release/);

  await storage.switchCurrentAtomically(BOOTSTRAP_VERSION);
  await storage.removeVersion(CANDIDATE_VERSION);
  assert.equal(await storage.versionExists(CANDIDATE_VERSION), false);
  assert.equal(await storage.currentVersion(), BOOTSTRAP_VERSION);
  await assert.rejects(storage.removeVersion(BOOTSTRAP_VERSION), /bootstrap release/);
});

test("recovers a switched candidate by rolling back real on-disk state", async (t) => {
  const paths = await fixture(t);
  const storage = storageFor(paths);
  await storage.initialize();
  const stagingId = "6".repeat(32);
  const staging = await storage.createPrivateStaging(stagingId);
  await writeRunnableBundle(staging.candidateReference, CANDIDATE_VERSION);
  await storage.publishCandidate(staging, CANDIDATE_VERSION);
  await storage.switchCurrentAtomically(CANDIDATE_VERSION);
  await storage.writeVersionStateAtomic(canonicalizeReleaseJson({
    schemaVersion: 1,
    previousVersion: BOOTSTRAP_VERSION,
    knownGood: [
      { version: CANDIDATE_VERSION, verifiedAt: 200 },
      { version: BOOTSTRAP_VERSION, verifiedAt: 100 },
    ],
  }));
  await storage.writeJournalAtomic(canonicalizeReleaseJson({
    schemaVersion: 1,
    operationId: "a".repeat(32),
    stagingId,
    phase: "current-health",
    candidateVersion: CANDIDATE_VERSION,
    previousVersion: BOOTSTRAP_VERSION,
    startedAt: 123,
  }));

  const { publicKey } = generateKeyPairSync("ed25519");
  const healthChecks = [];
  const engine = new UpdateEngine({
    trust: createReleaseTrust({
      owner: "pihub-org",
      repo: "pihub",
      channel: "stable",
      publicKey,
    }),
    platform: "linux",
    arch: "x64",
    storage,
    extractor: {
      inspect: async () => {
        throw new Error("recovery must not inspect an archive");
      },
      extract: async () => {
        throw new Error("recovery must not extract an archive");
      },
    },
    health: {
      check: async (input) => {
        healthChecks.push({ phase: input.phase, version: input.version });
        return true;
      },
    },
    now: () => 500,
  });

  assert.deepEqual(await engine.recover(), {
    status: "rolled-back",
    version: BOOTSTRAP_VERSION,
  });
  assert.equal(await storage.currentVersion(), BOOTSTRAP_VERSION);
  assert.equal(await storage.versionExists(CANDIDATE_VERSION), false);
  assert.equal(await storage.readJournal(16 * 1024), null);
  assert.equal(await exists(path.join(paths.dataRoot, "staging", stagingId)), false);
  assert.deepEqual(healthChecks, [{ phase: "rollback", version: BOOTSTRAP_VERSION }]);
  assert.deepEqual(
    JSON.parse(await storage.readVersionState(64 * 1024)),
    {
      knownGood: [{ verifiedAt: 100, version: BOOTSTRAP_VERSION }],
      previousVersion: BOOTSTRAP_VERSION,
      schemaVersion: 1,
    },
  );
});
