import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail } = await jiti.import("./[id]/route.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");
const { bindSessionOwner } = await jiti.import("../../../lib/session-ownership.ts");

const DEVICE_ID = `dev_${"A".repeat(22)}`;
const OTHER_DEVICE_ID = `dev_${"B".repeat(22)}`;

function trustedRequest(pathname, deviceId = DEVICE_ID) {
  return new Request(`http://localhost${pathname}`, {
    headers: {
      "x-pihub-authenticated-device": deviceId,
      "x-pihub-authenticated-capabilities": "sessions:read",
    },
  });
}

test("session listing merges live registry snapshots and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(listRoute, /listAllSessions\(\{ force, includeProjectInfo: false \}\)/);
  assert.match(listRoute, /getRpcSessionInfos\(access\.context\.deviceId\)/);
  assert.match(listRoute, /owners\.get\(session\.id\) === access\.context\.deviceId/);
  assert.match(listRoute, /mergeSessionLists\(ownedPersistedSessions, runtimeSessions\)/);
  assert.ok(
    listRoute.indexOf("owners.get(session.id) === access.context.deviceId")
      < listRoute.indexOf("attachSessionProjectInfo("),
  );
  assert.match(listRoute, /privateSessionJson\(/);
});

test("session reads use the live SessionManager before requiring a JSONL path", () => {
  for (const source of [detailRoute, contextRoute]) {
    const liveLookup = source.indexOf("getRpcSession(id, access.context.deviceId)");
    const pathLookup = source.indexOf("resolveSessionPath(id)");
    assert.ok(liveLookup >= 0);
    assert.ok(pathLookup > liveLookup);
    assert.match(source, /liveRpc\?\.inner\.sessionManager \?\? openSessionManagerCached/);
  }
});

test("live agent state is available before the session file is persisted", () => {
  const liveLookup = stateRoute.indexOf("getRpcSession(id, access.context.deviceId)");
  const pathLookup = stateRoute.indexOf("resolveSessionPath(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(stateRoute, /if \(rpc\?\.isAlive\(\)\)/);
});

test("live detail and state routes work without a persisted JSONL file", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const previousOwnershipPath = process.env.PIHUB_SESSION_OWNERSHIP_PATH;
  const ownershipRoot = mkdtempSync(join(tmpdir(), "pihub-runtime-route-owner-"));
  process.env.PIHUB_SESSION_OWNERSHIP_PATH = join(ownershipRoot, "session-ownership.json");
  const id = "550e8400-e29b-41d4-a716-446655440010";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello live" },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry],
    getLeafId: () => entry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`,
  };
  globalThis.__piSessions = new Map([[id, {
    ownerId: DEVICE_ID,
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
    send: async () => ({ isStreaming: true }),
  }]]);
  await bindSessionOwner(id, DEVICE_ID);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    if (previousOwnershipPath === undefined) delete process.env.PIHUB_SESSION_OWNERSHIP_PATH;
    else process.env.PIHUB_SESSION_OWNERSHIP_PATH = previousOwnershipPath;
    rmSync(ownershipRoot, { recursive: true, force: true });
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const detailResponse = await getSessionDetail(
    trustedRequest(`/api/sessions/${id}`),
    routeContext,
  );
  const stateResponse = await getSessionState(
    trustedRequest(`/api/sessions/${id}/state`),
    routeContext,
  );
  const detail = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.info.transient, true);
  assert.deepEqual(detail.context.messages.map((message) => message.content), ["hello live"]);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    running: true,
    state: { isStreaming: true },
  });

  const foreignResponse = await getSessionDetail(
    trustedRequest(`/api/sessions/${id}`, OTHER_DEVICE_ID),
    routeContext,
  );
  const unboundResponse = await getSessionDetail(
    trustedRequest("/api/sessions/550e8400-e29b-41d4-a716-446655440011"),
    { params: Promise.resolve({ id: "550e8400-e29b-41d4-a716-446655440011" }) },
  );
  assert.equal(foreignResponse.status, 404);
  assert.equal(unboundResponse.status, 404);
});
