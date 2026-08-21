import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkExtensionManifest, readManifest, readMirror } from "./check-extension-manifest.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-ext-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "src-tauri", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "server", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "extensions", "package.json"), JSON.stringify({
    name: "@pihub/default-extensions",
    dependencies: { "pkg-a": "1.0.0", "pkg-b": "2.0.0" },
  }));
  const mirror = 'Object.freeze({ name: "pkg-a", version: "1.0.0" }),\nObject.freeze({ name: "pkg-b", version: "2.0.0" })';
  fs.writeFileSync(path.join(root, "scripts", "default-extension-bundle.mjs"), mirror);
  fs.writeFileSync(path.join(root, "src", "lib.ts"), mirror);
  fs.writeFileSync(path.join(root, "src-tauri", "src", "setup.rs"), 'PinnedNpmPackage {\n name: "pkg-a",\n version: "1.0.0",\n},\nPinnedNpmPackage {\n name: "pkg-b",\n version: "2.0.0",\n}');
  fs.writeFileSync(path.join(root, "server", "lib", "default-extensions.ts"), mirror);
  return root;
}

test("real repository manifest is consistent across all mirrors", () => {
  assert.deepEqual(checkExtensionManifest(repositoryRoot), []);
  assert.equal(readManifest(repositoryRoot).size, 7);
  for (const mirror of ["src/lib.ts", "src-tauri/src/setup.rs", "server/lib/default-extensions.ts", "scripts/default-extension-bundle.mjs"]) {
    assert.equal(readMirror(repositoryRoot, mirror).size, 7, `${mirror} should pin 7 extensions`);
  }
});

test("consistent fixture passes", (t) => {
  assert.deepEqual(checkExtensionManifest(makeFixture(t)), []);
});

test("version drift in one mirror is reported", (t) => {
  const root = makeFixture(t);
  fs.writeFileSync(path.join(root, "src", "lib.ts"), 'Object.freeze({ name: "pkg-a", version: "9.9.9" }),\nObject.freeze({ name: "pkg-b", version: "2.0.0" })');
  const issues = checkExtensionManifest(root);
  assert.ok(issues.some((issue) => issue.includes("src/lib.ts") && issue.includes("pkg-a") && issue.includes("9.9.9")), `unexpected issues: ${issues.join("; ")}`);
});

test("missing entry in one mirror is reported", (t) => {
  const root = makeFixture(t);
  fs.writeFileSync(path.join(root, "server", "lib", "default-extensions.ts"), 'Object.freeze({ name: "pkg-a", version: "1.0.0" })');
  const issues = checkExtensionManifest(root);
  assert.ok(issues.some((issue) => issue.includes("default-extensions.ts") && issue.includes("missing pkg-b")), `unexpected issues: ${issues.join("; ")}`);
});
