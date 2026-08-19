import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createRunningEventStream,
  resetRunningEventChannelsForTests,
} = await jiti.import("./running-event-stream.ts");
const {
  getSseConnectionStats,
  resetSseConnectionRuntimeForTests,
} = await jiti.import("./event-replay.ts");
const decoder = new TextDecoder();

afterEach(() => {
  resetRunningEventChannelsForTests();
  resetSseConnectionRuntimeForTests();
});

function createSource(initial = []) {
  const listeners = new Set();
  const calls = [];
  let snapshot = initial;
  let unsubscribeCount = 0;
  return {
    getSnapshot() {
      calls.push("snapshot");
      return [...snapshot];
    },
    subscribe(listener) {
      calls.push("subscribe");
      listeners.add(listener);
      return () => {
        if (listeners.delete(listener)) unsubscribeCount += 1;
      };
    },
    update(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener([...next]);
    },
    setWhileIdle(next) {
      snapshot = next;
    },
    state() {
      return { calls, listeners: listeners.size, unsubscribeCount };
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
  assert.ok(data, `Expected SSE data, got ${JSON.stringify(text)}`);
  return {
    id: Number(/^id: (\d+)$/m.exec(text)?.[1]) || null,
    data: JSON.parse(data),
  };
}

function open(deviceId, source, init = {}) {
  return createRunningEventStream(new Request("http://localhost/events", init), {
    deviceId,
    getSnapshot: source.getSnapshot,
    subscribe: source.subscribe,
  });
}

test("subscribes before the initial snapshot and unsubscribes on reader cancel", async () => {
  const source = createSource(["one"]);
  const result = open("device-a", source);
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const reader = result.stream.getReader();
  assert.match(decoder.decode((await readWithin(reader)).value), /^: keep-alive/);
  assert.deepEqual(decodeData(await readWithin(reader)).data, {
    type: "running",
    runningSessionIds: ["one"],
  });
  assert.deepEqual(source.state().calls, ["subscribe", "snapshot"]);
  assert.equal(source.state().listeners, 1);

  await reader.cancel();
  assert.equal(source.state().listeners, 0);
  assert.equal(source.state().unsubscribeCount, 1);
  assert.equal(getSseConnectionStats().total, 0);
});

test("reconnect publishes a fresh post-subscribe snapshot for changes while idle", async () => {
  const source = createSource(["one"]);
  const first = open("device-a", source);
  assert.equal(first.accepted, true);
  if (!first.accepted) return;
  const firstReader = first.stream.getReader();
  await readWithin(firstReader);
  await readWithin(firstReader);
  source.update(["one", "two"]);
  const update = decodeData(await readWithin(firstReader));
  assert.equal(update.id, 2);
  await firstReader.cancel();

  source.setWhileIdle(["three"]);
  const second = open("device-a", source, { headers: { "Last-Event-ID": "2" } });
  assert.equal(second.accepted, true);
  if (!second.accepted) return;
  const secondReader = second.stream.getReader();
  await readWithin(secondReader);
  assert.deepEqual(decodeData(await readWithin(secondReader)), {
    id: 3,
    data: { type: "running", runningSessionIds: ["three"] },
  });
  await secondReader.cancel();
  assert.equal(source.state().listeners, 0);
});

test("a future Last-Event-ID resets to the current snapshot", async () => {
  const source = createSource(["current"]);
  const result = open("device-a", source, { headers: { "Last-Event-ID": "999" } });
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const reader = result.stream.getReader();
  await readWithin(reader);
  assert.deepEqual(decodeData(await readWithin(reader)).data, {
    type: "replay_reset",
    reason: "future",
  });
  assert.deepEqual(decodeData(await readWithin(reader)).data, {
    type: "running",
    runningSessionIds: ["current"],
  });
  await reader.cancel();
});

test("a Last-Event-ID from an expired channel cannot collide with the new epoch", async () => {
  const source = createSource(["old"]);
  const first = open("device-a", source, { headers: { "Last-Event-ID": "0" } });
  assert.equal(first.accepted, true);
  if (!first.accepted) return;
  const firstReader = first.stream.getReader();
  await readWithin(firstReader);
  assert.deepEqual(decodeData(await readWithin(firstReader)), {
    id: 1,
    data: { type: "running", runningSessionIds: ["old"] },
  });
  await firstReader.cancel();
  resetRunningEventChannelsForTests();

  source.setWhileIdle(["new"]);
  const second = open("device-a", source, { headers: { "Last-Event-ID": "1" } });
  assert.equal(second.accepted, true);
  if (!second.accepted) return;
  const secondReader = second.stream.getReader();
  await readWithin(secondReader);
  assert.deepEqual(decodeData(await readWithin(secondReader)).data, {
    type: "replay_reset",
    reason: "future",
  });
  assert.deepEqual(decodeData(await readWithin(secondReader)).data, {
    type: "running",
    runningSessionIds: ["new"],
  });
  await secondReader.cancel();
});

test("keeps replay histories isolated between devices", async () => {
  const source = createSource([]);
  const first = open("device-a", source);
  assert.equal(first.accepted, true);
  if (!first.accepted) return;
  const firstReader = first.stream.getReader();
  await readWithin(firstReader);
  await readWithin(firstReader);
  source.update(["secret-a"]);
  await readWithin(firstReader);
  await firstReader.cancel();

  source.setWhileIdle(["device-b-current"]);
  const second = open("device-b", source);
  assert.equal(second.accepted, true);
  if (!second.accepted) return;
  const secondReader = second.stream.getReader();
  await readWithin(secondReader);
  assert.deepEqual(decodeData(await readWithin(secondReader)).data.runningSessionIds, [
    "device-b-current",
  ]);
  await secondReader.cancel();
});

test("pre-abort does not subscribe or read a snapshot", () => {
  const source = createSource([]);
  const abort = new AbortController();
  abort.abort();
  const result = open("device-a", source, { signal: abort.signal });
  assert.deepEqual(result, { accepted: false, status: 204 });
  assert.deepEqual(source.state().calls, []);
});

test("source initialization failure releases the connection and subscriber", () => {
  let unsubscribes = 0;
  const result = createRunningEventStream(new Request("http://localhost/events"), {
    deviceId: "device-a",
    subscribe: () => () => { unsubscribes += 1; },
    getSnapshot: () => { throw new Error("source failed"); },
  });
  assert.deepEqual(result, { accepted: false, status: 503 });
  assert.equal(unsubscribes, 1);
  assert.equal(getSseConnectionStats().total, 0);
});

test("enforces four concurrent streams per authenticated device", async () => {
  const source = createSource([]);
  const results = Array.from({ length: 5 }, () => open("device-a", source));
  assert.deepEqual(results.map((result) => result.accepted), [true, true, true, true, false]);
  assert.deepEqual(results[4], { accepted: false, status: 429 });
  assert.equal(source.state().listeners, 1);
  await Promise.all(results.slice(0, 4).map((result) => {
    if (!result.accepted) return undefined;
    return result.stream.cancel();
  }));
  assert.equal(source.state().listeners, 0);
  assert.equal(source.state().unsubscribeCount, 1);
});
