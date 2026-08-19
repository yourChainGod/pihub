import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: true,
  tsconfigPaths: true,
});
const agentRoute = await jiti.import("./[id]/events/route.ts");
const runningRoute = await jiti.import("./running/events/route.ts");
const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const runningEventsSource = await readFile(new URL("./running/events/route.ts", import.meta.url), "utf8");
const { bindSessionOwner } = await jiti.import("../../../lib/session-ownership.ts");

const DEVICE_ID = `dev_${"A".repeat(22)}`;
const OTHER_DEVICE_ID = `dev_${"B".repeat(22)}`;

function trustedRequest(pathname, capability = "agents:use", signal, deviceId = DEVICE_ID) {
  return new Request(`http://localhost:30141${pathname}`, {
    headers: {
      "x-pihub-authenticated-device": deviceId,
      "x-pihub-authenticated-capabilities": capability,
    },
    signal,
  });
}

test("agent and running SSE routes require trusted identity and agents:use", async () => {
  const missingAgent = await agentRoute.GET(
    new Request("http://localhost:30141/api/agent/id/events"),
    { params: Promise.resolve({ id: "id" }) },
  );
  const deniedAgent = await agentRoute.GET(
    trustedRequest("/api/agent/id/events", "sessions:read"),
    { params: Promise.resolve({ id: "id" }) },
  );
  const missingRunning = await runningRoute.GET(
    new Request("http://localhost:30141/api/agent/running/events"),
  );
  const deniedRunning = await runningRoute.GET(
    trustedRequest("/api/agent/running/events", "sessions:read"),
  );

  assert.equal(missingAgent.status, 401);
  assert.equal(deniedAgent.status, 403);
  assert.equal(missingRunning.status, 401);
  assert.equal(deniedRunning.status, 403);
  for (const response of [missingAgent, deniedAgent, missingRunning, deniedRunning]) {
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("agent SSE hides foreign and unbound sessions with the same 404", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pihub-agent-events-owner-"));
  const previousOwnershipPath = process.env.PIHUB_SESSION_OWNERSHIP_PATH;
  process.env.PIHUB_SESSION_OWNERSHIP_PATH = join(root, "session-ownership.json");
  t.after(() => {
    if (previousOwnershipPath === undefined) delete process.env.PIHUB_SESSION_OWNERSHIP_PATH;
    else process.env.PIHUB_SESSION_OWNERSHIP_PATH = previousOwnershipPath;
    rmSync(root, { recursive: true, force: true });
  });
  const ownedId = "80000000-0000-4000-8000-000000000001";
  const unboundId = "80000000-0000-4000-8000-000000000002";
  await bindSessionOwner(ownedId, DEVICE_ID);

  const foreign = await agentRoute.GET(
    trustedRequest(`/api/agent/${ownedId}/events`, "agents:use", undefined, OTHER_DEVICE_ID),
    { params: Promise.resolve({ id: ownedId }) },
  );
  const unbound = await agentRoute.GET(
    trustedRequest(`/api/agent/${unboundId}/events`),
    { params: Promise.resolve({ id: unboundId }) },
  );

  assert.equal(foreign.status, 404);
  assert.equal(unbound.status, 404);
  assert.deepEqual(await foreign.json(), await unbound.json());

  writeFileSync(process.env.PIHUB_SESSION_OWNERSHIP_PATH, "{corrupt\n");
  const unavailable = await agentRoute.GET(
    trustedRequest(`/api/agent/${ownedId}/events`),
    { params: Promise.resolve({ id: ownedId }) },
  );
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.headers.get("cache-control") ?? "", /no-store/);
});

test("pre-aborted requests return 204 without starting session or source work", async () => {
  const abort = new AbortController();
  abort.abort();
  const agent = await agentRoute.GET(
    trustedRequest("/api/agent/id/events", "agents:use", abort.signal),
    { params: Promise.resolve({ id: "id" }) },
  );
  const running = await runningRoute.GET(
    trustedRequest("/api/agent/running/events", "agents:use", abort.signal),
  );
  assert.equal(agent.status, 204);
  assert.equal(running.status, 204);
});

test("agent route admits the stream before lazily starting an RPC session", () => {
  assert.match(agentEventsSource, /getTrustedPihubRequestContext\(req\)/);
  assert.match(agentEventsSource, /capabilities\.includes\("agents:use"\)/);
  assert.match(agentEventsSource, /createAgentEventStream\(req, \{/);
  assert.match(agentEventsSource, /loadSession: async \(\) => \{/);
  assert.match(agentEventsSource, /const started = await startRpcSession/);
  assert.doesNotMatch(agentEventsSource, /authenticatePihubApiRequest/);
  assert.ok(
    agentEventsSource.indexOf("createAgentEventStream(req")
      < agentEventsSource.indexOf("await startRpcSession"),
  );
});

test("SSE routes share bounded helpers and disable caching and buffering", () => {
  assert.match(runningEventsSource, /createRunningEventStream\(req, \{/);
  assert.doesNotMatch(runningEventsSource, /new ReadableStream/);
  assert.doesNotMatch(runningEventsSource, /authenticatePihubApiRequest/);
  for (const source of [agentEventsSource, runningEventsSource]) {
    assert.match(source, /"X-Accel-Buffering": "no"/);
    assert.match(source, /no-store, no-cache, max-age=0, no-transform/);
    assert.match(source, /"X-Content-Type-Options": "nosniff"/);
  }
});
