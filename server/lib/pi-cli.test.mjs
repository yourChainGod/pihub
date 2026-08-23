import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { resolvePiCommand } = await import("./pi-cli.ts");

const BUNDLED_REL = ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"];

function createServerRoot(t, { withBundled = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-pi-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (withBundled) {
    const cli = path.join(root, ...BUNDLED_REL);
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "// stub\n", { mode: 0o600 });
  }
  return root;
}

test("prefers the PIHUB_PI_EXECUTABLE override", (t) => {
  const root = createServerRoot(t, { withBundled: true });
  const override = path.join(root, "custom-pi");
  fs.writeFileSync(override, "", { mode: 0o700 });

  const command = resolvePiCommand({
    env: { PIHUB_PI_EXECUTABLE: override },
    serverRoot: root,
    platform: "linux",
    which: () => null,
    bundledCandidates: () => [],
  });

  assert.deepEqual(command, { command: override, argsPrefix: [], display: override });
});

test("falls back to the global pi when no override is set", (t) => {
  const root = createServerRoot(t, { withBundled: true });

  const command = resolvePiCommand({
    env: {},
    serverRoot: root,
    platform: "linux",
    exists: () => true,
    which: (name) => (name === "pi" ? "/usr/local/bin/pi" : null),
    bundledCandidates: () => [],
  });

  assert.deepEqual(command, { command: "/usr/local/bin/pi", argsPrefix: [], display: "pi" });
});

test("falls back to the bundled pinned CLI when PATH has no pi", (t) => {
  const root = createServerRoot(t, { withBundled: true });

  const command = resolvePiCommand({
    env: {},
    serverRoot: root,
    platform: "linux",
    execPath: "/usr/bin/node",
    which: () => null,
    bundledCandidates: () => [path.join(root, ...BUNDLED_REL)],
  });

  assert.deepEqual(command, {
    command: "/usr/bin/node",
    argsPrefix: [path.join(root, ...BUNDLED_REL)],
    display: "bundled",
  });
});

test("skips the PATH probe on Windows and uses the bundled CLI", (t) => {
  const root = createServerRoot(t, { withBundled: true });
  let whichCalled = false;

  const command = resolvePiCommand({
    env: {},
    serverRoot: root,
    platform: "win32",
    execPath: "C:\\node\\node.exe",
    which: () => { whichCalled = true; return "C:\\pi\\pi.cmd"; },
    bundledCandidates: () => [path.join(root, ...BUNDLED_REL)],
  });

  assert.equal(whichCalled, false);
  assert.equal(command.command, "C:\\node\\node.exe");
  assert.deepEqual(command.argsPrefix, [path.join(root, ...BUNDLED_REL)]);
});

test("returns null when no pi can be resolved", (t) => {
  const root = createServerRoot(t);

  const command = resolvePiCommand({
    env: {},
    serverRoot: root,
    platform: "linux",
    which: () => null,
    bundledCandidates: () => [],
  });

  assert.equal(command, null);
});
