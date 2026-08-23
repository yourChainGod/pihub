import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  SERVER_UPDATE_IPC_PROTOCOL,
  StableServerSupervisor,
  provisionSignedDefaultExtensions,
} = require("./server-supervisor.js");
const { INTERNAL_NEXT_SENTINEL } = require("./runtime-entry.js");

const CURRENT_VERSION = "0.0.1";
const TARGET_VERSION = "0.0.2";
const REQUEST_ID = "a".repeat(32);
const OPERATION_ID = "b".repeat(32);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class FakeChild extends EventEmitter {
  constructor({ acknowledgeImmediately = true, exitOnKill = true } = {}) {
    super();
    this.acknowledgeImmediately = acknowledgeImmediately;
    this.exitOnKill = exitOnKill;
    this.connected = true;
    this.exitCode = null;
    this.signalCode = null;
    this.sent = [];
    this.sendCallbacks = [];
    this.killSignals = [];
    this.pipeCalls = [];
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    for (const [name, stream] of [["stdout", this.stdout], ["stderr", this.stderr]]) {
      const pipe = stream.pipe.bind(stream);
      stream.pipe = (destination, options) => {
        this.pipeCalls.push({ destination, name, options });
        return pipe(destination, options);
      };
    }
  }

  send(message, callback) {
    this.sent.push(message);
    if (typeof callback === "function") {
      if (this.acknowledgeImmediately) queueMicrotask(() => callback(null));
      else this.sendCallbacks.push(callback);
    }
    return true;
  }

  acknowledge(index = 0, error = null) {
    const [callback] = this.sendCallbacks.splice(index, 1);
    assert.equal(typeof callback, "function", "expected a pending IPC acknowledgement");
    callback(error);
  }

  kill(signal) {
    this.killSignals.push(signal);
    if (!this.exitOnKill) return true;
    queueMicrotask(() => {
      if (this.exitCode !== null || this.signalCode) return;
      this.connected = false;
      this.exitCode = 0;
      this.emit("exit", 0, null);
    });
    return true;
  }
}

function createParentProcess() {
  const parent = new EventEmitter();
  parent.exitCode = undefined;
  parent.stdout = { write() {} };
  parent.stderr = { write() {} };
  return parent;
}

function createReleaseFixture(t, version = TARGET_VERSION) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-supervisor-"));
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const runtimeEntry = path.join(root, "bin", "runtime-entry.js");
  fs.mkdirSync(path.dirname(nextBin), { recursive: true });
  fs.mkdirSync(path.dirname(runtimeEntry), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "@pihub/server",
    version,
  }));
  fs.writeFileSync(nextBin, "#!/usr/bin/env node\n");
  fs.writeFileSync(runtimeEntry, "#!/usr/bin/env node\n");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

class RecordingSink extends PassThrough {
  constructor() {
    super();
    this.chunks = [];
    this.endCalls = 0;
    this.on("data", (chunk) => this.chunks.push(Buffer.from(chunk)));
  }

  end(...args) {
    this.endCalls += 1;
    return super.end(...args);
  }

  contents() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function createRuntime(overrides = {}) {
  return {
    async apply() {
      return {
        cleanupPending: false,
        previousVersion: CURRENT_VERSION,
        status: "updated",
        version: TARGET_VERSION,
      };
    },
    async currentVersion() {
      return CURRENT_VERSION;
    },
    async initialize() {},
    async recover() {
      return { status: "clean" };
    },
    storage: {
      async resolveVersionRoot(version) {
        return `/releases/${version}`;
      },
    },
    ...overrides,
  };
}

function createSupervisor({ runtime = createRuntime(), ...overrides } = {}) {
  const logs = { error: [], warn: [] };
  const supervisor = new StableServerSupervisor({
    baseRuntimeEnvironment: {},
    bootstrapPackageRoot: process.cwd(),
    bootstrapVersion: CURRENT_VERSION,
    fetchImpl: async () => new Response(JSON.stringify({
      status: "ok",
      version: CURRENT_VERSION,
    })),
    hostname: "127.0.0.1",
    logger: {
      error(message) { logs.error.push(message); },
      warn(message) { logs.warn.push(message); },
    },
    parentProcess: createParentProcess(),
    port: 30141,
    randomId: () => OPERATION_ID,
    runtimeFactory: async () => runtime,
    ...overrides,
  });
  supervisor.runtime = runtime;
  return { logs, runtime, supervisor };
}

function request(command, requestId = REQUEST_ID) {
  return {
    command,
    protocol: SERVER_UPDATE_IPC_PROTOCOL,
    requestId,
    type: "request",
  };
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("IPC status returns the runtime version and stable supervisor state", async () => {
  const now = Date.UTC(2026, 7, 19, 12, 0, 0);
  const runtime = createRuntime({
    async currentVersion() {
      return TARGET_VERSION;
    },
  });
  const { supervisor } = createSupervisor({ runtime, now: () => now });
  const child = new FakeChild();
  supervisor.currentChild = child;
  supervisor.updateState = supervisor.createUpdateState("succeeded", {
    operationId: OPERATION_ID,
    resultVersion: TARGET_VERSION,
  });

  await supervisor.handleChildMessage(child, request("status"));

  assert.deepEqual(child.sent, [{
    ok: true,
    protocol: SERVER_UPDATE_IPC_PROTOCOL,
    requestId: REQUEST_ID,
    result: {
      currentVersion: TARGET_VERSION,
      update: {
        operationId: OPERATION_ID,
        phase: "succeeded",
        resultVersion: TARGET_VERSION,
        updatedAt: new Date(now).toISOString(),
      },
    },
    type: "response",
  }]);
});

test("IPC apply acknowledges queued work before running it in the background", async () => {
  const update = deferred();
  let applyCalls = 0;
  const runtime = createRuntime({
    apply() {
      applyCalls += 1;
      return update.promise;
    },
  });
  const { supervisor } = createSupervisor({ runtime });
  const child = new FakeChild({ acknowledgeImmediately: false });
  supervisor.currentChild = child;

  await supervisor.handleChildMessage(child, request("apply"));

  assert.equal(applyCalls, 0);
  assert.equal(supervisor.updatePromise, null);
  assert.equal(supervisor.updateState.phase, "queued");
  assert.deepEqual(child.sent[0], {
    ok: true,
    protocol: SERVER_UPDATE_IPC_PROTOCOL,
    requestId: REQUEST_ID,
    result: {
      accepted: true,
      operationId: OPERATION_ID,
      update: {
        operationId: OPERATION_ID,
        phase: "queued",
        updatedAt: child.sent[0].result.update.updatedAt,
      },
    },
    type: "response",
  });

  child.acknowledge();
  assert.equal(applyCalls, 0, "update execution must not run in the IPC callback stack");
  await immediate();
  assert.equal(applyCalls, 1);
  assert.ok(supervisor.updatePromise instanceof Promise);
  assert.equal(supervisor.updateState.phase, "applying");

  update.resolve({
    cleanupPending: false,
    previousVersion: CURRENT_VERSION,
    status: "updated",
    version: TARGET_VERSION,
  });
  await supervisor.updatePromise;
  assert.equal(supervisor.updatePromise, null);
  assert.deepEqual(supervisor.snapshotState(), {
    operationId: OPERATION_ID,
    phase: "succeeded",
    resultVersion: TARGET_VERSION,
    updatedAt: supervisor.updateState.updatedAt,
  });
});

test("a second apply is rejected while the accepted update is still queued", async () => {
  const update = deferred();
  const runtime = createRuntime({ apply: () => update.promise });
  const { supervisor } = createSupervisor({ runtime });
  const child = new FakeChild({ acknowledgeImmediately: false });
  supervisor.currentChild = child;

  await supervisor.handleChildMessage(child, request("apply", "c".repeat(32)));
  await supervisor.handleChildMessage(child, request("apply", "d".repeat(32)));

  assert.equal(supervisor.updatePromise, null);
  assert.equal(supervisor.updateState.phase, "queued");
  assert.equal(child.sent[0].ok, true);
  assert.deepEqual(child.sent[1], {
    error: {
      code: "concurrent_update",
      message: "Another release update is already running",
    },
    ok: false,
    protocol: SERVER_UPDATE_IPC_PROTOCOL,
    requestId: "d".repeat(32),
    type: "response",
  });

  child.acknowledge();
  await immediate();
  update.resolve({ version: TARGET_VERSION });
  await supervisor.updatePromise;
});

test("a failed IPC acknowledgement cancels queued work without applying it", async () => {
  let applyCalls = 0;
  const runtime = createRuntime({
    async apply() {
      applyCalls += 1;
      return { version: TARGET_VERSION };
    },
  });
  const { supervisor } = createSupervisor({ runtime });
  const child = new FakeChild({ acknowledgeImmediately: false });
  supervisor.currentChild = child;

  await supervisor.handleChildMessage(child, request("apply"));
  child.acknowledge(0, new Error("IPC channel closed"));
  await immediate();

  assert.equal(applyCalls, 0);
  assert.equal(supervisor.updatePromise, null);
  assert.deepEqual(supervisor.snapshotState(), {
    errorCode: "update_request_disconnected",
    operationId: OPERATION_ID,
    phase: "failed",
    updatedAt: supervisor.updateState.updatedAt,
  });
});

test("candidate health rejects an ok response for a different exact version and stops it", async () => {
  const child = new FakeChild();
  const fetches = [];
  let provisionCalls = 0;
  const { supervisor } = createSupervisor({
    defaultExtensionsEnabled: true,
    extensionProvisioner: async () => {
      provisionCalls += 1;
      throw new Error("candidate health must not provision extensions");
    },
    fetchImpl: async (url, init) => {
      fetches.push({ init, url });
      return new Response(JSON.stringify({
        authentication: "required",
        status: "ok",
        version: CURRENT_VERSION,
      }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  });
  const spawns = [];
  supervisor.spawnServer = (...args) => {
    spawns.push(args);
    return child;
  };

  await assert.rejects(
    supervisor.checkReleaseHealth({
      deadlineAt: Date.now() + 100,
      packageRoot: "/candidate-release",
      phase: "candidate",
      signal: new AbortController().signal,
      version: TARGET_VERSION,
    }),
    /different release version/,
  );

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0][0], "/candidate-release");
  assert.equal(spawns[0][1], TARGET_VERSION);
  assert.ok(Number.isInteger(spawns[0][2]) && spawns[0][2] > 0);
  assert.deepEqual(spawns[0][3], { candidate: true, ipc: false });
  assert.ok(fetches.length >= 1);
  assert.match(fetches[0].url, /^http:\/\/127\.0\.0\.1:\d+\/api\/health$/);
  assert.equal(new Headers(fetches[0].init.headers).get("authorization"), null);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(provisionCalls, 0);
});

test("current activation and rollback each stop the old child and verify the replacement", async () => {
  const provisions = [];
  const { supervisor } = createSupervisor({
    defaultExtensionsEnabled: true,
    extensionProvisioner: async (packageRoot) => {
      provisions.push(packageRoot);
      return {
        rollback: async () => undefined,
        status: { installed: true, installedCount: 7, source: "signed-release", total: 7 },
      };
    },
  });
  const firstChild = new FakeChild();
  supervisor.currentChild = firstChild;
  supervisor.currentChildVersion = CURRENT_VERSION;
  supervisor.updateState = supervisor.createUpdateState("applying", { operationId: OPERATION_ID });
  const stops = [];
  const spawns = [];
  const healthChecks = [];

  supervisor.stopChild = async (child) => {
    stops.push(child);
    if (supervisor.currentChild === child) {
      supervisor.currentChild = null;
      supervisor.currentChildVersion = null;
    }
  };
  supervisor.spawnServer = (packageRoot, version, port, options) => {
    const child = new FakeChild();
    spawns.push({ child, options, packageRoot, port, version });
    supervisor.currentChild = child;
    supervisor.currentChildVersion = version;
    return child;
  };
  supervisor.waitForExactHealth = async (...args) => {
    healthChecks.push(args);
    return true;
  };

  const signal = new AbortController().signal;
  assert.equal(await supervisor.checkReleaseHealth({
    deadlineAt: 10_000,
    packageRoot: "/candidate-release",
    phase: "current",
    signal,
    version: TARGET_VERSION,
  }), true);
  const candidateChild = supervisor.currentChild;
  assert.equal(await supervisor.checkReleaseHealth({
    deadlineAt: 20_000,
    packageRoot: "/rollback-release",
    phase: "rollback",
    signal,
    version: CURRENT_VERSION,
  }), true);

  assert.deepEqual(stops, [firstChild, candidateChild]);
  assert.deepEqual(provisions, ["/candidate-release", "/rollback-release"]);
  assert.deepEqual(spawns.map(({ options, packageRoot, port, version }) => ({
    options,
    packageRoot,
    port,
    version,
  })), [
    {
      options: { ipc: true },
      packageRoot: "/candidate-release",
      port: 30141,
      version: TARGET_VERSION,
    },
    {
      options: { ipc: true },
      packageRoot: "/rollback-release",
      port: 30141,
      version: CURRENT_VERSION,
    },
  ]);
  assert.deepEqual(healthChecks.map(([, port, version, deadlineAt]) => ({
    deadlineAt,
    port,
    version,
  })), [
    { deadlineAt: 10_000, port: 30141, version: TARGET_VERSION },
    { deadlineAt: 20_000, port: 30141, version: CURRENT_VERSION },
  ]);
  assert.deepEqual(supervisor.snapshotState(), {
    operationId: OPERATION_ID,
    phase: "restarting",
    targetVersion: CURRENT_VERSION,
    updatedAt: supervisor.updateState.updatedAt,
  });
});

test("supervisor forwards the persisted extension subset on restart", async () => {
  const selected = [{ name: "pi-todo-rail", version: "0.2.3" }];
  let provisionOptions;
  const { supervisor } = createSupervisor({
    defaultExtensionsEnabled: true,
    selectedDefaultExtensions: selected,
    extensionProvisioner: async (_packageRoot, options) => {
      provisionOptions = options;
      return {
        rollback: async () => undefined,
        status: {
          installed: false,
          installedCount: 1,
          source: "signed-release",
          total: 7,
          packages: [
            { name: "@cortexkit/pi-magic-context", installed: false },
            { name: "pi-todo-rail", installed: true },
            { name: "@ff-labs/pi-fff", installed: false },
            { name: "pi-simplify", installed: false },
            { name: "@gotgenes/pi-permission-system", installed: false },
            { name: "@eko24ive/pi-ask", installed: false },
            { name: "@gotgenes/pi-subagents", installed: false },
          ],
        },
      };
    },
  });

  await supervisor.provisionCurrentExtensions("/current-release");
  assert.deepEqual(provisionOptions.selectedPackages, selected);
});

test("signed default extension provisioner preserves the persisted selection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-supervisor-provisioner-"));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const marker = path.join(root, "selected.json");
  fs.writeFileSync(path.join(root, "bin", "default-extensions.js"), [
    "module.exports = { provisionDefaultExtensions: async (_root, options) => {",
    `  require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(options));`,
    "  return async () => undefined;",
    "} };",
  ].join("\n"));

  const selected = [{ name: "pi-todo-rail", version: "0.2.3" }];
  const environment = { PIHUB_TEST_SELECTION: "test" };
  const rollback = await provisionSignedDefaultExtensions(root, {
    environment,
    expectedPackages: selected,
    selectedPackages: selected,
    home: "/tmp/pihub-test-home",
  });
  assert.equal(typeof rollback, "function");
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), {
    environment,
    expectedPackages: selected,
    selectedPackages: selected,
    home: "/tmp/pihub-test-home",
  });
});

test("startup repairs default extensions before spawning and restores their exact snapshot on health failure", async () => {
  const events = [];
  const runtime = createRuntime({
    storage: {
      async resolveVersionRoot(version) {
        assert.equal(version, CURRENT_VERSION);
        return "/current-release";
      },
    },
  });
  const { supervisor } = createSupervisor({
    defaultExtensionsEnabled: true,
    extensionProvisioner: async (packageRoot) => {
      events.push(["provision", packageRoot]);
      return {
        rollback: async () => { events.push(["rollback", packageRoot]); },
        status: { installed: true, installedCount: 7, source: "signed-release", total: 7 },
      };
    },
    runtime,
  });
  const child = new FakeChild();
  supervisor.spawnServer = (packageRoot) => {
    events.push(["spawn", packageRoot]);
    supervisor.currentChild = child;
    return child;
  };
  supervisor.waitForExactHealth = async () => {
    events.push(["health"]);
    throw new Error("health canary failure");
  };
  supervisor.stopChild = async () => {
    events.push(["stop"]);
    supervisor.currentChild = null;
  };

  await assert.rejects(supervisor.ensureCurrentRunning(), /health canary failure/);

  assert.deepEqual(events, [
    ["provision", "/current-release"],
    ["spawn", "/current-release"],
    ["health"],
    ["stop"],
    ["rollback", "/current-release"],
  ]);
});

test("force-stop rejects within a bounded window when SIGKILL never produces exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { supervisor } = createSupervisor();
  const child = new FakeChild({ exitOnKill: false });
  supervisor.currentChild = child;
  supervisor.currentChildVersion = CURRENT_VERSION;
  supervisor.candidateChildren.add(child);

  const stopped = assert.rejects(
    supervisor.stopChild(child),
    /did not exit after it was force-stopped/,
  );
  assert.deepEqual(child.killSignals, ["SIGTERM"]);

  t.mock.timers.tick(4_999);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  t.mock.timers.tick(1);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  t.mock.timers.tick(1_999);
  assert.equal(supervisor.currentChild, child);
  t.mock.timers.tick(1);
  await stopped;

  assert.equal(supervisor.currentChild, null);
  assert.equal(supervisor.currentChildVersion, null);
  assert.equal(supervisor.candidateChildren.has(child), false);
});

test("log sinks are reused with end disabled and close exactly once on shutdown", async (t) => {
  const packageRoot = createReleaseFixture(t);
  const stdoutLogSink = new RecordingSink();
  const stderrLogSink = new RecordingSink();
  const children = [];
  const { supervisor } = createSupervisor({
    stderrLogSink,
    stdoutLogSink,
    spawnImpl() {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });

  const first = supervisor.spawnServer(packageRoot, TARGET_VERSION, 30141, { ipc: true });
  first.stdout.write("first-out\n");
  first.stderr.write("first-error\n");
  first.stdout.end();
  first.stderr.end();
  await supervisor.stopChild(first);

  assert.equal(stdoutLogSink.writableEnded, false);
  assert.equal(stderrLogSink.writableEnded, false);
  assert.equal(stdoutLogSink.endCalls, 0);
  assert.equal(stderrLogSink.endCalls, 0);

  const second = supervisor.spawnServer(packageRoot, TARGET_VERSION, 30141, { ipc: true });
  second.stdout.write("second-out\n");
  second.stderr.write("second-error\n");
  second.stdout.end();
  second.stderr.end();

  assert.equal(children.length, 2);
  for (const child of children) {
    assert.deepEqual(child.pipeCalls.map(({ destination, name, options }) => ({
      isExpectedSink: destination === (name === "stdout" ? stdoutLogSink : stderrLogSink),
      name,
      options,
    })), [
      { isExpectedSink: true, name: "stdout", options: { end: false } },
      { isExpectedSink: true, name: "stderr", options: { end: false } },
    ]);
  }
  assert.equal(stdoutLogSink.contents(), "first-out\nsecond-out\n");
  assert.equal(stderrLogSink.contents(), "first-error\nsecond-error\n");
  assert.equal(stdoutLogSink.writableEnded, false);
  assert.equal(stderrLogSink.writableEnded, false);

  await supervisor.shutdown();

  assert.equal(stdoutLogSink.endCalls, 1);
  assert.equal(stderrLogSink.endCalls, 1);
  assert.equal(stdoutLogSink.writableEnded, true);
  assert.equal(stderrLogSink.writableEnded, true);
});

test("spawned releases receive required configuration but no base-environment secret canaries", (t) => {
  const packageRoot = createReleaseFixture(t);
  const secretCanaries = {
    AWS_SECRET_ACCESS_KEY: "aws-secret-canary",
    DATABASE_URL: "postgres://private-canary",
    GH_TOKEN: "github-token-canary",
    HTTPS_PROXY: "http://proxy-user:proxy-secret@proxy.invalid",
    NODE_OPTIONS: "--require=/tmp/untrusted-canary.js",
    NPM_TOKEN: "npm-token-canary",
    OPENAI_API_KEY: "provider-key-canary",
    PIHUB_AUTH_SECRET: "auth-secret-canary",
    PIHUB_FUTURE_TOKEN: "future-token-canary",
    PIHUB_LOG_DIRECTORY: "/private/log-canary",
    PIHUB_RELEASE_PUBLIC_KEY: "release-key-canary",
  };
  let spawnOptions;
  const { supervisor } = createSupervisor({
    baseRuntimeEnvironment: {
      HOME: "/home/pi",
      PATH: "/safe/bin",
      PI_WEB_PASSWORD: "required-server-password",
      PIHUB_SERVER_PASSWORD: "required-pihub-server-password",
      PIHUB_AUTH_STATE_PATH: "/home/pi/.pihub/auth.json",
      PIHUB_SERVER_ROOT: "/attacker/root",
      PIHUB_SERVER_VERSION: "999.0.0",
      ...secretCanaries,
    },
    spawnImpl(command, args, options) {
      spawnOptions = { args, command, options };
      return new FakeChild();
    },
    tailnetHostname: "server.example.ts.net",
  });

  supervisor.spawnServer(packageRoot, TARGET_VERSION, 30141, { ipc: true });

  assert.equal(spawnOptions.command, process.execPath);
  assert.equal(
    spawnOptions.args[0],
    path.join(packageRoot, "bin", "runtime-entry.js"),
  );
  assert.deepEqual(spawnOptions.args.slice(1), [
    INTERNAL_NEXT_SENTINEL,
    "start",
    "-p",
    "30141",
    "-H",
    "127.0.0.1",
  ]);
  assert.equal(spawnOptions.options.env.NODE_ENV, "production");
  assert.equal(spawnOptions.options.env.PATH, "/safe/bin");
  assert.equal(spawnOptions.options.env.PI_WEB_PASSWORD, "required-server-password");
  assert.equal(spawnOptions.options.env.PIHUB_SERVER_PASSWORD, "required-pihub-server-password");
  assert.equal(spawnOptions.options.env.PIHUB_AUTH_STATE_PATH, "/home/pi/.pihub/auth.json");
  assert.equal(spawnOptions.options.env.PIHUB_SERVER_HOSTNAME, "127.0.0.1");
  assert.equal(spawnOptions.options.env.PI_WEB_HOSTNAME, "127.0.0.1");
  assert.equal(spawnOptions.options.env.PIHUB_SERVER_ROOT, packageRoot);
  assert.equal(spawnOptions.options.env.PIHUB_SERVER_VERSION, TARGET_VERSION);
  assert.equal(spawnOptions.options.env.PIHUB_TAILNET_HOSTNAME, "server.example.ts.net");
  for (const [name, canary] of Object.entries(secretCanaries)) {
    assert.equal(Object.hasOwn(spawnOptions.options.env, name), false, name);
    assert.equal(Object.values(spawnOptions.options.env).includes(canary), false, canary);
  }
});

test("spawn errors and already-exited children never leave stale supervisor references", (t) => {
  const packageRoot = createReleaseFixture(t);
  const children = [];
  const { supervisor } = createSupervisor({
    spawnImpl() {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });
  let restartCalls = 0;
  supervisor.scheduleRestart = () => {
    restartCalls += 1;
  };

  const current = supervisor.spawnServer(packageRoot, TARGET_VERSION, 30141, { ipc: true });
  current.exitCode = -2;
  current.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }));
  current.emit("close", -2, null);
  assert.equal(supervisor.currentChild, null);
  assert.equal(supervisor.currentChildVersion, null);
  assert.equal(restartCalls, 1);

  const candidate = supervisor.spawnServer(packageRoot, TARGET_VERSION, 30142, { candidate: true, ipc: false });
  candidate.exitCode = -2;
  candidate.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" }));
  candidate.emit("close", -2, null);
  assert.equal(supervisor.candidateChildren.has(candidate), false);

  supervisor.currentChild = candidate;
  supervisor.currentChildVersion = TARGET_VERSION;
  supervisor.candidateChildren.add(candidate);
  return supervisor.stopChild(candidate).then(() => {
    assert.equal(supervisor.currentChild, null);
    assert.equal(supervisor.currentChildVersion, null);
    assert.equal(supervisor.candidateChildren.has(candidate), false);
    assert.equal(children.length, 2);
  });
});

test("a child exit during an update defers restart until the update settles", async () => {
  const update = deferred();
  const runtime = createRuntime({ apply: () => update.promise });
  const { logs, supervisor } = createSupervisor({ runtime });
  const child = new FakeChild();
  supervisor.currentChild = child;
  supervisor.currentChildVersion = CURRENT_VERSION;
  let scheduledRestarts = 0;
  supervisor.scheduleRestart = () => {
    scheduledRestarts += 1;
  };

  supervisor.runAcceptedUpdate(OPERATION_ID);
  const activeUpdate = supervisor.updatePromise;
  supervisor.handleCurrentExit(child, 23, null);

  assert.equal(supervisor.currentChild, null);
  assert.equal(supervisor.currentChildVersion, null);
  assert.equal(scheduledRestarts, 0);
  assert.deepEqual(logs.error, []);

  update.resolve({ version: TARGET_VERSION });
  await activeUpdate;

  assert.equal(supervisor.updatePromise, null);
  assert.equal(scheduledRestarts, 1);
  assert.equal(supervisor.updateState.phase, "succeeded");
});

test("an unexpected current-child exit schedules a restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { logs, supervisor } = createSupervisor();
  const child = new FakeChild();
  supervisor.currentChild = child;
  supervisor.currentChildVersion = CURRENT_VERSION;
  let restartCalls = 0;
  supervisor.ensureCurrentRunning = async () => {
    restartCalls += 1;
  };

  supervisor.handleCurrentExit(child, 17, null);

  assert.equal(supervisor.currentChild, null);
  assert.equal(supervisor.currentChildVersion, null);
  assert.equal(restartCalls, 0);
  assert.ok(supervisor.restartTimer);
  assert.match(logs.error[0], /exited unexpectedly \(17\); restarting/);

  t.mock.timers.tick(249);
  assert.equal(restartCalls, 0);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(restartCalls, 1);
  assert.equal(supervisor.restartTimer, null);
});

test("malformed, unauthorized, and non-request IPC messages are ignored", async () => {
  let applyCalls = 0;
  const runtime = createRuntime({
    async apply() {
      applyCalls += 1;
      return { version: TARGET_VERSION };
    },
  });
  const { supervisor } = createSupervisor({ runtime });
  const child = new FakeChild();
  const impostor = new FakeChild();
  supervisor.currentChild = child;
  const invalidMessages = [
    null,
    [],
    { ...request("status"), protocol: "pihub-server-update-v0" },
    { ...request("status"), type: "response" },
    { ...request("status"), requestId: "A".repeat(32) },
    { ...request("status"), command: "delete" },
    { ...request("status"), extra: true },
  ];

  for (const message of invalidMessages) {
    await supervisor.handleChildMessage(child, message);
  }
  await supervisor.handleChildMessage(impostor, request("apply"));

  assert.equal(child.sent.length, 0);
  assert.equal(impostor.sent.length, 0);
  assert.equal(applyCalls, 0);
  assert.equal(supervisor.updateState.phase, "idle");
});

test("relay connector spawn is gated by connectorConfigured and restarts on crash only", async () => {
  const spawned = [];
  const make = (connectorConfigured) => createSupervisor({
    connectorConfigured,
    spawnImpl(command, args, options) {
      const child = new FakeChild();
      spawned.push({ child, command, args, options });
      return child;
    },
  });

  // Not configured: nothing spawns.
  const off = make(() => false);
  off.supervisor.spawnConnector(process.cwd(), CURRENT_VERSION);
  assert.equal(spawned.length, 0);

  // Configured: spawns bin/pihub-connector.js from the same package root.
  const on = make(() => true);
  on.supervisor.spawnConnector(process.cwd(), CURRENT_VERSION);
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args[0].endsWith(path.join("bin", "pihub-connector.js")));
  assert.equal(spawned[0].options.cwd, process.cwd());

  // Clean exit (code 0, e.g. "not configured"): no restart is scheduled.
  spawned[0].child.emit("exit", 0, null);
  await immediate();
  assert.equal(spawned.length, 1);

  // Crash: a restart is scheduled (fires after a delay, not immediately).
  on.supervisor.currentChild = new FakeChild();
  on.supervisor.spawnConnector(process.cwd(), CURRENT_VERSION);
  assert.equal(spawned.length, 2);
  spawned[1].child.emit("exit", 1, null);
  await immediate();
  assert.equal(spawned.length, 2, "restart waits for the delay");
  await new Promise((resolve) => setTimeout(resolve, 5_300));
  assert.equal(spawned.length, 3, "crash restart fired");

  // Shutdown stops the connector and suppresses restarts.
  spawned[2].child.emit("exit", 1, null);
  await immediate();
  const before = spawned.length;
  on.supervisor.shuttingDown = true;
  await new Promise((resolve) => setTimeout(resolve, 5_300));
  assert.equal(spawned.length, before, "no restart during shutdown");
}, { timeout: 20_000 });
