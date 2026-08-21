import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sessionPathKey } = await jiti.import("./session-path.ts");
const {
  listAllSessions,
  mergeSessionLists,
  buildSessionContext,
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  openSessionManagerCached,
  readSessionHeader,
  resolveSessionIdByPath,
  resolveSessionPath,
  scanSessionFileRecords,
  sessionFileScannerRef,
} = await jiti.import("./session-reader.ts");

function resetSessionListState() {
  globalThis.__piSessionListCache = undefined;
  globalThis.__piSessionListPromise = undefined;
  globalThis.__piSessionListPromiseGeneration = undefined;
  globalThis.__piSessionListGeneration = 0;
}

function userEntry(id, parentId, content, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "user",
      content,
    },
  };
}

function assistantEntry(id, parentId, text, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: [{ type: "text", text }],
    },
  };
}

test("renders the SDK compaction-aware context with aligned entry IDs", () => {
  const entries = [
    userEntry("u1", null, "old user request"),
    assistantEntry("a1", "u1", "old assistant answer"),
    userEntry("u2", "a1", "kept user request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary",
      firstKeptEntryId: "u2",
      tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["cmp", "u2", "u3"]);
  assert.deepEqual(
    context.messages.map((message) => [message.role, message.customType, message.content]),
    [
      ["custom", "compaction", "old exchange summary"],
      ["user", undefined, "kept user request"],
      ["user", undefined, "after compaction"],
    ],
  );
});

test("uses only the latest compaction on the active path", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "first kept request"),
    {
      type: "compaction",
      id: "cmp1",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "first summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    assistantEntry("a2", "cmp1", "second kept answer"),
    userEntry("u3", "a2", "second kept request"),
    {
      type: "compaction",
      id: "cmp2",
      parentId: "u3",
      timestamp: "2026-01-01T00:00:06.000Z",
      summary: "latest summary",
      firstKeptEntryId: "a2",
      tokensBefore: 200,
    },
    assistantEntry("a3", "cmp2", "latest answer"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["cmp2", "a2", "u3", "a3"]);
  assert.equal(context.messages[0].role, "custom");
  assert.equal(context.messages[0].content, "latest summary");
  assert.equal(context.messages.length, context.entryIds.length);
});

test("uses the selected leaf's path before a later compaction", () => {
  const entries = [
    userEntry("u1", null, "root request"),
    assistantEntry("a1", "u1", "root answer"),
    userEntry("u2", "a1", "main branch"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "main branch summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    userEntry("alt", "a1", "alternate branch"),
  ];

  const context = buildSessionContext(entries, "alt");

  assert.deepEqual(context.entryIds, ["u1", "a1", "alt"]);
  assert.equal(context.messages.some((message) => message.role === "custom"), false);
});

test("returns an empty context for a null leaf", () => {
  const context = buildSessionContext([
    userEntry("u1", null, "not active"),
  ], null);

  assert.deepEqual(context.messages, []);
  assert.deepEqual(context.entryIds, []);
});

test("defers historical thinking without changing live-session content", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "large reasoning" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(deferred.messages[1].content[0], {
    type: "thinking",
    thinking: "",
    deferred: true,
  });

  const full = buildSessionContext(entries);
  assert.equal(full.messages[1].content[0].thinking, "large reasoning");
});

test("does not defer empty historical thinking blocks", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const context = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(context.messages[1].content[0], { type: "thinking", thinking: "" });
});

test("defers only base64 images from historical tool results", () => {
  const userImage = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const toolImage = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "QUJDRA==" },
  };
  const toolUrlImage = {
    type: "image",
    source: { type: "url", url: "https://example.com/result.png" },
  };
  const flatToolImage = {
    type: "image",
    data: "QUJDRA==",
    mimeType: "image/png",
  };
  const entries = [
    userEntry("u1", null, [{ type: "text", text: "inspect this" }, userImage]),
    assistantEntry("a1", "u1", "reading"),
    {
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        content: [
          { type: "text", text: "Read image file" },
          toolImage,
          flatToolImage,
          toolUrlImage,
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferToolResultImages: true });
  assert.deepEqual(deferred.messages[0].content[1], userImage);
  assert.deepEqual(deferred.messages[2].content[0], { type: "text", text: "Read image file" });
  assert.deepEqual(deferred.messages[2].content[1], toolUrlImage);
  assert.match(deferred.messages[2].content[2].text, /2 tool result images omitted.*image\/jpeg, image\/png.*~8 bytes/);

  const full = buildSessionContext(entries);
  assert.deepEqual(full.messages[2].content[1], toolImage);
  assert.deepEqual(full.messages[2].content[2], flatToolImage);
  assert.deepEqual(full.messages[2].content[3], toolUrlImage);
});

test("preserves hidden custom messages so the UI can render them collapsed", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "custom_message",
      id: "c1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "extension_debug",
      content: "hidden extension payload",
      display: false,
      details: { source: "test" },
    },
    assistantEntry("a1", "c1", "done"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u1", "c1", "a1"]);
  assert.equal(context.messages[1].role, "custom");
  assert.equal(context.messages[1].customType, "extension_debug");
  assert.equal(context.messages[1].display, false);
  assert.equal(context.messages[1].content, "hidden extension payload");
});

test("preserves valid epoch timestamps on synthetic UI messages", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u1",
      timestamp: "1970-01-01T00:00:00.000Z",
      summary: "epoch summary",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    },
  ];

  const context = buildSessionContext(entries);

  assert.equal(context.messages[0].role, "custom");
  assert.equal(context.messages[0].customType, "compaction");
  assert.equal(context.messages[0].timestamp, 0);
});

test("reads only a bounded session header, including headers larger than 4 KiB", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-"));
  const filePath = join(dir, "session.jsonl");
  const parentSession = `/tmp/${"p".repeat(5_000)}.jsonl`;
  writeFileSync(filePath, `${JSON.stringify({
    type: "session",
    version: 3,
    id: "session",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    parentSession,
  })}\n${JSON.stringify(userEntry("u1", null, "message"))}\n`);

  try {
    assert.equal(readSessionHeader(filePath)?.parentSession, parentSession);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null for malformed or unbounded session headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-invalid-"));
  const malformedPath = join(dir, "malformed.jsonl");
  const oversizedPath = join(dir, "oversized.jsonl");
  writeFileSync(malformedPath, "{not-json}\n");
  writeFileSync(oversizedPath, "x".repeat(64 * 1024));

  try {
    assert.equal(readSessionHeader(malformedPath), null);
    assert.equal(readSessionHeader(oversizedPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps forward and reverse session path caches in sync", async (t) => {
  const sessionId = "cache-test-session";
  const dir = mkdtempSync(join(tmpdir(), "pi-web-cache-test-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, `${JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
  })}\n`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  cacheSessionPath(sessionId, filePath);
  try {
    assert.equal(
      await resolveSessionIdByPath(filePath),
      sessionId,
    );
  } finally {
    invalidateSessionPathCache(sessionId);
  }

  assert.equal(globalThis.__piSessionPathCache?.has(sessionId), false);
  assert.equal(globalThis.__piPathToSessionIdCache?.has(sessionPathKey(filePath)), false);
});

test("evicts removed and same-path replaced session cache entries", async (t) => {
  const originalScan = sessionFileScannerRef.scan;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-stale-cache-test-"));
  const filePath = join(dir, "session.jsonl");
  const oldSessionId = "stale-cache-session";
  sessionFileScannerRef.scan = async () => [];
  resetSessionListState();
  t.after(() => {
    sessionFileScannerRef.scan = originalScan;
    invalidateSessionPathCache(oldSessionId);
    resetSessionListState();
    rmSync(dir, { recursive: true, force: true });
  });

  const header = (id) => `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
  })}\n`;

  writeFileSync(filePath, header(oldSessionId));
  cacheSessionPath(oldSessionId, filePath);
  rmSync(filePath);
  assert.equal(await resolveSessionPath(oldSessionId), null);
  assert.equal(globalThis.__piSessionPathCache?.has(oldSessionId), false);
  assert.equal(globalThis.__piPathToSessionIdCache?.has(sessionPathKey(filePath)), false);

  writeFileSync(filePath, header(oldSessionId));
  cacheSessionPath(oldSessionId, filePath);
  writeFileSync(filePath, header("replacement-session"));
  assert.equal(await resolveSessionIdByPath(filePath), undefined);
  assert.equal(globalThis.__piSessionPathCache?.has(oldSessionId), false);
  assert.equal(globalThis.__piPathToSessionIdCache?.has(sessionPathKey(filePath)), false);
});

test("bounds the session path index and evicts both directions together", (t) => {
  const previousForward = globalThis.__piSessionPathCache;
  const previousReverse = globalThis.__piPathToSessionIdCache;
  globalThis.__piSessionPathCache = undefined;
  globalThis.__piPathToSessionIdCache = undefined;
  t.after(() => {
    globalThis.__piSessionPathCache = previousForward;
    globalThis.__piPathToSessionIdCache = previousReverse;
  });

  const pathOf = (index) => join(tmpdir(), "pi-web-bounded-cache", `session-${index}.jsonl`);
  const total = 2500;
  for (let index = 0; index < total; index += 1) cacheSessionPath(`session-${index}`, pathOf(index));

  const forward = globalThis.__piSessionPathCache;
  const reverse = globalThis.__piPathToSessionIdCache;
  assert.equal(forward.size, 1000);
  assert.equal(reverse.size, 1000);

  // Oldest insert is gone from both maps; newest survives in both.
  assert.equal(forward.has("session-0"), false);
  assert.equal(reverse.has(sessionPathKey(pathOf(0))), false);
  assert.equal(forward.get(`session-${total - 1}`), pathOf(total - 1));
  assert.equal(reverse.get(sessionPathKey(pathOf(total - 1))), `session-${total - 1}`);

  // No orphan on either side: every row round-trips through the other map.
  for (const [sessionId, filePath] of forward) {
    assert.equal(reverse.get(sessionPathKey(filePath)), sessionId);
  }
  for (const [pathKey, sessionId] of reverse) {
    assert.equal(sessionPathKey(forward.get(sessionId)), pathKey);
  }

  // Re-caching a live session refreshes its recency instead of letting the
  // next 400 inserts evict it.
  cacheSessionPath("session-1600", pathOf(1600));
  for (let index = total; index < total + 400; index += 1) cacheSessionPath(`session-${index}`, pathOf(index));
  assert.equal(forward.get("session-1600"), pathOf(1600));
  assert.equal(reverse.get(sessionPathKey(pathOf(1600))), "session-1600");
  assert.equal(forward.size, 1000);
  assert.equal(reverse.size, 1000);
});

test("forced session listing bypasses the fresh server cache", async (t) => {
  const originalScan = sessionFileScannerRef.scan;
  let scans = 0;
  sessionFileScannerRef.scan = async () => {
    scans += 1;
    return [];
  };
  resetSessionListState();
  t.after(() => {
    sessionFileScannerRef.scan = originalScan;
    resetSessionListState();
  });

  await listAllSessions({ force: true });
  await listAllSessions();
  assert.equal(scans, 1);

  await listAllSessions({ force: true });
  assert.equal(scans, 2);
});

test("a scan invalidated in flight retries before returning to its caller", async (t) => {
  const originalScan = sessionFileScannerRef.scan;
  let scans = 0;
  let releaseFirstScan;
  let markFirstScanStarted;
  const firstScanStarted = new Promise((resolve) => {
    markFirstScanStarted = resolve;
  });
  const firstScanGate = new Promise((resolve) => {
    releaseFirstScan = resolve;
  });
  sessionFileScannerRef.scan = async () => {
    scans += 1;
    if (scans === 1) {
      markFirstScanStarted();
      await firstScanGate;
    }
    return [];
  };
  resetSessionListState();
  t.after(() => {
    sessionFileScannerRef.scan = originalScan;
    resetSessionListState();
  });

  const listing = listAllSessions({ force: true });
  await firstScanStarted;
  invalidateSessionListCache();
  releaseFirstScan();
  await listing;

  assert.equal(scans, 2);
});

test("disk sessions replace runtime snapshots with the same id", () => {
  const base = {
    path: "/tmp/session.jsonl",
    id: "same-id",
    cwd: "/tmp",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:01.000Z",
    messageCount: 2,
    firstMessage: "persisted",
  };
  const persisted = { ...base };
  const runtime = {
    ...base,
    path: "/tmp/not-written-yet.jsonl",
    modified: "2026-01-01T00:00:02.000Z",
    firstMessage: "runtime",
    transient: true,
  };
  const runtimeOnly = {
    ...runtime,
    id: "runtime-only",
    modified: "2026-01-01T00:00:03.000Z",
  };

  const merged = mergeSessionLists([persisted], [runtime, runtimeOnly]);

  assert.deepEqual(merged.map((session) => session.id), ["runtime-only", "same-id"]);
  assert.equal(merged[1], persisted);
  assert.equal(merged[1].transient, undefined);
});

test("session file records cache by size+mtime and reparse after append", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-scan-cache-"));
  const sessionsDir = join(dir, "sessions");
  const projectDir = join(sessionsDir, "--tmp-project--");
  mkdirSync(projectDir, { recursive: true });
  const filePath = join(projectDir, "2026-01-01T00-00-00-000Z_test-session.jsonl");
  const header = (id) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir });
  writeFileSync(filePath, `${header("scan-cache-session")}\n${JSON.stringify(userEntry("u1", null, "第一条消息"))}\n`);
  // Pin a whole-second mtime so the tamper below can reproduce the exact key
  // (utimesSync truncates to milliseconds, statSync reads nanosecond floats).
  const pinned = new Date("2026-01-01T00:00:00.000Z");
  utimesSync(filePath, pinned, pinned);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = await scanSessionFileRecords(sessionsDir);
  assert.equal(first.length, 1);
  assert.equal(first[0].id, "scan-cache-session");
  assert.equal(first[0].messageCount, 1);
  assert.equal(first[0].firstMessage, "第一条消息");

  // Cache hit: same size+mtime returns the memoized record even if the bytes
  // changed under it (append-only files never do this in practice).
  const tampered = `${header("scan-cache-session")}\n${JSON.stringify(userEntry("u1", null, "第二三四五"))}\n`;
  writeFileSync(filePath, tampered);
  utimesSync(filePath, pinned, pinned);
  const cached = await scanSessionFileRecords(sessionsDir);
  assert.equal(cached[0].firstMessage, "第一条消息");

  // Append invalidates via size change and picks up the new entry.
  appendFileSync(filePath, `${JSON.stringify(userEntry("u2", "u1", "追加"))}\n`);
  const reparsed = await scanSessionFileRecords(sessionsDir);
  assert.equal(reparsed[0].messageCount, 2);
});

test("openSessionManagerCached reuses stable files and reloads appended ones", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-manager-cache-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, `${JSON.stringify({ type: "session", version: 3, id: "manager-cache", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir })}\n${JSON.stringify(userEntry("u1", null, "one"))}\n`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = openSessionManagerCached(filePath);
  assert.equal(openSessionManagerCached(filePath), first);
  assert.equal(first.getEntries().length, 1);

  appendFileSync(filePath, `${JSON.stringify(userEntry("u2", "u1", "two"))}\n`);
  const reloaded = openSessionManagerCached(filePath);
  assert.notEqual(reloaded, first);
  assert.equal(reloaded.getEntries().length, 2);
});
