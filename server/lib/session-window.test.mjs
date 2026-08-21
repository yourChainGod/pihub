import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./session-window.ts");
  } catch {
    return import("./session-window.ts");
  }
}

const { windowSessionContext } = await loadSubject();

const context = {
  messages: ["m1", "m2", "m3", "m4"],
  entryIds: ["e1", "e2", "e3", "e4"],
};

test("returns the trailing window when no cursor is given", () => {
  const result = windowSessionContext(context, { limit: 2 });
  assert.deepEqual(result.messages, ["m3", "m4"]);
  assert.deepEqual(result.entryIds, ["e3", "e4"]);
  assert.equal(result.truncated, true);
  assert.equal(result.totalMessages, 4);
  assert.equal(result.incremental, undefined);
  assert.equal(result.reset, undefined);
});

test("without a limit the whole context is returned", () => {
  const result = windowSessionContext(context, {});
  assert.deepEqual(result.messages, ["m1", "m2", "m3", "m4"]);
  assert.equal(result.truncated, undefined);
});

test("a known cursor returns only newer entries, marked incremental", () => {
  const result = windowSessionContext(context, { after: "e2", limit: 1 });
  assert.deepEqual(result.messages, ["m3", "m4"]);
  assert.deepEqual(result.entryIds, ["e3", "e4"]);
  assert.equal(result.incremental, true);
  assert.equal(result.truncated, false);
  assert.equal(result.totalMessages, 4);
});

test("a cursor at the tail yields an empty incremental page", () => {
  const result = windowSessionContext(context, { after: "e4" });
  assert.deepEqual(result.messages, []);
  assert.equal(result.incremental, true);
  assert.equal(result.reset, undefined);
});

test("a lost cursor resets to a full window instead of dropping history", () => {
  const result = windowSessionContext(context, { after: "gone", limit: 3 });
  assert.deepEqual(result.messages, ["m2", "m3", "m4"]);
  assert.equal(result.reset, true);
  assert.equal(result.incremental, undefined);
  assert.equal(result.truncated, true);
});

test("duplicate entry ids anchor on the last occurrence", () => {
  const duplicated = { messages: ["a", "b", "c"], entryIds: ["e1", "e1", "e2"] };
  const result = windowSessionContext(duplicated, { after: "e1" });
  assert.deepEqual(result.messages, ["c"]);
  assert.equal(result.incremental, true);
});

test("a before cursor pages backward with truncation marker", () => {
  const result = windowSessionContext(context, { before: "e4", limit: 2 });
  assert.deepEqual(result.messages, ["m2", "m3"]);
  assert.deepEqual(result.entryIds, ["e2", "e3"]);
  assert.equal(result.incremental, true);
  assert.equal(result.truncated, true);
  assert.equal(result.totalMessages, 4);
});

test("a before cursor at the head returns an untruncated full prefix", () => {
  const result = windowSessionContext(context, { before: "e2", limit: 10 });
  assert.deepEqual(result.messages, ["m1"]);
  assert.equal(result.truncated, false);
});

test("a lost before cursor resets to the trailing window", () => {
  const result = windowSessionContext(context, { before: "gone", limit: 2 });
  assert.deepEqual(result.messages, ["m3", "m4"]);
  assert.equal(result.reset, true);
  assert.equal(result.incremental, undefined);
});
