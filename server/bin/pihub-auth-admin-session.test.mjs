import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const authStore = await jiti.import("../lib/pihub-auth-store.ts");
const ownership = await jiti.import("../lib/session-ownership.ts");

const SESSION_A = "550e8400-e29b-41d4-a716-446655440000";
const SESSION_B = "550e8400-e29b-41d4-a716-446655440001";
const SESSION_C = "550e8400-e29b-41d4-a716-446655440002";

function createRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-auth-admin-sessions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function createDevice(statePath, label) {
  const pairing = await authStore.issuePihubPairingCode({
    label,
    capabilities: ["sessions:read", "sessions:write"],
    ttlMs: 60_000,
  }, { statePath });
  const device = await authStore.claimPihubPairingCode(pairing.code, { statePath });
  assert.ok(device);
  return device;
}

function writeSessions(agentDir, cwd, sessionIds) {
  const sessionDir = path.join(agentDir, "sessions", "--test-project--");
  fs.mkdirSync(sessionDir, { recursive: true });
  sessionIds.forEach((sessionId, index) => {
    const timestamp = new Date(1_800_000_000_000 + index * 1_000).toISOString();
    fs.writeFileSync(
      path.join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp,
        cwd,
      })}\n`,
    );
  });
}

function runAdmin({ agentDir, statePath, ownershipPath, input }) {
  return spawnSync(process.execPath, [
    path.join(process.cwd(), "bin", "pihub-auth-admin.js"),
    "claim-sessions",
    "--state", statePath,
    "--ownership-state", ownershipPath,
    "--input", "-",
    "--output", "-",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
    },
    input: JSON.stringify(input),
    encoding: "utf8",
  });
}

test("claim-sessions migrates only real sessions to an active device without stealing", async (t) => {
  const root = createRoot(t);
  const statePath = path.join(root, "auth", "auth.json");
  const ownershipPath = path.join(root, "ownership", "session-ownership.json");
  const agentDir = path.join(root, "agent");
  writeSessions(agentDir, root, [SESSION_A, SESSION_B, SESSION_C]);
  const firstDevice = await createDevice(statePath, "First device");
  const secondDevice = await createDevice(statePath, "Second device");

  const explicit = runAdmin({
    agentDir,
    statePath,
    ownershipPath,
    input: { deviceId: firstDevice.id, sessionIds: [SESSION_A] },
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.deepEqual(JSON.parse(explicit.stdout), {
    deviceId: firstDevice.id,
    claimedSessionIds: [SESSION_A],
    alreadyOwnedSessionIds: [],
  });
  assert.equal(ownership.getSessionOwner(SESSION_A, { statePath: ownershipPath }), firstDevice.id);

  const unknownSession = "550e8400-e29b-41d4-a716-446655440099";
  const unknown = runAdmin({
    agentDir,
    statePath,
    ownershipPath,
    input: { deviceId: firstDevice.id, sessionIds: [unknownSession] },
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Session not found/);
  assert.equal(ownership.getSessionOwner(unknownSession, { statePath: ownershipPath }), null);

  await ownership.bindSessionOwner(SESSION_B, secondDevice.id, { statePath: ownershipPath });
  const contested = runAdmin({
    agentDir,
    statePath,
    ownershipPath,
    input: { deviceId: firstDevice.id, sessionIds: [SESSION_C, SESSION_B] },
  });
  assert.notEqual(contested.status, 0);
  assert.match(contested.stderr, /already owned by another device/);
  assert.equal(ownership.getSessionOwner(SESSION_C, { statePath: ownershipPath }), null);
  assert.equal(ownership.getSessionOwner(SESSION_B, { statePath: ownershipPath }), secondDevice.id);

  const claimAll = runAdmin({
    agentDir,
    statePath,
    ownershipPath,
    input: { deviceId: firstDevice.id, claimAllUnowned: true },
  });
  assert.equal(claimAll.status, 0, claimAll.stderr);
  assert.deepEqual(JSON.parse(claimAll.stdout), {
    deviceId: firstDevice.id,
    claimedSessionIds: [SESSION_C],
    alreadyOwnedSessionIds: [],
  });
  assert.equal(ownership.getSessionOwner(SESSION_C, { statePath: ownershipPath }), firstDevice.id);

  await authStore.revokePihubDevice(firstDevice.id, {
    statePath,
    allowLastManagerRevocation: true,
  });
  const revoked = runAdmin({
    agentDir,
    statePath,
    ownershipPath,
    input: { deviceId: firstDevice.id, sessionIds: [SESSION_A] },
  });
  assert.notEqual(revoked.status, 0);
  assert.match(revoked.stderr, /active device is required/);
});

test("claim-sessions requires exactly one bounded JSON selection", async (t) => {
  const root = createRoot(t);
  const statePath = path.join(root, "auth", "auth.json");
  const ownershipPath = path.join(root, "ownership", "session-ownership.json");
  const agentDir = path.join(root, "agent");
  writeSessions(agentDir, root, [SESSION_A]);
  const device = await createDevice(statePath, "Device");

  for (const input of [
    { deviceId: device.id },
    { deviceId: device.id, sessionIds: [SESSION_A], claimAllUnowned: true },
    { deviceId: device.id, sessionIds: [] },
    { deviceId: device.id, claimAllUnowned: false },
    { deviceId: device.id, sessionIds: [SESSION_A], unknown: true },
  ]) {
    const result = runAdmin({ agentDir, statePath, ownershipPath, input });
    assert.notEqual(result.status, 0, JSON.stringify(input));
    assert.equal(result.stdout, "");
  }
  assert.equal(ownership.getSessionOwner(SESSION_A, { statePath: ownershipPath }), null);
});
