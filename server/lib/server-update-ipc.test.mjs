import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ipc = await jiti.import("./server-update-ipc.ts");

const OPERATION_ID = "a".repeat(32);
const UPDATED_AT = "2026-08-19T12:00:00.000Z";

test.afterEach(() => ipc.setServerUpdateIpcTransportForTests(undefined));

test("accepts only exact supervisor snapshots for every public phase", () => {
  const states = [
    { phase: "idle", updatedAt: UPDATED_AT },
    { phase: "recovering", updatedAt: UPDATED_AT },
    { phase: "queued", operationId: OPERATION_ID, updatedAt: UPDATED_AT },
    { phase: "applying", operationId: OPERATION_ID, updatedAt: UPDATED_AT },
    { phase: "restarting", operationId: OPERATION_ID, targetVersion: "0.0.2", updatedAt: UPDATED_AT },
    { phase: "restarting", targetVersion: "0.0.1", updatedAt: UPDATED_AT },
    { phase: "succeeded", operationId: OPERATION_ID, resultVersion: "0.0.2", updatedAt: UPDATED_AT },
    { phase: "failed", operationId: OPERATION_ID, errorCode: "health_failed", updatedAt: UPDATED_AT },
  ];
  for (const update of states) {
    assert.equal(ipc.isServerUpdateSupervisorSnapshot({ currentVersion: "0.0.1", update }), true);
  }

  for (const invalid of [
    { currentVersion: "latest", update: states[0] },
    { currentVersion: "0.0.1", update: { ...states[0], extra: true } },
    { currentVersion: "0.0.1", update: { ...states[2], operationId: "A".repeat(32) } },
    { currentVersion: "0.0.1", update: { ...states[4], targetVersion: "next" } },
    { currentVersion: "0.0.1", update: { ...states[6], resultVersion: "0.0.1", phase: "queued" } },
    { currentVersion: "0.0.1", update: { ...states[7], errorCode: "Health Failed" } },
    { currentVersion: "0.0.1", update: { phase: "idle", updatedAt: "yesterday" } },
    { currentVersion: "0.0.1", update: states[0], extra: true },
  ]) {
    assert.equal(ipc.isServerUpdateSupervisorSnapshot(invalid), false);
  }
});

test("requires a queued acknowledgement with one matching operation id", () => {
  const accepted = {
    accepted: true,
    operationId: OPERATION_ID,
    update: { phase: "queued", operationId: OPERATION_ID, updatedAt: UPDATED_AT },
  };
  assert.equal(ipc.isServerUpdateAccepted(accepted), true);
  assert.equal(ipc.isServerUpdateAccepted({ ...accepted, extra: true }), false);
  assert.equal(ipc.isServerUpdateAccepted({
    ...accepted,
    update: { ...accepted.update, phase: "applying" },
  }), false);
  assert.equal(ipc.isServerUpdateAccepted({
    ...accepted,
    update: { ...accepted.update, operationId: "b".repeat(32) },
  }), false);
});

test("uses the test transport without exposing it as production state", async () => {
  const calls = [];
  ipc.setServerUpdateIpcTransportForTests(async (command) => {
    calls.push(command);
    return { ok: true };
  });
  assert.equal(ipc.isServerUpdateSupervisorAvailable(), true);
  assert.deepEqual(await ipc.requestServerUpdateSupervisor("status"), { ok: true });
  assert.deepEqual(calls, ["status"]);

  ipc.setServerUpdateIpcTransportForTests(undefined);
  if (process.connected !== true) assert.equal(ipc.isServerUpdateSupervisorAvailable(), false);
});
