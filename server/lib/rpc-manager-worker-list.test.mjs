import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { getRpcSessionInfos } = await jiti.import("./rpc-manager.ts");

function workerStubWrapper(overrides = {}) {
  return {
    ownerId: "dev_AAAAAAAAAAAAAAAAAAAAAA",
    sessionId: "worker-session-1",
    sessionFile: "",
    cwd: "/tmp",
    isAlive: () => true,
    isRunning: () => true,
    inner: {
      // The process-isolated stub: no getEntries/getHeader/getSessionFile.
      sessionManager: {
        getCwd: () => "/tmp",
        getBranch: () => [],
      },
    },
    ...overrides,
  };
}

test("getRpcSessionInfos tolerates process-isolated worker stubs", (t) => {
  const registry = new Map();
  globalThis.__piSessions = registry;
  t.after(() => { globalThis.__piSessions = undefined; });

  registry.set("worker-session-1", workerStubWrapper());
  const infos = getRpcSessionInfos();
  assert.equal(infos.length, 1);
  assert.equal(infos[0].id, "worker-session-1");
  assert.equal(infos[0].transient, true);
});

test("getRpcSessionInfos skips idle unsaved worker sessions", (t) => {
  const registry = new Map();
  globalThis.__piSessions = registry;
  t.after(() => { globalThis.__piSessions = undefined; });

  registry.set("worker-session-1", workerStubWrapper({ isRunning: () => false }));
  assert.deepEqual(getRpcSessionInfos(), []);
});
