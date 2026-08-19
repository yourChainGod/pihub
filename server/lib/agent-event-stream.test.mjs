import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createAgentEventStream,
  resetAgentEventChannelsForTests,
} = await jiti.import("./agent-event-stream.ts");
const {
  getSseConnectionStats,
  resetSseConnectionRuntimeForTests,
} = await jiti.import("./event-replay.ts");
const decoder = new TextDecoder();

afterEach(() => {
  resetAgentEventChannelsForTests();
  resetSseConnectionRuntimeForTests();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSession({ snapshot, isStreaming = true } = {}) {
  const listeners = new Set();
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  return {
    get isStreaming() { return isStreaming; },
    get streamingMessage() { return snapshot; },
    setSnapshot(value) { snapshot = value; },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    onEvent(listener) {
      subscribeCount += 1;
      listeners.add(listener);
      return () => {
        if (listeners.delete(listener)) unsubscribeCount += 1;
      };
    },
    counts() {
      return { listeners: listeners.size, subscribeCount, unsubscribeCount };
    },
  };
}

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

function decodeData(chunk) {
  const text = decoder.decode(chunk.value);
  const data = /^data: (.+)$/m.exec(text)?.[1];
  assert.ok(data, `Expected an SSE data frame, got ${JSON.stringify(text)}`);
  return {
    id: Number(/^id: (\d+)$/m.exec(text)?.[1]) || null,
    data: JSON.parse(data),
  };
}

function open(options, init = {}) {
  return createAgentEventStream(
    new Request("http://localhost/events", init),
    options,
  );
}

test("opens transport before startup and snapshots after subscribe without losing sync events", async () => {
  const startup = deferred();
  const abort = new AbortController();
  const snapshot = { role: "assistant", content: [{ type: "text", text: "Hello" }] };
  let listener;
  let unsubscribeCount = 0;
  const result = open({
    deviceId: "device-a",
    sessionId: "session-id",
    loadSession: () => startup.promise,
  }, { signal: abort.signal });
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const reader = result.stream.getReader();
  assert.match(decoder.decode((await readWithin(reader)).value), /^: keep-alive/);

  startup.resolve({
    isStreaming: true,
    streamingMessage: snapshot,
    onEvent(nextListener) {
      listener = nextListener;
      nextListener({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_delta", delta: "ignored" },
      });
      nextListener({ type: "agent_start" });
      return () => { unsubscribeCount += 1; };
    },
  });

  assert.deepEqual(decodeData(await readWithin(reader)).data, {
    type: "connected",
    sessionId: "session-id",
    isStreaming: true,
  });
  assert.deepEqual(decodeData(await readWithin(reader)), {
    id: 1,
    data: { type: "agent_start" },
  });
  assert.deepEqual(decodeData(await readWithin(reader)).data, {
    type: "message_start",
    message: snapshot,
  });

  listener({
    type: "message_update",
    message: { ...snapshot },
    assistantMessageEvent: {
      type: "text_delta",
      delta: "!",
      partial: { ...snapshot },
    },
  });
  assert.deepEqual(decodeData(await readWithin(reader)), {
    id: 2,
    data: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "!" },
    },
  });

  abort.abort();
  assert.equal(unsubscribeCount, 1);
  assert.equal((await readWithin(reader)).done, true);
});

test("reports startup failure in-band and releases connection capacity", async () => {
  const result = open({
    deviceId: "device-a",
    sessionId: "broken",
    loadSession: () => Promise.reject(new Error("broken config")),
  });
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const reader = result.stream.getReader();
  await readWithin(reader);
  assert.deepEqual(decodeData(await readWithin(reader)).data, {
    type: "startup_error",
    errorMessage: "Failed to start agent session",
  });
  assert.equal((await readWithin(reader)).done, true);
  assert.equal(getSseConnectionStats().total, 0);
});

test("pre-abort never calls the lazy session loader", () => {
  const abort = new AbortController();
  abort.abort();
  let loads = 0;
  const result = open({
    deviceId: "device-a",
    sessionId: "pre-aborted",
    loadSession: async () => {
      loads += 1;
      return createSession();
    },
  }, { signal: abort.signal });
  assert.deepEqual(result, { accepted: false, status: 204 });
  assert.equal(loads, 0);
});

test("cancel during startup prevents a late source subscription", async () => {
  const startup = deferred();
  const session = createSession();
  const result = open({
    deviceId: "device-a",
    sessionId: "cancel-startup",
    loadSession: () => startup.promise,
  });
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const reader = result.stream.getReader();
  await readWithin(reader);
  await reader.cancel();
  startup.resolve(session);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(session.counts(), {
    listeners: 0,
    subscribeCount: 0,
    unsubscribeCount: 0,
  });
});

test("reconnect replays only events after the supplied id", async () => {
  const session = createSession({ isStreaming: false });
  const options = {
    deviceId: "device-a",
    sessionId: "replay",
    loadSession: async () => session,
  };
  const first = open(options);
  assert.equal(first.accepted, true);
  if (!first.accepted) return;
  const firstReader = first.stream.getReader();
  await readWithin(firstReader);
  await readWithin(firstReader);
  session.emit({ type: "agent_start" });
  session.emit({ type: "agent_end" });
  assert.equal(decodeData(await readWithin(firstReader)).id, 1);
  assert.equal(decodeData(await readWithin(firstReader)).id, 2);

  // Keep one connection subscribed so replay continuity is provable while the
  // first client disconnects and reconnects.
  const anchor = open(options);
  assert.equal(anchor.accepted, true);
  if (!anchor.accepted) return;
  const anchorReader = anchor.stream.getReader();
  await readWithin(anchorReader);
  await readWithin(anchorReader);
  await firstReader.cancel();

  const second = open(options, { headers: { "Last-Event-ID": "1" } });
  assert.equal(second.accepted, true);
  if (!second.accepted) return;
  const secondReader = second.stream.getReader();
  await readWithin(secondReader);
  assert.equal(decodeData(await readWithin(secondReader)).data.type, "connected");
  assert.deepEqual(decodeData(await readWithin(secondReader)), {
    id: 2,
    data: { type: "agent_end" },
  });
  await secondReader.cancel();
  await anchorReader.cancel();
  assert.equal(session.counts().listeners, 0);
});

test("replay history is isolated by authenticated device", async () => {
  const session = createSession({ isStreaming: false });
  const first = open({
    deviceId: "device-a",
    sessionId: "shared-session",
    loadSession: async () => session,
  });
  assert.equal(first.accepted, true);
  if (!first.accepted) return;
  const firstReader = first.stream.getReader();
  await readWithin(firstReader);
  await readWithin(firstReader);
  session.emit({ type: "private_event", value: "device-a-history" });
  await readWithin(firstReader);
  await firstReader.cancel();

  const second = open({
    deviceId: "device-b",
    sessionId: "shared-session",
    loadSession: async () => session,
  }, { headers: { "Last-Event-ID": "0" } });
  assert.equal(second.accepted, true);
  if (!second.accepted) return;
  const secondReader = second.stream.getReader();
  await readWithin(secondReader);
  assert.equal(decodeData(await readWithin(secondReader)).data.type, "connected");
  assert.deepEqual(decodeData(await readWithin(secondReader)).data, {
    type: "replay_reset",
    sessionId: "shared-session",
    reason: "gap",
  });

  session.emit({ type: "public_event", value: "new" });
  assert.deepEqual(decodeData(await readWithin(secondReader)).data, {
    type: "public_event",
    value: "new",
  });
  await secondReader.cancel();
});

test("a replay gap emits replay_reset and a current snapshot", async () => {
  const session = createSession({ snapshot: { role: "assistant", content: [] } });
  const options = {
    deviceId: "device-a",
    sessionId: "gap",
    loadSession: async () => session,
  };
  const first = open(options);
  assert.equal(first.accepted, true);
  if (!first.accepted) return;
  const firstReader = first.stream.getReader();
  await readWithin(firstReader);
  await readWithin(firstReader);
  await readWithin(firstReader);
  for (let index = 0; index < 257; index += 1) {
    session.emit({ type: "extension_event", index });
  }
  await firstReader.cancel();

  const second = open(options, { headers: { "Last-Event-ID": "0" } });
  assert.equal(second.accepted, true);
  if (!second.accepted) return;
  const secondReader = second.stream.getReader();
  await readWithin(secondReader);
  assert.equal(decodeData(await readWithin(secondReader)).data.type, "connected");
  assert.deepEqual(decodeData(await readWithin(secondReader)).data, {
    type: "replay_reset",
    sessionId: "gap",
    reason: "gap",
  });
  assert.deepEqual(decodeData(await readWithin(secondReader)).data, {
    type: "message_start",
    message: session.streamingMessage,
  });
  await secondReader.cancel();
});

test("enforces the per-device-session connection cap", async () => {
  const startup = deferred();
  const options = {
    deviceId: "device-a",
    sessionId: "capacity",
    loadSession: () => startup.promise,
  };
  const opened = Array.from({ length: 5 }, () => open(options));
  assert.deepEqual(opened.map((result) => result.accepted), [true, true, true, true, false]);
  assert.deepEqual(opened[4], { accepted: false, status: 429 });
  await Promise.all(opened.slice(0, 4).map((result) => {
    if (!result.accepted) return undefined;
    return result.stream.cancel();
  }));
  startup.resolve(createSession());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getSseConnectionStats().total, 0);
});

test("one device cannot exhaust the global pool through many session scopes", async () => {
  const session = createSession({ isStreaming: false });
  const results = Array.from({ length: 17 }, (_, index) => open({
    deviceId: "device-a",
    sessionId: `session-${index}`,
    loadSession: async () => session,
  }));
  assert.deepEqual(
    results.map((result) => result.accepted),
    [...Array.from({ length: 16 }, () => true), false],
  );
  assert.deepEqual(results[16], { accepted: false, status: 429 });
  await Promise.all(results.slice(0, 16).map((result) => {
    if (!result.accepted) return undefined;
    return result.stream.cancel();
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getSseConnectionStats().total, 0);
});
