import fs from "node:fs";
import path from "node:path";

// Cross-checks the pinned default extension manifest. The same name/version
// pairs are mirrored in five places; extensions/package.json is the source of
// truth because its lockfile pins the exact dependency tree.
//
// Mirrors that must stay in sync:
//   1. extensions/package.json          (source of truth)
//   2. scripts/default-extension-bundle.mjs
//   3. src/lib.ts
//   4. src-tauri/src/setup.rs
//   5. server/lib/default-extensions.ts

const MIRRORS = [
  "scripts/default-extension-bundle.mjs",
  "src/lib.ts",
  "src-tauri/src/setup.rs",
  "server/lib/default-extensions.ts",
];

const ENTRY_PATTERN = /name:\s*"([^"]+)",\s*version:\s*"([^"]+)"/g;

export function readManifest(root) {
  const manifestPath = path.join(root, "extensions", "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const dependencies = manifest.dependencies ?? {};
  return new Map(Object.entries(dependencies).map(([name, version]) => [name, String(version)]));
}

export function readMirror(root, relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const entries = new Map();
  for (const match of source.matchAll(ENTRY_PATTERN)) {
    const [, name, version] = match;
    if (entries.has(name)) throw new Error(`${relativePath}: duplicate extension entry ${name}`);
    entries.set(name, version);
  }
  return entries;
}

export function checkExtensionManifest(root) {
  const issues = [];
  const expected = readManifest(root);
  if (!expected.size) issues.push("extensions/package.json: dependencies is empty");
  for (const relativePath of MIRRORS) {
    let entries;
    try {
      entries = readMirror(root, relativePath);
    } catch (cause) {
      issues.push(`${relativePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    if (entries.size !== expected.size) {
      issues.push(`${relativePath}: expected ${expected.size} extension entries, found ${entries.size}`);
    }
    for (const [name, version] of expected) {
      const actual = entries.get(name);
      if (actual === undefined) issues.push(`${relativePath}: missing ${name}@${version}`);
      else if (actual !== version) issues.push(`${relativePath}: ${name} is ${actual}, expected ${version}`);
    }
    for (const name of entries.keys()) {
      if (!expected.has(name)) issues.push(`${relativePath}: unexpected entry ${name} not present in extensions/package.json`);
    }
  }
  return issues;
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const issues = checkExtensionManifest(root);
  if (issues.length) {
    console.error("Extension manifest drift detected:");
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }
  console.log(`Extension manifest OK: ${readManifest(root).size} packages consistent across ${MIRRORS.length + 1} sources.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.dirname, "check-extension-manifest.mjs")) {
  main();
}
