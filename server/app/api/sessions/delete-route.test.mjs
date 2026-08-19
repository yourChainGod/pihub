import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { DELETE } = await jiti.import("./[id]/route.ts");
const ownership = await jiti.import("../../../lib/session-ownership.ts");
const sessionReader = await jiti.import("../../../lib/session-reader.ts");

const OWNER_ID = `dev_${"A".repeat(22)}`;
const OTHER_OWNER_ID = `dev_${"B".repeat(22)}`;
const TARGET_ID = "60000000-0000-4000-8000-000000000001";
const CHILD_ID = "60000000-0000-4000-8000-000000000002";
const TRANSIENT_ID = "60000000-0000-4000-8000-000000000003";

function trustedDeleteRequest(sessionId, ownerId = OWNER_ID) {
  return new Request(`http://localhost/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: {
      "x-pihub-authenticated-device": ownerId,
      "x-pihub-authenticated-capabilities": "sessions:write",
    },
  });
}

function sessionFile(id, cwd, parentSession) {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
    ...(parentSession ? { parentSession } : {}),
  })}\n${JSON.stringify({
    type: "message",
    id: `${id}-message`,
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: "preserve me" },
  })}\n`;
}

test("DELETE atomically reparents owned children, clears ownership, and handles transient sessions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pihub-session-delete-route-"));
  const targetPath = join(root, "target.jsonl");
  const childPath = join(root, "child.jsonl");
  const ownershipPath = join(root, "ownership", "session-ownership.json");
  const previousOwnershipPath = process.env.PIHUB_SESSION_OWNERSHIP_PATH;
  const previousRegistry = globalThis.__piSessions;
  const originalListAll = SessionManager.listAll;
  process.env.PIHUB_SESSION_OWNERSHIP_PATH = ownershipPath;
  SessionManager.listAll = async () => [];
  globalThis.__piSessionListCache = undefined;
  globalThis.__piSessionListPromise = undefined;
  globalThis.__piSessionListPromiseGeneration = undefined;
  globalThis.__piSessionListGeneration = 0;

  const shutdownIds = [];
  const live = (sessionId, sessionFile = "") => {
    let alive = true;
    return {
      ownerId: OWNER_ID,
      sessionFile,
      isAlive: () => alive,
      shutdown: async () => {
        shutdownIds.push(sessionId);
        alive = false;
      },
    };
  };
  globalThis.__piSessions = new Map([
    [TARGET_ID, live(TARGET_ID, targetPath)],
    [CHILD_ID, live(CHILD_ID, childPath)],
    [TRANSIENT_ID, live(TRANSIENT_ID)],
  ]);

  t.after(() => {
    SessionManager.listAll = originalListAll;
    globalThis.__piSessions = previousRegistry;
    globalThis.__piSessionListCache = undefined;
    globalThis.__piSessionListPromise = undefined;
    globalThis.__piSessionListPromiseGeneration = undefined;
    globalThis.__piSessionListGeneration = 0;
    if (previousOwnershipPath === undefined) delete process.env.PIHUB_SESSION_OWNERSHIP_PATH;
    else process.env.PIHUB_SESSION_OWNERSHIP_PATH = previousOwnershipPath;
    rmSync(root, { recursive: true, force: true });
  });

  writeFileSync(targetPath, sessionFile(TARGET_ID, root));
  writeFileSync(childPath, sessionFile(CHILD_ID, root, targetPath));
  sessionReader.cacheSessionPath(TARGET_ID, targetPath);
  sessionReader.cacheSessionPath(CHILD_ID, childPath);
  await ownership.bindSessionOwner(TARGET_ID, OWNER_ID);
  await ownership.bindSessionOwner(CHILD_ID, OWNER_ID);
  await ownership.bindSessionOwner(TRANSIENT_ID, OWNER_ID);

  const foreign = await DELETE(
    trustedDeleteRequest(TARGET_ID, OTHER_OWNER_ID),
    { params: Promise.resolve({ id: TARGET_ID }) },
  );
  assert.equal(foreign.status, 404);

  const deleted = await DELETE(
    trustedDeleteRequest(TARGET_ID),
    { params: Promise.resolve({ id: TARGET_ID }) },
  );
  assert.equal(deleted.status, 200);
  assert.match(deleted.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(ownership.getSessionOwner(TARGET_ID), null);
  assert.equal(ownership.getSessionOwner(CHILD_ID), OWNER_ID);
  assert.deepEqual(shutdownIds, [TARGET_ID, CHILD_ID]);
  assert.equal(sessionReader.readSessionHeader(childPath)?.parentSession, undefined);
  assert.match(readFileSync(childPath, "utf8"), /preserve me/);
  assert.equal(globalThis.__piSessionPathCache?.has(TARGET_ID), false);
  assert.equal(globalThis.__piSessionPathCache?.has(CHILD_ID), false);

  const transient = await DELETE(
    trustedDeleteRequest(TRANSIENT_ID),
    { params: Promise.resolve({ id: TRANSIENT_ID }) },
  );
  assert.equal(transient.status, 200);
  assert.equal(ownership.getSessionOwner(TRANSIENT_ID), null);
  assert.deepEqual(shutdownIds, [TARGET_ID, CHILD_ID, TRANSIENT_ID]);
});
