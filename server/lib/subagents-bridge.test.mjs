import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { activeSubagents, parseSubagentRecord, recordsFromEntries, settledSubagents } =
  await jiti.import("./subagents-bridge.ts");

function record(data) {
  return { type: "custom", customType: "subagents:record", data };
}

function agentResult(details) {
  return { type: "message", message: { role: "toolResult", toolName: "Agent", details } };
}

const COMPLETED = {
  id: "sa-1",
  type: "Explore",
  description: "sweep the config loaders",
  status: "completed",
  result: "found three call sites",
  startedAt: "2026-08-22T10:00:00.000Z",
  completedAt: "2026-08-22T10:02:00.000Z",
};

test("parses a terminal record with its result and timestamps", () => {
  assert.deepEqual(parseSubagentRecord(COMPLETED), COMPLETED);
});

test("falls back to the agent type when no description is recorded", () => {
  const parsed = parseSubagentRecord({ id: "sa-1", type: "Explore", status: "completed" });
  assert.equal(parsed.description, "Explore");
});

test("normalizes the extension's error status to failed", () => {
  const parsed = parseSubagentRecord({ id: "sa-1", type: "Plan", status: "error", error: "boom" });
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.error, "boom");
});

test("keeps aborted distinct from failed", () => {
  const parsed = parseSubagentRecord({ id: "sa-1", type: "Plan", status: "aborted" });
  assert.equal(parsed.status, "aborted");
});

test("drops records missing the fields the panel renders", () => {
  assert.equal(parseSubagentRecord({ type: "Explore", status: "completed" }), undefined);
  assert.equal(parseSubagentRecord({ id: "sa-1", status: "completed" }), undefined);
  assert.equal(parseSubagentRecord({ id: "sa-1", type: "Explore" }), undefined);
  assert.equal(parseSubagentRecord({ id: "sa-1", type: "Explore", status: "weird" }), undefined);
  assert.equal(parseSubagentRecord(null), undefined);
});

test("treats a background Agent toolResult as an in-flight run", () => {
  const found = recordsFromEntries([agentResult({ agentId: "sa-9", agentType: "Explore", description: "scan" })]);
  assert.deepEqual(found, [{ id: "sa-9", type: "Explore", description: "scan", status: "running" }]);
});

test("ignores transcript entries that carry no subagent state", () => {
  const entries = [
    { type: "message", message: { role: "assistant" } },
    { type: "custom", customType: "todo-state", data: { todos: [] } },
    agentResult({ agentType: "Explore" }),
  ];
  assert.deepEqual(recordsFromEntries(entries), []);
});

test("a terminal record supersedes the spawn it describes", () => {
  const found = recordsFromEntries([agentResult({ agentId: "sa-1", agentType: "Explore" }), record(COMPLETED)]);
  assert.equal(found.length, 1);
  assert.equal(found[0].status, "completed");
  assert.equal(found[0].result, "found three call sites");
});

test("a late spawn entry does not revive a settled run", () => {
  const found = recordsFromEntries([record(COMPLETED), agentResult({ agentId: "sa-1", agentType: "Explore" })]);
  assert.equal(found.length, 1);
  assert.equal(found[0].status, "completed");
});

test("a resumed run overwrites its earlier terminal state", () => {
  const found = recordsFromEntries([
    record({ ...COMPLETED, status: "failed", error: "timed out" }),
    record(COMPLETED),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].status, "completed");
});

test("splits runs into active and settled", () => {
  const found = recordsFromEntries([
    record(COMPLETED),
    record({ id: "sa-2", type: "Plan", status: "failed", completedAt: "2026-08-22T10:05:00.000Z" }),
    agentResult({ agentId: "sa-3", agentType: "Explore" }),
  ]);

  assert.deepEqual(activeSubagents(found).map((r) => r.id), ["sa-3"]);
  // Newest completion first.
  assert.deepEqual(settledSubagents(found).map((r) => r.id), ["sa-2", "sa-1"]);
});
