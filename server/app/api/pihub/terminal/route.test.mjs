import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: true,
  tsconfigPaths: true,
});
const route = await jiti.import("./route.ts");
const eventRoute = await jiti.import("./[id]/events/route.ts");
const terminalRuntime = await jiti.import("../../../../lib/pihub-terminal.ts");
const allowedRoots = await jiti.import("../../../../lib/allowed-roots.ts");

const OWNER_A = `dev_${"A".repeat(22)}`;
const OWNER_B = `dev_${"B".repeat(22)}`;
const TERMINAL_ID = "terminal-owned";

function trustedHeaders(ownerId = OWNER_A, json = false, capabilities = "terminal:use") {
  return {
    host: "localhost:30141",
    "x-pihub-authenticated-device": ownerId,
    "x-pihub-authenticated-capabilities": capabilities,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function nextRequest(method, pathname, body, ownerId = OWNER_A) {
  return new NextRequest(`http://localhost:30141${pathname}`, {
    method,
    headers: trustedHeaders(ownerId, body !== undefined),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function plainRequest(pathname, ownerId = OWNER_A, signal) {
  return new Request(`http://localhost:30141${pathname}`, {
    headers: trustedHeaders(ownerId),
    signal,
  });
}

function installFakeManager(options = {}) {
  const state = {
    createCalls: [],
    getCalls: [],
    readCalls: [],
    writeCalls: [],
    resizeCalls: [],
    closeCalls: [],
    subscribeCalls: [],
    unsubscribeCalls: 0,
    touchCalls: [],
    listener: null,
    shutdownCalls: 0,
  };
  const session = {
    id: TERMINAL_ID,
    ownerId: OWNER_A,
    cwd: options.cwd ?? "/canonical/work",
    output: options.output ?? "ready",
    dropped: 0,
  };
  const owns = (id, ownerId) => id === TERMINAL_ID && ownerId === OWNER_A;
  const manager = {
    create(cwd, ownerId) {
      state.createCalls.push([cwd, ownerId]);
      return { ...session, cwd, ownerId };
    },
    get(id, ownerId) {
      state.getCalls.push([id, ownerId]);
      return owns(id, ownerId) ? session : undefined;
    },
    read(id, ownerId, offset) {
      state.readCalls.push([id, ownerId, offset]);
      if (!owns(id, ownerId)) return undefined;
      return { chunk: session.output.slice(offset), cursor: session.output.length, reset: false };
    },
    write(id, ownerId, data) {
      state.writeCalls.push([id, ownerId, data]);
      return owns(id, ownerId);
    },
    resize(id, ownerId, columns, rows) {
      state.resizeCalls.push([id, ownerId, columns, rows]);
      return owns(id, ownerId);
    },
    close(id, ownerId) {
      state.closeCalls.push([id, ownerId]);
      return owns(id, ownerId);
    },
    subscribe(id, ownerId, listener) {
      state.subscribeCalls.push([id, ownerId]);
      if (!owns(id, ownerId)) return null;
      if (options.subscriberLimit) {
        throw new terminalRuntime.TerminalCapacityError("SUBSCRIBER_LIMIT");
      }
      state.listener = listener;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        state.unsubscribeCalls += 1;
        state.listener = null;
      };
    },
    touch(id, ownerId) {
      state.touchCalls.push([id, ownerId]);
      return owns(id, ownerId);
    },
    shutdown() { state.shutdownCalls += 1; },
    count() { return 1; },
  };
  globalThis.__pihubTerminalRuntimeV2 = { version: 2, manager };
  return { state, session };
}

test("terminal routes require trusted proxy identity metadata", async () => {
  installFakeManager();
  const missingIdentity = new NextRequest("http://localhost:30141/api/pihub/terminal?id=terminal-owned", {
    headers: { host: "localhost:30141" },
  });
  const untrustedHost = new NextRequest("http://attacker.example/api/pihub/terminal?id=terminal-owned", {
    headers: {
      ...trustedHeaders(),
      host: "attacker.example",
    },
  });

  assert.equal((await route.GET(missingIdentity)).status, 401);
  assert.equal((await route.GET(untrustedHost)).status, 403);

  const missingCapability = new NextRequest(
    "http://localhost:30141/api/pihub/terminal?id=terminal-owned",
    { headers: trustedHeaders(OWNER_A, false, "files:read") },
  );
  assert.equal((await route.GET(missingCapability)).status, 403);
});

test("poll, input, resize, and close never cross terminal owners", async () => {
  const { state } = installFakeManager();
  const wrongOwnerPoll = await route.GET(nextRequest(
    "GET",
    `/api/pihub/terminal?id=${TERMINAL_ID}&offset=0`,
    undefined,
    OWNER_B,
  ));
  const wrongOwnerInput = await route.POST(nextRequest("POST", "/api/pihub/terminal", {
    action: "input",
    id: TERMINAL_ID,
    data: "whoami\n",
  }, OWNER_B));
  assert.equal(wrongOwnerPoll.status, 404);
  assert.equal(wrongOwnerInput.status, 404);

  const poll = await route.GET(nextRequest(
    "GET",
    `/api/pihub/terminal?id=${TERMINAL_ID}&offset=0`,
  ));
  assert.equal(poll.status, 200);
  assert.deepEqual(await poll.json(), {
    id: TERMINAL_ID,
    cwd: "/canonical/work",
    chunk: "ready",
    cursor: 5,
    reset: false,
    offsetEncoding: "utf-16",
  });

  assert.equal((await route.POST(nextRequest("POST", "/api/pihub/terminal", {
    action: "input",
    id: TERMINAL_ID,
    data: "echo ok\n",
  }))).status, 200);
  assert.equal((await route.POST(nextRequest("POST", "/api/pihub/terminal", {
    action: "resize",
    id: TERMINAL_ID,
    data: "80x1",
  }))).status, 200);
  assert.equal((await route.POST(nextRequest("POST", "/api/pihub/terminal", {
    action: "close",
    id: TERMINAL_ID,
  }))).status, 200);
  assert.deepEqual(state.writeCalls.at(-1), [TERMINAL_ID, OWNER_A, "echo ok\n"]);
  assert.deepEqual(state.resizeCalls.at(-1), [TERMINAL_ID, OWNER_A, 80, 1]);
  assert.deepEqual(state.closeCalls.at(-1), [TERMINAL_ID, OWNER_A]);
});

test("create uses the authenticated owner's root scope and canonical cwd", async (t) => {
  const { state } = installFakeManager();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-terminal-route-"));
  t.after(() => {
    allowedRoots.revokeFileRoot(workspace, { ownerId: OWNER_A });
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  const canonical = allowedRoots.allowFileRoot(workspace, { ownerId: OWNER_A });

  const allowed = await route.POST(nextRequest("POST", "/api/pihub/terminal", {
    action: "create",
    cwd: canonical,
  }));
  const denied = await route.POST(nextRequest("POST", "/api/pihub/terminal", {
    action: "create",
    cwd: canonical,
  }, OWNER_B));
  assert.equal(allowed.status, 200);
  assert.equal(denied.status, 403);
  assert.deepEqual(state.createCalls, [[canonical, OWNER_A]]);
});

test("POST bounds JSON bodies, terminal input, and resize dimensions", async () => {
  installFakeManager();
  const cases = [
    { action: "input", id: TERMINAL_ID },
    { action: "input", id: TERMINAL_ID, data: "x".repeat(64 * 1024 + 1) },
    { action: "input", id: TERMINAL_ID, data: "界".repeat(22_000) },
    { action: "resize", id: TERMINAL_ID, data: "1x24" },
    { action: "resize", id: TERMINAL_ID, data: "501x24" },
    { action: "resize", id: TERMINAL_ID, data: "80x301" },
    { action: "resize", id: TERMINAL_ID, data: "80.5x24" },
  ];
  for (const body of cases) {
    const response = await route.POST(nextRequest("POST", "/api/pihub/terminal", body));
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 120));
  }

  const oversizedBody = nextRequest("POST", "/api/pihub/terminal", {
    action: "input",
    id: TERMINAL_ID,
    data: "x".repeat(70 * 1024),
  });
  assert.equal((await route.POST(oversizedBody)).status, 400);
});

test("SSE rejects wrong owners and subscriber exhaustion", async () => {
  installFakeManager();
  const wrongOwner = await eventRoute.GET(
    plainRequest(`/api/pihub/terminal/${TERMINAL_ID}/events`, OWNER_B),
    { params: Promise.resolve({ id: TERMINAL_ID }) },
  );
  assert.equal(wrongOwner.status, 404);

  installFakeManager({ subscriberLimit: true });
  const limited = await eventRoute.GET(
    plainRequest(`/api/pihub/terminal/${TERMINAL_ID}/events`),
    { params: Promise.resolve({ id: TERMINAL_ID }) },
  );
  assert.equal(limited.status, 429);
});

test("SSE pre-abort and consumer cancellation release subscriptions", async () => {
  const preAborted = installFakeManager({ output: "" });
  const abortController = new AbortController();
  abortController.abort();
  const abortedResponse = await eventRoute.GET(
    plainRequest(`/api/pihub/terminal/${TERMINAL_ID}/events`, OWNER_A, abortController.signal),
    { params: Promise.resolve({ id: TERMINAL_ID }) },
  );
  assert.equal(abortedResponse.status, 204);
  assert.equal(preAborted.state.unsubscribeCalls, 1);

  const canceled = installFakeManager({ output: "" });
  const response = await eventRoute.GET(
    plainRequest(`/api/pihub/terminal/${TERMINAL_ID}/events`),
    { params: Promise.resolve({ id: TERMINAL_ID }) },
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.cancel();
  assert.equal(canceled.state.unsubscribeCalls, 1);
});

test("SSE closes slow consumers once queued output exceeds backpressure", async () => {
  const { state } = installFakeManager({ output: "" });
  const response = await eventRoute.GET(
    plainRequest(`/api/pihub/terminal/${TERMINAL_ID}/events`),
    { params: Promise.resolve({ id: TERMINAL_ID }) },
  );
  assert.equal(response.status, 200);
  assert.ok(state.listener);
  state.listener({ type: "output", data: "first" });
  state.listener?.({ type: "output", data: "second" });
  assert.equal(state.unsubscribeCalls, 1);

  const reader = response.body.getReader();
  while (!(await reader.read()).done) {}
});
