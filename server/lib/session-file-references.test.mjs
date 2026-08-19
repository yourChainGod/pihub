import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./session-file-references-core.ts");
}

function entry(id, message, parentId = null) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message,
  };
}

test("authorizes an exact absolute path only after a matching successful structured tool result", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    entry("call-entry", {
      role: "assistant",
      content: [{
        type: "toolCall",
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "/home/me/report.txt" },
      }],
    }),
    entry("result-entry", {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "write",
      content: [{ type: "text", text: "contents are deliberately irrelevant" }],
    }, "call-entry"),
  ];

  assert.equal(isFilePathReferencedByEntries("/home/me/report.txt", entries), true);
  assert.equal(isFilePathReferencedByEntries("/home/me/report.txt.bak", entries), false);
});

test("never treats user, assistant, result, or summary prose as a file capability", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const target = "/home/me/outside/report.txt";
  const entries = [
    entry("user", { role: "user", content: `open ${target}` }),
    entry("assistant", { role: "assistant", content: [{ type: "text", text: `[file](${target})` }] }, "user"),
    entry("result", {
      role: "toolResult",
      toolCallId: "missing-call",
      toolName: "read",
      content: [{ type: "text", text: target }],
      details: { path: target },
    }, "assistant"),
    {
      type: "compaction",
      id: "summary",
      parentId: "result",
      timestamp: "2026-01-01T00:00:01.000Z",
      summary: target,
      firstKeptEntryId: "user",
      tokensBefore: 10,
      details: { files: [target] },
    },
  ];

  assert.equal(isFilePathReferencedByEntries(target, entries), false);
});

test("rejects failed, unmatched, mismatched, untrusted, relative, and duplicate tool calls", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const target = "/home/me/report.txt";
  const call = (id, toolName = "write", filePath = target) => entry(`entry-${id}`, {
    role: "assistant",
    content: [{ type: "toolCall", id, name: toolName, arguments: { path: filePath } }],
  });
  const result = (id, options = {}) => entry(`result-${id}`, {
    role: "toolResult",
    toolCallId: id,
    toolName: options.toolName ?? "write",
    content: [],
    isError: options.isError,
  });

  assert.equal(isFilePathReferencedByEntries(target, [call("failed"), result("failed", { isError: true })]), false);
  assert.equal(isFilePathReferencedByEntries(target, [result("missing")]), false);
  assert.equal(isFilePathReferencedByEntries(target, [call("mismatch"), result("mismatch", { toolName: "edit" })]), false);
  assert.equal(isFilePathReferencedByEntries(target, [call("missing-name"), entry("result-missing-name", { role: "toolResult", toolCallId: "missing-name", content: [] })]), false);
  assert.equal(isFilePathReferencedByEntries(target, [call("shell", "bash"), result("shell", { toolName: "bash" })]), false);
  assert.equal(isFilePathReferencedByEntries(target, [call("relative", "write", "report.txt"), result("relative")]), false);
  assert.equal(isFilePathReferencedByEntries(target, [call("duplicate"), call("duplicate"), result("duplicate")]), false);
  assert.equal(isFilePathReferencedByEntries(target, [call("error-then-success"), result("error-then-success", { isError: true }), result("error-then-success")]), false);
  assert.equal(isFilePathReferencedByEntries(target, [call("success-then-duplicate"), result("success-then-duplicate"), result("success-then-duplicate")]), false);
  assert.equal(isFilePathReferencedByEntries(target, [call("read-only", "read"), result("read-only", { toolName: "read" })]), false);
});

test("rejects credential and operating-system paths even when a tool result matches", async () => {
  const { isFilePathReferencedByEntries, isSensitiveExternalFilePath } = await loadSubject();
  const paths = [
    "/home/me/.ssh/id_ed25519",
    "/home/me/project/.env.production",
    "/home/me/.pi/agent/auth.json",
    "/home/me/.codex/config.toml",
    "/root/private.txt",
    "/boot/loader/entries/system.conf",
    "/etc/passwd",
    "C:\\Windows\\System32\\config\\SAM",
    "C:\\Users\\me\\.aws\\credentials",
    "C:\\Users\\me\\AppData\\Roaming\\tool\\config.json",
    "C:\\work\\report.txt:secret",
    "C:\\work\\CON.txt",
    "\\\\?\\C:\\work\\report.txt",
    "\\\\server\\share\\report.txt",
  ];

  for (const target of paths) {
    const entries = [
      entry("call", {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "write", arguments: { path: target } }],
      }),
      entry("result", { role: "toolResult", toolCallId: "call", toolName: "write", content: [] }),
    ];
    assert.equal(isSensitiveExternalFilePath(target), true, target);
    assert.equal(isFilePathReferencedByEntries(target, entries), false, target);
  }
});

test("authorizes full output only from a bash execution message", async () => {
  const { isBashOutputPathReferencedByEntries } = await loadSubject();
  const outputPath = "/tmp/pi-bash-ab12.log";
  const bashEntry = {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "bashExecution",
      command: "printf test",
      output: "test",
      fullOutputPath: outputPath,
    },
  };
  const assistantEntry = {
    type: "message",
    id: "entry-2",
    parentId: "entry-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `mentioned ${outputPath}` }],
    },
  };

  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [bashEntry]), true);
  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [assistantEntry]), false);
  assert.equal(isBashOutputPathReferencedByEntries("/tmp/pi-bash-other.log", [bashEntry]), false);
});

test("validates session ids before resolving session paths", async () => {
  const { isValidSessionId } = await loadSubject();

  assert.equal(isValidSessionId("not-a-session-id"), false);
  assert.equal(isValidSessionId("../../sessions/foo"), false);
  assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
});
