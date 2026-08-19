import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");
const securitySource = await readFile(new URL("../../../lib/file-route-security.ts", import.meta.url), "utf8");
const start = source.indexOf('if (type === "watch")');
const end = source.indexOf("// type === \"list\"", start);
assert.notEqual(start, -1, "watch route not found");
assert.notEqual(end, -1, "watch route end not found");
const watchBlock = source.slice(start, end);

test("file watching survives same-path replacement", () => {
  assert.match(watchBlock, /watcher = fs\.watch\(watchedDirectory/);
  assert.match(watchBlock, /samePath\(path\.join\(watchedDirectory, changedName\.toString\(\)\), filePath\)/);
  assert.match(watchBlock, /s\.ctimeMs === lastCtimeMs/);
  assert.match(watchBlock, /s\.ino === lastIno/);
  assert.match(watchBlock, /lastExists/);
});

test("a missing target can be watched after its parent is authorized", () => {
  assert.match(source, /if \(!stat && type !== "watch"\)[\s\S]*error: "Not found"/);
  assert.match(source, /const existingAuthorizationPath = stat \? filePath : path\.dirname\(filePath\)/);
  assert.match(watchBlock, /lastExists = stat !== undefined/);
});

test("connected is emitted only after the watcher exists", () => {
  const watcher = watchBlock.indexOf("watcher = fs.watch");
  const connected = watchBlock.indexOf('send("connected"');
  assert.ok(watcher >= 0, "watcher creation missing");
  assert.ok(connected > watcher, "connected emitted before watcher creation");
});

test("watchers are bounded and close when the request is aborted", () => {
  assert.match(source, /tryAcquireFileWatcher\(trusted\.deviceId\)/);
  assert.match(securitySource, /MAX_ACTIVE_WATCHERS_GLOBAL/);
  assert.match(securitySource, /MAX_ACTIVE_WATCHERS_PER_DEVICE/);
  assert.match(watchBlock, /request\.signal\.addEventListener\("abort", abortListener/);
  assert.match(watchBlock, /releaseWatcherSlot\(\)/);
});

test("slow watcher clients retain only the latest pending change event", () => {
  assert.match(watchBlock, /let pendingChange: Uint8Array \| null = null/);
  assert.match(watchBlock, /controller\.desiredSize/);
  assert.match(watchBlock, /pendingChange = encoded/);
  assert.match(watchBlock, /pull\(controller\)/);
  assert.match(watchBlock, /pendingChange = null/);
});
