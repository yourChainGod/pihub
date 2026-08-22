import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { bindSessionOwner } = await jiti.import("../../../lib/session-ownership.ts");
const { GET: todosGET } = await jiti.import("./todos/route.ts");
const { GET: subagentsGET } = await jiti.import("./subagents/route.ts");
const { GET: permissionsGET, POST: permissionsPOST, DELETE: permissionsDELETE } = await jiti.import("./permissions/route.ts");

const DEVICE_A = `dev_${"A".repeat(22)}`;
const DEVICE_B = `dev_${"B".repeat(22)}`;
const SESSION_ID = "70000000-0000-4000-8000-00000000aa01";

function trustedHeaders(deviceId, capability, json = false) {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    "x-pihub-authenticated-device": deviceId,
    "x-pihub-authenticated-capabilities": capability,
  };
}

function assertPrivate(response) {
  // session-access error responses use "no-store, max-age=0"; route-produced
  // ones use "private, no-store". Both must never be cacheable.
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/);
}

function todosRequest(headers, sessionId = SESSION_ID) {
  return new NextRequest(`http://localhost/api/pihub/todos?sessionId=${encodeURIComponent(sessionId)}`, { headers });
}

function subagentsRequest(headers, sessionId = SESSION_ID) {
  return new NextRequest(`http://localhost/api/pihub/subagents?sessionId=${encodeURIComponent(sessionId)}`, { headers });
}

function withIsolatedState(t, fn) {
  const root = mkdtempSync(join(tmpdir(), "pihub-panel-routes-"));
  const previousOwnershipPath = process.env.PIHUB_SESSION_OWNERSHIP_PATH;
  const previousHome = process.env.HOME;
  process.env.PIHUB_SESSION_OWNERSHIP_PATH = join(root, "session-ownership.json");
  process.env.HOME = root;
  t.after(() => {
    if (previousOwnershipPath === undefined) delete process.env.PIHUB_SESSION_OWNERSHIP_PATH;
    else process.env.PIHUB_SESSION_OWNERSHIP_PATH = previousOwnershipPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  return fn(root);
}

test("todos route enforces authentication, capability and ownership", async (t) => {
  await withIsolatedState(t, async () => {
    await bindSessionOwner(SESSION_ID, DEVICE_A);

    const unauthenticated = await todosGET(todosRequest({}));
    assert.equal(unauthenticated.status, 401);
    assertPrivate(unauthenticated);

    const wrongCapability = await todosGET(todosRequest(trustedHeaders(DEVICE_A, "devices:manage")));
    assert.equal(wrongCapability.status, 403);
    assertPrivate(wrongCapability);

    const foreign = await todosGET(todosRequest(trustedHeaders(DEVICE_B, "sessions:read")));
    assert.equal(foreign.status, 404);
    assertPrivate(foreign);

    const owned = await todosGET(todosRequest(trustedHeaders(DEVICE_A, "sessions:read")));
    assert.equal(owned.status, 200);
    assertPrivate(owned);
    const body = await owned.json();
    assert.deepEqual(body.snapshot.todos, []);
  });
});

test("todos route rejects malformed session ids", async (t) => {
  await withIsolatedState(t, async () => {
    const response = await todosGET(todosRequest(trustedHeaders(DEVICE_A, "sessions:read"), "bad id!"));
    // Unknown/owned-by-nobody ids are indistinguishable from missing sessions.
    assert.equal(response.status, 404);
    assertPrivate(response);
  });
});

test("subagents route enforces authentication, capability and ownership", async (t) => {
  await withIsolatedState(t, async () => {
    await bindSessionOwner(SESSION_ID, DEVICE_A);

    const unauthenticated = await subagentsGET(subagentsRequest({}));
    assert.equal(unauthenticated.status, 401);
    assertPrivate(unauthenticated);

    const wrongCapability = await subagentsGET(subagentsRequest(trustedHeaders(DEVICE_A, "devices:manage")));
    assert.equal(wrongCapability.status, 403);
    assertPrivate(wrongCapability);

    const foreign = await subagentsGET(subagentsRequest(trustedHeaders(DEVICE_B, "sessions:read")));
    assert.equal(foreign.status, 404);
    assertPrivate(foreign);

    const owned = await subagentsGET(subagentsRequest(trustedHeaders(DEVICE_A, "sessions:read")));
    assert.equal(owned.status, 200);
    assertPrivate(owned);
    const body = await owned.json();
    assert.deepEqual(body.subagents, []);
    assert.equal(body.activeCount, 0);
  });
});

test("permissions route enforces authentication and capability on every method", async (t) => {
  await withIsolatedState(t, async () => {
    const url = "http://localhost/api/pihub/permissions";
    const get = (headers) => new NextRequest(url, { headers });
    const post = (headers) => new NextRequest(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ pattern: "Bash(npm test)", action: "allow" }),
    });
    const del = (headers) => new NextRequest(url, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ pattern: "Bash(npm test)" }),
    });

    for (const [name, handler, request] of [
      ["GET", permissionsGET, get],
      ["POST", permissionsPOST, post],
      ["DELETE", permissionsDELETE, del],
    ]) {
      const unauthenticated = await handler(request({}));
      assert.equal(unauthenticated.status, 401, name);
      assertPrivate(unauthenticated);

      const wrongCapability = await handler(request(trustedHeaders(DEVICE_A, "sessions:read")));
      assert.equal(wrongCapability.status, 403, name);
      assertPrivate(wrongCapability);
    }

    const ok = await permissionsGET(get(trustedHeaders(DEVICE_A, "system:manage")));
    assert.equal(ok.status, 200);
    assertPrivate(ok);
    const body = await ok.json();
    assert.ok(Array.isArray(body.rules));
  });
});
