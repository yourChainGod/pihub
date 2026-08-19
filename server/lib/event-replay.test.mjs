import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SseReplayChannel,
  getSseConnectionStats,
  parseLastEventId,
  resetSseConnectionRuntimeForTests,
} = await jiti.import("./event-replay.ts");
const decoder = new TextDecoder();

afterEach(() => {
  resetSseConnectionRuntimeForTests();
});

async function readWithin(reader, timeoutMs = 1_000) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out reading SSE chunk")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseFrame(chunk) {
  const text = decoder.decode(chunk.value);
  const id = /^id: (\d+)$/m.exec(text)?.[1];
  const data = /^data: (.+)$/m.exec(text)?.[1];
  return {
    id: id === undefined ? null : Number(id),
    data: data === undefined ? null : JSON.parse(data),
    text,
  };
}

test("publishes monotonic ids and replays events after Last-Event-ID", async () => {
  const channel = new SseReplayChannel("agent:one");
  const first = channel.open(new Request("http://localhost/events"));
  assert.equal(first.accepted, true);
  if (!first.accepted) return;
  const firstReader = first.stream.getReader();
  assert.match(decoder.decode((await readWithin(firstReader)).value), /^: keep-alive/);
  first.connection.activate();

  assert.equal(channel.publish({ value: "one" }), 1);
  assert.equal(channel.publish({ value: "two" }), 2);
  assert.deepEqual(parseFrame(await readWithin(firstReader)), {
    id: 1,
    data: { value: "one" },
    text: "id: 1\ndata: {\"value\":\"one\"}\n\n",
  });
  assert.equal(parseFrame(await readWithin(firstReader)).id, 2);
  await firstReader.cancel();

  const second = channel.open(new Request("http://localhost/events", {
    headers: { "Last-Event-ID": "1" },
  }));
  assert.equal(second.accepted, true);
  if (!second.accepted) return;
  const secondReader = second.stream.getReader();
  await readWithin(secondReader);
  assert.deepEqual(second.connection.replayAfter(parseLastEventId(
    new Request("http://localhost/events", { headers: { "Last-Event-ID": "1" } }),
  )), { status: "complete", replayed: 1 });
  assert.equal(parseFrame(await readWithin(secondReader)).id, 2);
  await secondReader.cancel();
});

test("bounds replay history and reports gaps and future ids", async () => {
  const channel = new SseReplayChannel("bounded", { maxReplayFrames: 2 });
  channel.publish({ value: 1 });
  channel.publish({ value: 2 });
  channel.publish({ value: 3 });

  const opened = channel.open(new Request("http://localhost/events"));
  assert.equal(opened.accepted, true);
  if (!opened.accepted) return;
  const reader = opened.stream.getReader();
  await readWithin(reader);
  assert.deepEqual(opened.connection.replayAfter(0), { status: "gap", replayed: 0 });
  assert.deepEqual(opened.connection.replayAfter(4), { status: "future", replayed: 0 });
  assert.deepEqual(opened.connection.replayAfter(1), { status: "complete", replayed: 2 });
  assert.equal(parseFrame(await readWithin(reader)).id, 2);
  assert.equal(parseFrame(await readWithin(reader)).id, 3);
  await reader.cancel();
});

test("parses only canonical non-negative safe Last-Event-ID values", () => {
  const request = (value) => new Request("http://localhost/events", {
    headers: { "Last-Event-ID": value },
  });
  assert.equal(parseLastEventId(request("0")), 0);
  assert.equal(parseLastEventId(request("42")), 42);
  for (const value of ["", "-1", "+1", "1.0", "1e2", "abc", "9007199254740992"]) {
    assert.equal(parseLastEventId(request(value)), null);
  }
});

test("rejects pre-aborted requests without reserving capacity", () => {
  const abort = new AbortController();
  abort.abort();
  const channel = new SseReplayChannel("pre-abort");
  assert.deepEqual(
    channel.open(new Request("http://localhost/events", { signal: abort.signal })),
    { accepted: false, status: 204 },
  );
  assert.deepEqual(getSseConnectionStats(), { total: 0, scopes: new Map() });
});

test("enforces global and per-scope connection limits and releases on cancel", async () => {
  const firstChannel = new SseReplayChannel("same");
  const secondChannel = new SseReplayChannel("other");
  const first = firstChannel.open(new Request("http://localhost/events"), {
    maxConnections: 1,
    maxConnectionsPerScope: 1,
  });
  assert.equal(first.accepted, true);
  assert.deepEqual(
    firstChannel.open(new Request("http://localhost/events"), {
      maxConnections: 10,
      maxConnectionsPerScope: 1,
    }),
    { accepted: false, status: 429 },
  );
  assert.deepEqual(
    secondChannel.open(new Request("http://localhost/events"), {
      maxConnections: 1,
      maxConnectionsPerScope: 10,
    }),
    { accepted: false, status: 429 },
  );
  if (!first.accepted) return;
  await first.stream.cancel();
  assert.equal(getSseConnectionStats().total, 0);

  const replacement = secondChannel.open(new Request("http://localhost/events"), {
    maxConnections: 1,
  });
  assert.equal(replacement.accepted, true);
  if (replacement.accepted) await replacement.stream.cancel();
});

test("enforces a connection group across otherwise independent scopes", async () => {
  const firstChannel = new SseReplayChannel("scope-one");
  const secondChannel = new SseReplayChannel("scope-two");
  const first = firstChannel.open(new Request("http://localhost/events"), {
    connectionGroup: "device-a",
    maxConnectionsPerGroup: 1,
  });
  assert.equal(first.accepted, true);
  assert.deepEqual(secondChannel.open(new Request("http://localhost/events"), {
    connectionGroup: "device-a",
    maxConnectionsPerGroup: 1,
  }), { accepted: false, status: 429 });

  const otherDevice = secondChannel.open(new Request("http://localhost/events"), {
    connectionGroup: "device-b",
    maxConnectionsPerGroup: 1,
  });
  assert.equal(otherDevice.accepted, true);
  if (first.accepted) await first.stream.cancel();
  if (otherDevice.accepted) await otherDevice.stream.cancel();
});

test("reader cancellation and abort clean timers, listeners, and callbacks once", async () => {
  let closes = 0;
  const abort = new AbortController();
  const channel = new SseReplayChannel("cleanup");
  const opened = channel.open(new Request("http://localhost/events", {
    signal: abort.signal,
  }), {
    heartbeatIntervalMs: 5,
    onClose: () => { closes += 1; },
  });
  assert.equal(opened.accepted, true);
  if (!opened.accepted) return;
  const reader = opened.stream.getReader();
  await readWithin(reader);
  await reader.cancel();
  abort.abort();
  assert.equal(closes, 1);
  assert.equal(channel.connectionCount, 0);
  assert.equal(getSseConnectionStats().total, 0);
});

test("closes a slow consumer when its byte queue reaches the limit", async () => {
  const channel = new SseReplayChannel("slow");
  const opened = channel.open(new Request("http://localhost/events"), {
    maxQueueBytes: 32,
  });
  assert.equal(opened.accepted, true);
  if (!opened.accepted) return;
  opened.connection.activate();
  channel.publish({ payload: "x".repeat(128) });
  assert.equal(opened.connection.closed, true);
  assert.equal(channel.connectionCount, 0);
  assert.equal(getSseConnectionStats().total, 0);
});

test("serialization failures close direct connections and closeAll releases capacity", () => {
  const directChannel = new SseReplayChannel("serialize");
  const direct = directChannel.open(new Request("http://localhost/events"));
  assert.equal(direct.accepted, true);
  if (!direct.accepted) return;
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(direct.connection.send(cyclic), false);
  assert.equal(direct.connection.closed, true);

  const channel = new SseReplayChannel("all");
  const first = channel.open(new Request("http://localhost/events"));
  const second = channel.open(new Request("http://localhost/events"));
  assert.equal(first.accepted && second.accepted, true);
  channel.closeAll();
  assert.equal(channel.connectionCount, 0);
  assert.equal(getSseConnectionStats().total, 0);
});
