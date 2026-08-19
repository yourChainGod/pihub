import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const ownership = await jiti.import("./session-ownership.ts");

const SESSION_A = "550e8400-e29b-41d4-a716-446655440000";
const SESSION_B = "550e8400-e29b-41d4-a716-446655440001";
const SESSION_C = "550e8400-e29b-41d4-a716-446655440002";
const OWNER_A = "dev_AAAAAAAAAAAAAAAAAAAAAA";
const OWNER_B = "dev_BBBBBBBBBBBBBBBBBBBBBB";

function createState(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-session-ownership-"));
  const statePath = path.join(root, "private", "session-ownership.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, statePath };
}

test("binds sessions idempotently and rejects ownership theft", async (t) => {
  const { statePath } = createState(t);
  const first = await ownership.bindSessionOwner(SESSION_A, OWNER_A, {
    statePath,
    now: 1_800_000_000_000,
  });
  const repeated = await ownership.bindSessionOwner(SESSION_A, OWNER_A, {
    statePath,
    now: 1_800_000_001_000,
  });

  assert.equal(first, true);
  assert.equal(repeated, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).ownerships[SESSION_A], {
    sessionId: SESSION_A,
    ownerId: OWNER_A,
    claimedAt: 1_800_000_000_000,
  });
  assert.equal(ownership.getSessionOwner(SESSION_A, { statePath }), OWNER_A);
  assert.equal(ownership.isSessionOwnedBy(SESSION_A, OWNER_A, { statePath }), true);
  assert.equal(ownership.isSessionOwnedBy(SESSION_A, OWNER_B, { statePath }), false);
  await assert.rejects(
    ownership.bindSessionOwner(SESSION_A, OWNER_B, { statePath }),
    (error) => error?.name === "SessionOwnershipConflictError",
  );

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  }
});

test("bulk claims are all-or-none and preserve original claim metadata", async (t) => {
  const { statePath } = createState(t);
  await ownership.bindSessionOwner(SESSION_B, OWNER_B, {
    statePath,
    now: 1_800_000_000_000,
  });

  await assert.rejects(
    ownership.claimUnownedSessions([SESSION_A, SESSION_B], OWNER_A, {
      statePath,
      now: 1_800_000_001_000,
    }),
    (error) => error?.name === "SessionOwnershipConflictError",
  );
  assert.equal(ownership.getSessionOwner(SESSION_A, { statePath }), null);
  assert.equal(ownership.getSessionOwner(SESSION_B, { statePath }), OWNER_B);

  await ownership.bindSessionOwner(SESSION_A, OWNER_A, {
    statePath,
    now: 1_800_000_002_000,
  });
  const result = await ownership.claimUnownedSessions([SESSION_A, SESSION_C], OWNER_A, {
    statePath,
    now: 1_800_000_003_000,
  });
  assert.deepEqual(result.alreadyOwned, [SESSION_A]);
  assert.deepEqual(result.claimed, [SESSION_C]);
  assert.deepEqual(
    [...ownership.getSessionOwners([SESSION_C, SESSION_A], { statePath }).keys()],
    [SESSION_C, SESSION_A],
  );
  assert.equal(ownership.getSessionOwners(undefined, { statePath }).size, 3);
});

test("removal requires the expected owner and is idempotent when absent", async (t) => {
  const { statePath } = createState(t);
  await ownership.bindSessionOwner(SESSION_A, OWNER_A, { statePath });
  await assert.rejects(
    ownership.removeSessionOwner(SESSION_A, OWNER_B, { statePath }),
    (error) => error?.name === "SessionOwnershipConflictError",
  );
  assert.equal(await ownership.removeSessionOwner(SESSION_A, OWNER_A, { statePath }), true);
  assert.equal(await ownership.removeSessionOwner(SESSION_A, OWNER_A, { statePath }), false);
});

test("rejects malformed identifiers, corrupt state, oversized files, and symlinks", async (t) => {
  const { root, statePath } = createState(t);
  assert.equal(ownership.getSessionOwner("../session", { statePath }), null);
  assert.equal(ownership.isSessionOwnedBy(SESSION_A, "dev_invalid", { statePath }), false);
  await assert.rejects(
    ownership.bindSessionOwner("../session", OWNER_A, { statePath }),
    (error) => error?.name === "SessionOwnershipInputError",
  );
  await assert.rejects(
    ownership.bindSessionOwner(SESSION_A, "dev_invalid", { statePath }),
    (error) => error?.name === "SessionOwnershipInputError",
  );
  await assert.rejects(
    ownership.claimUnownedSessions([SESSION_A, SESSION_A], OWNER_A, { statePath }),
    (error) => error?.name === "SessionOwnershipInputError",
  );
  await ownership.bindSessionOwner(SESSION_A, OWNER_A, { statePath });
  assert.deepEqual(
    [...ownership.getSessionOwners(["../session", SESSION_A], { statePath }).entries()],
    [[SESSION_A, OWNER_A]],
  );

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, ownerships: { bad: {} } }));
  assert.throws(
    () => ownership.getSessionOwners(undefined, { statePath }),
    /Invalid PiHub session ownership state/,
  );

  fs.writeFileSync(statePath, "x".repeat(2 * 1024 * 1024 + 1));
  assert.throws(
    () => ownership.getSessionOwners(undefined, { statePath }),
    /Invalid PiHub session ownership state/,
  );

  if (process.platform !== "win32") {
    fs.rmSync(statePath);
    const target = path.join(root, "target.json");
    fs.writeFileSync(target, JSON.stringify({ version: 1, ownerships: {} }));
    fs.symlinkSync(target, statePath);
    assert.throws(
      () => ownership.getSessionOwners(undefined, { statePath }),
      /Invalid PiHub session ownership state/,
    );
  }
});

test("resolves explicit, environment, and agent-directory state paths", (t) => {
  const { root } = createState(t);
  const explicit = path.join(root, "explicit.json");
  const fromEnvironment = path.join(root, "environment.json");
  const previousOwnershipPath = process.env.PIHUB_SESSION_OWNERSHIP_PATH;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previousOwnershipPath === undefined) delete process.env.PIHUB_SESSION_OWNERSHIP_PATH;
    else process.env.PIHUB_SESSION_OWNERSHIP_PATH = previousOwnershipPath;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  delete process.env.PIHUB_SESSION_OWNERSHIP_PATH;
  assert.equal(
    ownership.getSessionOwnershipStatePath(),
    path.resolve(root, "agent", "session-ownership.json"),
  );
  process.env.PIHUB_SESSION_OWNERSHIP_PATH = fromEnvironment;
  assert.equal(ownership.getSessionOwnershipStatePath(), path.resolve(fromEnvironment));
  assert.equal(ownership.getSessionOwnershipStatePath(explicit), path.resolve(explicit));
});
