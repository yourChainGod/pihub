import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  DEFAULT_EXTENSIONS,
  defaultExtensionsPreferenceText,
  inspectDefaultExtensions,
  provisionDefaultExtensions,
  readDefaultExtensionsPreference,
  validateDefaultExtensionBundle,
} = await jiti.import("./default-extensions.ts");
const { canonicalizeReleaseJson } = await jiti.import("./release-manifest.ts");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function releaseFixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pihub-default-extensions-${label}-`));
  const extensionRoot = path.join(root, "extensions");
  const dependencies = Object.fromEntries(DEFAULT_EXTENSIONS.map(({ name, version }) => [name, version]));
  const files = new Map([
    ["package.json", JSON.stringify({ name: "@pihub/default-extensions", version: "0.0.1", private: true, dependencies })],
    ["package-lock.json", JSON.stringify({ name: "@pihub/default-extensions", version: "0.0.1", lockfileVersion: 3, packages: {} })],
  ]);
  for (const extension of DEFAULT_EXTENSIONS) {
    const packageRoot = `node_modules/${extension.name}`;
    files.set(`${packageRoot}/package.json`, JSON.stringify({ name: extension.name, version: extension.version }));
    for (const entry of extension.extensions) files.set(`${packageRoot}/${entry}`, "export default function extension() {}\n");
    for (const directory of extension.skills ?? []) files.set(`${packageRoot}/${directory}/README.md`, "# Skill\n");
  }
  for (const [relative, contents] of files) write(path.join(extensionRoot, ...relative.split("/")), contents);
  const inventoryFiles = [...files.entries()]
    .map(([filePath, contents]) => ({
      path: filePath,
      size: Buffer.byteLength(contents),
      sha256: sha256(contents),
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  write(path.join(extensionRoot, "inventory.json"), canonicalizeReleaseJson({
    schemaVersion: 1,
    packages: DEFAULT_EXTENSIONS.map(({ name, version }) => ({ name, version })),
    files: inventoryFiles,
    totalBytes: inventoryFiles.reduce((total, entry) => total + entry.size, 0),
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function agentFixture(t) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-agent-extensions-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  return agentDir;
}

function facadeFile(agentDir, name) {
  return path.join(agentDir, "pihub", "packages", ...name.split("/"), "package.json");
}

test("provisions five signed extensions, preserves custom settings, and removes legacy Magic Context", async (t) => {
  const release = releaseFixture(t, "install");
  const agentDir = agentFixture(t);
  write(path.join(agentDir, "settings.json"), JSON.stringify({
    theme: "dark",
    packages: [
      "custom-package",
      "npm:@cortexkit/pi-magic-context@0.38.0",
      "pihub/packages/@cortexkit/pi-magic-context",
    ],
  }));
  write(facadeFile(agentDir, "@cortexkit/pi-magic-context"), "{\"legacy\":true}\n");

  const provisioned = await provisionDefaultExtensions(release, {
    agentDir,
    expectedPackages: DEFAULT_EXTENSIONS.map(({ name, version }) => ({ name, version })),
  });

  assert.equal(provisioned.status.installed, true);
  assert.equal(provisioned.status.installedCount, 5);
  const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.packages, [
    "custom-package",
    ...DEFAULT_EXTENSIONS.map(({ name }) => `pihub/packages/${name}`),
  ]);
  assert.equal(fs.existsSync(facadeFile(agentDir, "@cortexkit/pi-magic-context")), false);
  const permission = fs.readFileSync(path.join(agentDir, "extensions", "pi-permission-system", "config.json"), "utf8");
  const permissionConfig = JSON.parse(permission);
  assert.equal(permissionConfig.$schema.endsWith("/permissions.schema.json"), true);
  assert.equal(permissionConfig.permission.path["*.env"], "deny");
  assert.equal(permissionConfig.permission.path["~/.ssh/*"], "deny");
  assert.equal(permissionConfig.permission.bash["rm -rf /"], "deny");
  assert.equal(permissionConfig.permission.bash["git push --force*"], "ask");
  assert.equal((await inspectDefaultExtensions(release, { agentDir })).installed, true);
});

test("default extension preference is canonical, bounded, and fails closed", async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-extension-preference-"));
  const preference = path.join(dataRoot, "state", "default-extensions.json");
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));

  assert.equal(await readDefaultExtensionsPreference(dataRoot), false);
  write(preference, defaultExtensionsPreferenceText(true));
  assert.equal(await readDefaultExtensionsPreference(dataRoot), true);
  fs.writeFileSync(preference, '{"enabled":true,"schemaVersion":1}\n');
  await assert.rejects(readDefaultExtensionsPreference(dataRoot), /preference is invalid/);
});

test("switches every facade to the activated version and can restore exact previous bytes", async (t) => {
  const first = releaseFixture(t, "first");
  const second = releaseFixture(t, "second");
  const agentDir = agentFixture(t);
  await provisionDefaultExtensions(first, { agentDir });
  const settingsFile = path.join(agentDir, "settings.json");
  const originalSettings = fs.readFileSync(settingsFile);
  const originalFacades = new Map(DEFAULT_EXTENSIONS.map(({ name }) => [name, fs.readFileSync(facadeFile(agentDir, name))]));

  const switched = await provisionDefaultExtensions(second, { agentDir });
  for (const extension of DEFAULT_EXTENSIONS) {
    assert.match(fs.readFileSync(facadeFile(agentDir, extension.name), "utf8"), new RegExp(second.replaceAll("\\", "\\\\")));
  }
  await switched.rollback();

  assert.deepEqual(fs.readFileSync(settingsFile), originalSettings);
  for (const extension of DEFAULT_EXTENSIONS) {
    assert.deepEqual(fs.readFileSync(facadeFile(agentDir, extension.name)), originalFacades.get(extension.name));
  }
  assert.equal((await inspectDefaultExtensions(first, { agentDir })).installed, true);
});

test("repairs a crash-like mixed facade state idempotently", async (t) => {
  const first = releaseFixture(t, "crash-first");
  const second = releaseFixture(t, "crash-second");
  const agentDir = agentFixture(t);
  await provisionDefaultExtensions(first, { agentDir });
  const damaged = facadeFile(agentDir, DEFAULT_EXTENSIONS[0].name);
  fs.writeFileSync(damaged, JSON.stringify({ name: DEFAULT_EXTENSIONS[0].name, version: DEFAULT_EXTENSIONS[0].version, pi: {} }));
  assert.equal((await inspectDefaultExtensions(first, { agentDir })).installed, false);

  await provisionDefaultExtensions(second, { agentDir });
  const status = await inspectDefaultExtensions(second, { agentDir });
  assert.equal(status.installed, true);
  assert.equal(status.installedCount, DEFAULT_EXTENSIONS.length);
});

test("rolls back facade and settings writes when a later configuration target is unsafe", async (t) => {
  const first = releaseFixture(t, "rollback-first");
  const second = releaseFixture(t, "rollback-second");
  const agentDir = agentFixture(t);
  await provisionDefaultExtensions(first, { agentDir });
  const before = new Map([
    ["settings", fs.readFileSync(path.join(agentDir, "settings.json"))],
    ...DEFAULT_EXTENSIONS.map(({ name }) => [name, fs.readFileSync(facadeFile(agentDir, name))]),
  ]);
  const permissionFile = path.join(agentDir, "extensions", "pi-permission-system", "config.json");
  fs.rmSync(permissionFile);
  fs.mkdirSync(permissionFile);

  await assert.rejects(
    provisionDefaultExtensions(second, { agentDir }),
    /state file is invalid/,
  );

  assert.deepEqual(fs.readFileSync(path.join(agentDir, "settings.json")), before.get("settings"));
  for (const extension of DEFAULT_EXTENSIONS) {
    assert.deepEqual(fs.readFileSync(facadeFile(agentDir, extension.name)), before.get(extension.name));
  }
  assert.equal(fs.statSync(permissionFile).isDirectory(), true);
});

test("rejects extension tampering and contract drift before touching Pi settings", async (t) => {
  const release = releaseFixture(t, "tamper");
  const agentDir = agentFixture(t);
  const entry = path.join(release, "extensions", "node_modules", "pi-simplify", "dist", "index.js");
  fs.appendFileSync(entry, "tampered\n");

  await assert.rejects(validateDefaultExtensionBundle(release), /metadata|digest/);
  await assert.rejects(
    provisionDefaultExtensions(release, {
      agentDir,
      expectedPackages: DEFAULT_EXTENSIONS.slice(0, -1),
    }),
    /contract does not match/,
  );
  assert.equal(fs.existsSync(path.join(agentDir, "settings.json")), false);
});

test("runtime provisioner has no package-manager, network, shell, or subprocess path", () => {
  const source = fs.readFileSync(new URL("./default-extensions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:(?:child_process|https?|net)|\bfetch\s*\(|\b(?:spawn|execFile|runNpmCli|runNpxPackage)\s*\(/i);
  assert.doesNotMatch(source, /npm install|npx |legacy-peer-deps|shell\s*:/i);
});
