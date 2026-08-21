import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalExtensionJson,
  DEFAULT_EXTENSION_SOURCE_DIRECTORY,
  installDefaultExtensionDependencies,
  verifyDefaultExtensionBundle,
  verifyDefaultExtensionSource,
} from "./default-extension-bundle.mjs";
import { addDefaultExtensionFixture } from "./default-extension-test-fixture.mjs";

const EXTENSIONS_VERSION = JSON.parse(
  fs.readFileSync(path.join(DEFAULT_EXTENSION_SOURCE_DIRECTORY, "package.json"), "utf8"),
).version;

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-extension-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function mutableSource(t) {
  const source = path.join(temporaryDirectory(t), "source");
  fs.cpSync(DEFAULT_EXTENSION_SOURCE_DIRECTORY, source, { recursive: true });
  return source;
}

async function bundleFixture(t) {
  const serverRoot = path.join(temporaryDirectory(t), "server");
  fs.mkdirSync(serverRoot);
  writeJson(path.join(serverRoot, "package.json"), {
    name: "@pihub/server",
    version: "0.0.1",
  });
  const bundle = await addDefaultExtensionFixture(serverRoot);
  return { ...bundle, serverRoot };
}

test("committed default extension manifest and lock pin the exact audited registry graph", () => {
  const result = verifyDefaultExtensionSource({ expectedVersion: EXTENSIONS_VERSION });
  assert.equal(result.lockSummary.externalEntries, 343);
  assert.equal(result.lockSummary.productionDependencies, 7);
  assert.equal(result.lockSummary.omittedPeerIntegrityEntries, 6);
  assert.equal(result.lockSummary.linkEntries, 0);
  assert.equal(result.lockSummary.bundledEntries, 0);
});

test("default extension lock rejects non-official registries and malformed SRI", (t) => {
  const source = mutableSource(t);
  const lockPath = path.join(source, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.packages["node_modules/pi-simplify"].resolved = "https://packages.example.invalid/pi-simplify.tgz";
  writeJson(lockPath, lock);
  assert.throws(() => verifyDefaultExtensionSource({ sourceDirectory: source }), /official npm registry|unsafe npm registry/);

  lock.packages["node_modules/pi-simplify"].resolved = "https://registry.npmjs.org/pi-simplify/-/pi-simplify-0.2.3.tgz";
  lock.packages["node_modules/pi-simplify"].integrity = "sha256-invalid";
  writeJson(lockPath, lock);
  assert.throws(() => verifyDefaultExtensionSource({ sourceDirectory: source }), /SHA-512/);

  delete lock.packages["node_modules/pi-simplify"].integrity;
  writeJson(lockPath, lock);
  assert.throws(() => verifyDefaultExtensionSource({ sourceDirectory: source }), /missing its SHA-512 integrity/);
});

test("default extension lock rejects a host Pi peer version drift", (t) => {
  const source = mutableSource(t);
  const lockPath = path.join(source, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.packages["node_modules/@earendil-works/pi-ai"].version = "0.85.0";
  writeJson(lockPath, lock);
  assert.throws(
    () => verifyDefaultExtensionSource({ sourceDirectory: source }),
    /must be an omitted 0\.84\.2 peer/,
  );
});

test("default extension lock rejects a structurally valid but unreviewed graph change", (t) => {
  const source = mutableSource(t);
  const lockPath = path.join(source, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.packages["node_modules/audited-looking-extra"] = {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/audited-looking-extra/-/audited-looking-extra-1.0.0.tgz",
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    license: "MIT",
  };
  writeJson(lockPath, lock);
  assert.throws(
    () => verifyDefaultExtensionSource({ sourceDirectory: source }),
    /lock graph changed without updating its audited digest/,
  );
});

test("synthetic physical bundle verifies peers, resources, inventory, and notices", async (t) => {
  const { extensionRoot, inventory, serverRoot, verification } = await bundleFixture(t);
  assert.equal(verification.version, EXTENSIONS_VERSION);
  assert.equal(verification.packages.length, 10);
  assert.equal(inventory.packages.length, 7);
  const inventorySource = fs.readFileSync(path.join(extensionRoot, "inventory.json"), "utf8");
  assert.equal(inventorySource, canonicalExtensionJson(inventory));
  assert.equal(inventorySource.endsWith("\n"), false);
  await verifyDefaultExtensionBundle(extensionRoot, { expectedVersion: EXTENSIONS_VERSION, serverRoot });
});

test("physical bundle rejects nested Pi, unreviewed lifecycle packages, and missing resources", async (t) => {
  const nested = await bundleFixture(t);
  const nestedPi = path.join(
    nested.extensionRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  );
  fs.mkdirSync(path.dirname(nestedPi), { recursive: true });
  writeJson(nestedPi, { name: "@earendil-works/pi-coding-agent", version: "0.84.2" });
  await assert.rejects(
    verifyDefaultExtensionBundle(nested.extensionRoot, { serverRoot: nested.serverRoot }),
    /nested Pi package/,
  );

  const lifecycle = await bundleFixture(t);
  const protobuf = path.join(lifecycle.extensionRoot, "node_modules", "protobufjs", "package.json");
  fs.mkdirSync(path.dirname(protobuf), { recursive: true });
  writeJson(protobuf, { name: "protobufjs", version: "7.6.5" });
  await assert.rejects(
    verifyDefaultExtensionBundle(lifecycle.extensionRoot, { serverRoot: lifecycle.serverRoot }),
    /unreviewed install script/,
  );

  const missing = await bundleFixture(t);
  fs.rmSync(path.join(missing.extensionRoot, "node_modules", "pi-simplify", "dist", "index.js"));
  await assert.rejects(
    verifyDefaultExtensionBundle(missing.extensionRoot, { serverRoot: missing.serverRoot }),
    /resource is missing or unsafe/,
  );
});

test("physical bundle rejects canonical inventory and content tampering", async (t) => {
  const trailing = await bundleFixture(t);
  fs.appendFileSync(path.join(trailing.extensionRoot, "inventory.json"), "\n");
  await assert.rejects(
    verifyDefaultExtensionBundle(trailing.extensionRoot, { serverRoot: trailing.serverRoot }),
    /inventory is not canonical/,
  );

  const changed = await bundleFixture(t);
  const inventoryPath = path.join(changed.extensionRoot, "inventory.json");
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  inventory.files[0].sha256 = "0".repeat(64);
  fs.writeFileSync(inventoryPath, canonicalExtensionJson(inventory));
  await assert.rejects(
    verifyDefaultExtensionBundle(changed.extensionRoot, { serverRoot: changed.serverRoot }),
    /does not match its inventory/,
  );
});

test("staging invokes npm with a credential-free omit-peer contract and explicit audited peer compatibility", (t) => {
  const destinationDirectory = temporaryDirectory(t);
  const calls = [];
  const previous = {
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    HOME: process.env.HOME,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY,
    NPM_TOKEN: process.env.NPM_TOKEN,
  };
  Object.assign(process.env, {
    AWS_SECRET_ACCESS_KEY: "test-only-aws-secret",
    GITHUB_TOKEN: "test-only-github-token",
    HOME: "/Users/private-extension-builder",
    HTTPS_PROXY: "https://user:password@proxy.example.invalid/",
    NODE_AUTH_TOKEN: "test-only-auth-token",
    NODE_OPTIONS: "--trace-warnings",
    NPM_CONFIG_REGISTRY: "https://packages.example.invalid/",
    NPM_TOKEN: "test-only-npm-token",
  });
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  installDefaultExtensionDependencies((args, cwd, maxBuffer, options) => {
    calls.push({ args, cwd, maxBuffer, options });
    return "";
  }, destinationDirectory);
  assert.equal(calls.length, 1);
  const [install] = calls;
  assert.equal(install.cwd, destinationDirectory);
  assert.equal(install.maxBuffer, 128 * 1024 * 1024);
  for (const flag of [
    "--ignore-scripts",
    "--omit=peer",
    "--engine-strict=true",
    "--no-bin-links",
    "--legacy-peer-deps=true",
    "--force=false",
  ]) {
    assert.ok(install.args.includes(flag), `missing npm flag ${flag}`);
  }
  assert.equal(install.options.env.NODE_AUTH_TOKEN, undefined);
  assert.equal(install.options.env.NODE_OPTIONS, undefined);
  assert.equal(install.options.env.NPM_TOKEN, undefined);
  assert.equal(install.options.env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org/");
  assert.equal(install.options.env.NPM_CONFIG_IGNORE_SCRIPTS, "true");
  assert.equal(install.options.env.NPM_CONFIG_LEGACY_PEER_DEPS, "true");
  const serializedEnvironment = JSON.stringify(install.options.env);
  assert.equal(serializedEnvironment.includes("test-only"), false);
  assert.equal(serializedEnvironment.includes("private-extension-builder"), false);
  assert.equal(serializedEnvironment.includes("password"), false);
  assert.equal(fs.existsSync(path.dirname(install.options.env.HOME)), false);
});
