import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
globalThis.window = {
  location: { hostname: "localhost" },
  __PIHUB_DESKTOP_BRIDGE__: {
    async invoke(command, args) {
      calls.push({ command, args });
      return command === "start_agent_stream" ? 42 : undefined;
    },
  },
};

const {
  remoteAgentEventMatchesDevice,
  remoteAgentStreamKey,
  startRemoteAgentStream,
  stopRemoteAgentStream,
} = await import("./lib.ts");

const first = { id: "device-a", url: "https://device-a.example.ts.net:30141" };
const second = { id: "device-b", url: "https://device-b.example.ts.net:30141" };

test("stream identity includes the device and session", () => {
  assert.notEqual(remoteAgentStreamKey(first, "shared"), remoteAgentStreamKey(second, "shared"));
  assert.notEqual(remoteAgentStreamKey(first, "shared"), remoteAgentStreamKey(first, "other"));
});

test("agent events are accepted only for the owning device", () => {
  const payload = { deviceId: first.id, deviceOrigin: new URL(first.url).origin, sessionId: "shared", generation: 7, event: { type: "connected" } };
  assert.equal(remoteAgentEventMatchesDevice(payload, first), true);
  assert.equal(remoteAgentEventMatchesDevice(payload, second), false);
  assert.equal(remoteAgentEventMatchesDevice({ ...payload, deviceOrigin: second.url }, first), false);
});

test("start and stop transport carry device, origin, and session identity", async () => {
  assert.equal(await startRemoteAgentStream(first, "session-1"), 42);
  await stopRemoteAgentStream(first, "session-1");
  assert.deepEqual(calls, [
    {
      command: "start_agent_stream",
      args: { url: first.url, deviceId: first.id, sessionId: "session-1" },
    },
    {
      command: "stop_agent_stream",
      args: { url: first.url, deviceId: first.id, sessionId: "session-1" },
    },
  ]);
});
