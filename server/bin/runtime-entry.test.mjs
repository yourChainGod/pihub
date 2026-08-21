import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import runtimeEntryModule from "./runtime-entry.js";

const { INTERNAL_NEXT_SENTINEL } = runtimeEntryModule;

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub runtime entry "));
  const entry = path.join(root, "bin", "runtime-entry.js");
  const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const piRoot = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  const pi = path.join(piRoot, "dist", "cli.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.mkdirSync(path.dirname(next), { recursive: true });
  fs.mkdirSync(path.dirname(pi), { recursive: true });
  fs.copyFileSync(new URL("./runtime-entry.js", import.meta.url), entry);
  fs.writeFileSync(next, `
const fs = require("node:fs");
fs.writeFileSync(process.env.PIHUB_RUNTIME_TEST_OUTPUT, JSON.stringify({ kind: "server", argv: process.argv }));
`);
  fs.writeFileSync(path.join(piRoot, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "0.84.2",
    type: "module",
  }));
  fs.writeFileSync(pi, `
import fs from "node:fs";
fs.writeFileSync(process.env.PIHUB_RUNTIME_TEST_OUTPUT, JSON.stringify({ kind: "pi", argv: process.argv }));
`);
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return { entry, root };
}

function invoke(t, fixture, args) {
  const output = path.join(fixture.root, `result-${Math.random().toString(16).slice(2)}.json`);
  const result = spawnSync(process.execPath, [fixture.entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, PIHUB_RUNTIME_TEST_OUTPUT: output },
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const value = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(value.argv[1], fixture.entry);
  return value;
}

test("the exact internal sentinel enters Next while preserving the wrapper argv path", (t) => {
  const fixture = createFixture(t);
  assert.match(fixture.entry, / /);
  const value = invoke(t, fixture, [INTERNAL_NEXT_SENTINEL, "start", "-p", "30141"]);
  assert.equal(value.kind, "server");
  assert.deepEqual(value.argv.slice(2), ["start", "-p", "30141"]);
});

test("ordinary arguments enter the bundled Pi CLI while preserving the wrapper argv path", (t) => {
  const fixture = createFixture(t);
  const value = invoke(t, fixture, ["--version"]);
  assert.equal(value.kind, "pi");
  assert.deepEqual(value.argv.slice(2), ["--version"]);
});

test("the standalone pi launcher reaches the bundled Pi CLI through an ESM import", (t) => {
  const fixture = createFixture(t);
  const launcher = path.join(fixture.root, "bin", "pi-launcher.mjs");
  fs.writeFileSync(launcher, `
process.env.PIHUB_STANDALONE_LAUNCHER = "1";
await import(${JSON.stringify(fixture.entry)});
`);
  const output = path.join(fixture.root, `result-${Math.random().toString(16).slice(2)}.json`);
  const result = spawnSync(process.execPath, [launcher, "--version"], {
    encoding: "utf8",
    env: { ...process.env, PIHUB_RUNTIME_TEST_OUTPUT: output },
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  // ESM import leaves require.main undefined; without the launcher marker the
  // runtime entry stays inert and nothing is written at all.
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).kind, "pi");
});

test("an unmarked ESM import keeps the runtime entry inert", (t) => {
  const fixture = createFixture(t);
  const launcher = path.join(fixture.root, "bin", "bare-import.mjs");
  fs.writeFileSync(launcher, `
await import(${JSON.stringify(fixture.entry)});
console.log("import-completed");
`);
  const result = spawnSync(process.execPath, [launcher], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /import-completed/);
});

test("forged or misplaced sentinels cannot enter the Server runtime", async (t) => {
  const fixture = createFixture(t);
  for (const args of [
    [`${INTERNAL_NEXT_SENTINEL}-suffix`],
    [`prefix-${INTERNAL_NEXT_SENTINEL}`],
    ["--version", INTERNAL_NEXT_SENTINEL],
  ]) {
    await t.test(args.join(" "), () => {
      const value = invoke(t, fixture, args);
      assert.equal(value.kind, "pi");
      assert.deepEqual(value.argv.slice(2), args);
    });
  }
});
