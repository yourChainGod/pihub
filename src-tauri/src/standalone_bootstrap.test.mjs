import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import test, { after } from "node:test";

const OWNER = "pihub-test";
const REPO = "pihub";
const CHANNEL = "stable";
const VERSION = "0.0.1";
const PI_AGENT = "@earendil-works/pi-coding-agent";
const PI_AGENT_VERSION = "0.84.2";
const MANIFEST_URL = `https://github.com/${OWNER}/${REPO}/releases/latest/download/release-manifest.json`;
const MANIFEST_DOMAIN = "PIHUB-RELEASE-MANIFEST-V1\n";
const ASSET_DOMAIN = "PIHUB-RELEASE-ASSET-V1\n";
const EXTENSIONS = [
  { name: "@cortexkit/pi-magic-context", version: "0.38.0", resource: "dist/index.js" },
  { name: "pi-todo-rail", version: "0.2.3", resource: "index.ts" },
  { name: "@ff-labs/pi-fff", version: "0.10.5", resource: "src/index.ts" },
  { name: "pi-simplify", version: "0.2.3", resource: "dist/index.js" },
  { name: "@gotgenes/pi-permission-system", version: "26.3.0", resource: "src/index.ts" },
  { name: "@eko24ive/pi-ask", version: "1.2.0", resource: "src/index.ts", skill: "skills/README.md" },
  { name: "@gotgenes/pi-subagents", version: "19.3.2", resource: "src/index.ts" },
];

const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-standalone-test-"));
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const helperSource = fs.readFileSync(new URL("./standalone_bootstrap.mjs", import.meta.url), "utf8")
  .replaceAll("__RELEASE_OWNER__", OWNER)
  .replaceAll("__RELEASE_REPO__", REPO)
  .replaceAll("__RELEASE_CHANNEL__", CHANNEL)
  .replaceAll("__RELEASE_PUBLIC_KEY__", publicKeyRaw)
  .replaceAll("__RELEASE_MANIFEST_URL__", MANIFEST_URL)
  .replaceAll("__MINIMUM_SERVER_VERSION__", VERSION)
  .replaceAll("__PI_AGENT_PACKAGE__", PI_AGENT)
  .replaceAll("__PI_AGENT_VERSION__", PI_AGENT_VERSION)
  .replaceAll(
    "__EXTENSION_PACKAGES_BASE64__",
    Buffer.from(JSON.stringify(EXTENSIONS.map(({ name, version }) => ({ name, version })))).toString("base64"),
  );
const helperFile = path.join(suiteRoot, "standalone-bootstrap-rendered.mjs");
fs.writeFileSync(helperFile, helperSource, { mode: 0o600 });
const bootstrap = await import(pathToFileURL(helperFile).href);

after(() => fs.rmSync(suiteRoot, { force: true, recursive: true }));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeTarText(header, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error(`tar field is too long: ${value}`);
  encoded.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeTarText(header, offset, length, `${encoded}\0`);
}

function tarHeader({ name, data, type = "0", linkname = "" }) {
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, name);
  writeTarOctal(header, 100, 8, type === "5" ? 0o755 : 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, data.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeTarText(header, 156, 1, type);
  writeTarText(header, 157, 100, linkname);
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function createArchive(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    chunks.push(tarHeader({ ...entry, data }), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

function runtimeEntries({ extensions = false } = {}) {
  const files = new Map([
    ["package.json", JSON.stringify({ name: "@pihub/server", version: VERSION })],
    [".next/BUILD_ID", "test-build"],
    ["node_modules/next/package.json", JSON.stringify({ name: "next", version: "15.5.7" })],
    ["node_modules/next/dist/bin/next", "module.exports = {};\n"],
    [`node_modules/${PI_AGENT}/package.json`, JSON.stringify({ name: PI_AGENT, version: PI_AGENT_VERSION })],
    [`node_modules/${PI_AGENT}/dist/cli.js`, "console.log('0.84.2');\n"],
    ["bin/pi-web.js", "#!/usr/bin/env node\n"],
    ["bin/runtime-entry.js", "#!/usr/bin/env node\n"],
    ["bin/pihub-server-install.js", "#!/usr/bin/env node\n"],
  ]);
  if (extensions) {
    for (const relative of [
      "bin/default-extensions.js",
      "lib/default-extensions.ts",
      "lib/release-manifest.ts",
      "node_modules/jiti/package.json",
      "node_modules/jiti/lib/jiti.cjs",
      "node_modules/jiti/dist/jiti.cjs",
      "node_modules/jiti/dist/babel.cjs",
    ]) {
      files.set(relative, fs.readFileSync(new URL(`../../server/${relative}`, import.meta.url)));
    }
    for (const [relative, contents] of extensionBundleFiles()) {
      files.set(`extensions/${relative}`, contents);
    }
  }
  return [...files.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, data]) => ({ name, data }));
}

function extensionBundleFiles() {
  const dependencies = Object.fromEntries(EXTENSIONS.map(({ name, version }) => [name, version]));
  const files = new Map();
  files.set("package.json", JSON.stringify({
    name: "@pihub/default-extensions",
    version: VERSION,
    private: true,
    engines: { node: ">=22.19.0" },
    dependencies,
  }));
  const packages = {
    "": {
      name: "@pihub/default-extensions",
      version: VERSION,
      dependencies,
    },
  };
  for (const extension of EXTENSIONS) {
    const packageRoot = `node_modules/${extension.name}`;
    files.set(`${packageRoot}/package.json`, JSON.stringify({
      name: extension.name,
      version: extension.version,
    }));
    files.set(`${packageRoot}/${extension.resource}`, "export default function extension() {}\n");
    if (extension.skill) files.set(`${packageRoot}/${extension.skill}`, "# Ask\n");
    packages[packageRoot] = {
      version: extension.version,
      resolved: `https://registry.npmjs.org/${extension.name}/-/${extension.name.split("/").at(-1)}-${extension.version}.tgz`,
      integrity: `sha512-${"A".repeat(88)}`,
    };
  }
  files.set("package-lock.json", JSON.stringify({
    name: "@pihub/default-extensions",
    version: VERSION,
    lockfileVersion: 3,
    requires: true,
    packages,
  }));
  const inventoryFiles = [...files.entries()]
    .map(([filePath, contents]) => {
      const bytes = Buffer.from(contents, "utf8");
      return { path: filePath, size: bytes.length, sha256: sha256(bytes) };
    })
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  files.set("inventory.json", bootstrap.canonicalizeReleaseJson({
    schemaVersion: 1,
    packages: EXTENSIONS.map(({ name, version }) => ({ name, version })),
    files: inventoryFiles,
    totalBytes: inventoryFiles.reduce((sum, entry) => sum + entry.size, 0),
  }));
  return files;
}

function currentTarget() {
  const platform = process.platform;
  const arch = process.arch;
  assert.ok(new Set(["darwin", "linux", "win32"]).has(platform));
  assert.ok(new Set(["arm64", "x64"]).has(arch));
  return { platform, arch };
}

function signedRelease(archive, overrides = {}) {
  const target = currentTarget();
  const asset = {
    version: VERSION,
    platform: target.platform,
    arch: target.arch,
    url: `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/pihub-server-${VERSION}-${target.platform}-${target.arch}.tar.gz`,
    sha256: overrides.sha256 ?? sha256(archive),
    size: overrides.size ?? archive.length,
  };
  const assetSignature = sign(
    null,
    Buffer.from(`${ASSET_DOMAIN}${bootstrap.canonicalizeReleaseJson(asset)}`),
    privateKey,
  ).toString("base64url");
  const manifestUnsigned = {
    schemaVersion: 1,
    owner: OWNER,
    repo: REPO,
    channel: CHANNEL,
    version: VERSION,
    assets: [{ ...asset, signature: assetSignature }],
  };
  const signature = sign(
    null,
    Buffer.from(`${MANIFEST_DOMAIN}${bootstrap.canonicalizeReleaseJson(manifestUnsigned)}`),
    privateKey,
  ).toString("base64url");
  const manifest = { ...manifestUnsigned, signature };
  return {
    asset: manifest.assets[0],
    manifest,
    text: bootstrap.canonicalizeReleaseJson(manifest),
  };
}

function releaseFetch(release, archive, requests = []) {
  return async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === MANIFEST_URL) {
      return new Response(release.text, {
        status: 200,
        headers: { "Content-Length": String(Buffer.byteLength(release.text)) },
      });
    }
    if (url === release.asset.url) {
      return new Response(archive, {
        status: 200,
        headers: {
          "Content-Length": String(archive.length),
          "Content-Type": "application/octet-stream",
        },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
}

function installFixture(t, archive, release, overrides = {}) {
  const root = fs.mkdtempSync(path.join(suiteRoot, "install-"));
  const dataRoot = path.join(root, "data");
  const home = path.join(root, "home");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const env = {
    PATH: process.env.PATH ?? "",
    APPDATA: appData,
    LOCALAPPDATA: appData,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  return {
    root,
    dataRoot,
    home,
    env,
    options: {
      allowRootForTests: true,
      dataRoot,
      env,
      fetchImpl: releaseFetch(release, archive),
      healthCheck: async () => undefined,
      home,
      piVerifier: async () => undefined,
      serviceRunner: async () => undefined,
      target: currentTarget(),
      ...overrides,
    },
  };
}

function changedSignature(value) {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

test("a valid signed standalone release installs without invoking npm or npx", async (t) => {
  const archive = createArchive(runtimeEntries());
  const release = signedRelease(archive);
  const fixture = installFixture(t, archive, release);
  const canaryDirectory = path.join(fixture.root, "canary bin");
  const canaryFile = path.join(fixture.root, "package-manager-called");
  fs.mkdirSync(canaryDirectory);
  for (const name of ["npm", "npx"]) {
    const executable = path.join(canaryDirectory, name);
    fs.writeFileSync(executable, `#!/bin/sh\nprintf called > '${canaryFile}'\nexit 91\n`, { mode: 0o755 });
  }
  for (const name of ["npm.cmd", "npx.cmd"]) {
    fs.writeFileSync(path.join(canaryDirectory, name), `@echo called>${canaryFile}\r\n@exit /b 91\r\n`);
  }
  fixture.options.env.PATH = `${canaryDirectory}${path.delimiter}${fixture.options.env.PATH}`;

  const result = await bootstrap.installStandaloneRelease(fixture.options);

  assert.deepEqual(result, { version: VERSION, installed: true });
  assert.equal(fs.existsSync(canaryFile), false);
  assert.equal(
    fs.readFileSync(path.join(fixture.dataRoot, "state", "current.json"), "utf8"),
    bootstrap.canonicalizeReleaseJson({ schemaVersion: 1, version: VERSION }),
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.dataRoot, "state", "default-extensions.json"), "utf8"),
    bootstrap.canonicalizeReleaseJson({ schemaVersion: 1, enabled: false }),
  );
  assert.equal(fs.existsSync(path.join(fixture.dataRoot, "versions", VERSION, "bin", "runtime-entry.js")), true);
});

test("manifest and asset signature tampering is rejected", () => {
  const archive = createArchive(runtimeEntries());
  const release = signedRelease(archive);
  const trust = bootstrap.createReleaseTrust({ owner: OWNER, repo: REPO, channel: CHANNEL, publicKey: publicKeyRaw });
  const badManifest = { ...release.manifest, signature: changedSignature(release.manifest.signature) };
  assert.throws(
    () => bootstrap.parseAndVerifyReleaseManifest(bootstrap.canonicalizeReleaseJson(badManifest), trust),
    /manifest signature/i,
  );
  const badAssetManifest = {
    ...release.manifest,
    assets: [{ ...release.asset, signature: changedSignature(release.asset.signature) }],
  };
  assert.throws(
    () => bootstrap.parseAndVerifyReleaseManifest(bootstrap.canonicalizeReleaseJson(badAssetManifest), trust),
    /asset signature/i,
  );
});

test("signed hash and size mismatches are rejected", async (t) => {
  const archive = createArchive(runtimeEntries());
  await t.test("hash", async (t) => {
    const release = signedRelease(archive, { sha256: "0".repeat(64) });
    const fixture = installFixture(t, archive, release);
    await assert.rejects(bootstrap.installStandaloneRelease(fixture.options), /integrity verification/i);
  });
  await t.test("size", async (t) => {
    const release = signedRelease(archive, { size: archive.length + 1 });
    const fixture = installFixture(t, archive, release);
    await assert.rejects(bootstrap.installStandaloneRelease(fixture.options), /size verification/i);
  });
});

test("GitHub redirects to an untrusted host are rejected", async (t) => {
  const archive = createArchive(runtimeEntries());
  const release = signedRelease(archive);
  const fixture = installFixture(t, archive, release, {
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { Location: "https://example.com/stolen-release.json" },
    }),
  });
  await assert.rejects(bootstrap.installStandaloneRelease(fixture.options), /redirect.*not allowed/i);
});

test("the portable extractor rejects traversal, links, and case collisions", async (t) => {
  const cases = [
    ["traversal", [{ name: "../escape", data: "x" }], /unsafe path/i],
    ["symlink", [{ name: "link", type: "2", linkname: "target", data: "" }], /link or special/i],
    ["case collision", [{ name: "A.txt", data: "a" }, { name: "a.txt", data: "b" }], /colliding paths/i],
  ];
  for (const [name, entries, expected] of cases) {
    await t.test(name, async (t) => {
      const root = fs.mkdtempSync(path.join(suiteRoot, "archive-"));
      const archiveFile = path.join(root, "release.tar.gz");
      const destination = path.join(root, "destination");
      const archive = createArchive(entries);
      fs.writeFileSync(archiveFile, archive);
      fs.mkdirSync(destination);
      t.after(() => fs.rmSync(root, { force: true, recursive: true }));
      await assert.rejects(
        bootstrap.extractStandaloneArchive(archiveFile, destination, archive.length),
        expected,
      );
      assert.equal(fs.existsSync(path.join(root, "escape")), false);
    });
  }
});

test("Linux musl and unknown libc targets fail closed", () => {
  assert.throws(
    () => bootstrap.detectReleaseTarget({ platform: "linux", arch: "x64", reportHeader: {} }),
    /musl and unknown libc/i,
  );
  assert.deepEqual(
    bootstrap.detectReleaseTarget({
      platform: "linux",
      arch: "arm64",
      reportHeader: { glibcVersionRuntime: "2.39" },
    }),
    { platform: "linux", arch: "arm64" },
  );
});

test("requesting extensions fails closed when the signed archive has no extension bundle", async (t) => {
  const archive = createArchive(runtimeEntries());
  const release = signedRelease(archive);
  const fixture = installFixture(t, archive, release, { withExtensions: true });
  await assert.rejects(
    bootstrap.installStandaloneRelease(fixture.options),
    /does not contain the required extension bundle/i,
  );
});

test("a successful install activates all signed extensions from the signed version", async (t) => {
  const archive = createArchive(runtimeEntries({ extensions: true }));
  const release = signedRelease(archive);
  const serviceCalls = [];
  const fixture = installFixture(t, archive, release, {
    withExtensions: true,
    serviceRunner: async (versionRoot, command) => serviceCalls.push({ command, versionRoot }),
  });

  await bootstrap.installStandaloneRelease(fixture.options);

  assert.deepEqual(serviceCalls.map(({ command }) => command), ["install"]);
  assert.equal(
    fs.readFileSync(path.join(fixture.dataRoot, "state", "default-extensions.json"), "utf8"),
    bootstrap.canonicalizeReleaseJson({
      schemaVersion: 1,
      enabled: true,
      selectedPackages: EXTENSIONS.map(({ name, version }) => ({ name, version })),
    }),
  );
  const settings = JSON.parse(fs.readFileSync(path.join(fixture.home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, EXTENSIONS.map(({ name }) => `pihub/packages/${name}`));
  const permission = JSON.parse(fs.readFileSync(
    path.join(fixture.home, ".pi", "agent", "extensions", "pi-permission-system", "config.json"),
    "utf8",
  ));
  assert.equal(permission.permission.path["*.env"], "deny");
  assert.equal(permission.permission.bash["rm -rf /"], "deny");
});

test("a selected extension subset activates only the checked package", async (t) => {
  const archive = createArchive(runtimeEntries({ extensions: true }));
  const release = signedRelease(archive);
  const fixture = installFixture(t, archive, release, {
    selectedExtensions: [{ name: EXTENSIONS[1].name, version: EXTENSIONS[1].version }],
  });

  await bootstrap.installStandaloneRelease(fixture.options);

  const settings = JSON.parse(fs.readFileSync(path.join(fixture.home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [`pihub/packages/${EXTENSIONS[1].name}`]);
  assert.equal(fs.existsSync(path.join(fixture.home, ".pi", "agent", "pihub", "packages", ...EXTENSIONS[0].name.split("/"), "package.json")), false);
  assert.equal(fs.existsSync(path.join(fixture.home, ".pi", "agent", "extensions")), false);
  assert.equal(
    fs.readFileSync(path.join(fixture.dataRoot, "state", "default-extensions.json"), "utf8"),
    bootstrap.canonicalizeReleaseJson({
      schemaVersion: 1,
      enabled: true,
      selectedPackages: [{ name: EXTENSIONS[1].name, version: EXTENSIONS[1].version }],
    }),
  );
});

test("a service failure restores extension settings and managed facade files", async (t) => {
  const archive = createArchive(runtimeEntries({ extensions: true }));
  const release = signedRelease(archive);
  const fixture = installFixture(t, archive, release, {
    withExtensions: true,
    serviceRunner: async () => { throw new Error("service canary failure"); },
  });
  const agentDirectory = path.join(fixture.home, ".pi", "agent");
  const settings = path.join(agentDirectory, "settings.json");
  const permission = path.join(agentDirectory, "extensions", "pi-permission-system", "config.json");
  const originalSettings = "{\"packages\":[\"existing-package\"]}\n";
  const originalPermission = "{\"original\":\"permission\"}\n";
  fs.mkdirSync(path.dirname(permission), { recursive: true });
  fs.writeFileSync(settings, originalSettings);
  fs.writeFileSync(permission, originalPermission);

  await assert.rejects(bootstrap.installStandaloneRelease(fixture.options), /service canary failure/);

  assert.equal(fs.readFileSync(settings, "utf8"), originalSettings);
  assert.equal(fs.readFileSync(permission, "utf8"), originalPermission);
  assert.equal(fs.existsSync(path.join(fixture.dataRoot, "state", "default-extensions.json")), false);
  for (const extension of EXTENSIONS) {
    assert.equal(
      fs.existsSync(path.join(agentDirectory, "pihub", "packages", ...extension.name.split("/"), "package.json")),
      false,
    );
  }
});

test("an extension provisioning failure rolls back settings and facade files", async (t) => {
  const archive = createArchive(runtimeEntries({ extensions: true }));
  const release = signedRelease(archive);
  const fixture = installFixture(t, archive, release, { withExtensions: true });
  const agentDirectory = path.join(fixture.home, ".pi", "agent");
  const settings = path.join(agentDirectory, "settings.json");
  const permission = path.join(agentDirectory, "extensions", "pi-permission-system", "config.json");
  const originalSettings = "{\"packages\":[\"existing-package\"]}\n";
  fs.mkdirSync(permission, { recursive: true });
  fs.writeFileSync(settings, originalSettings);

  await assert.rejects(bootstrap.installStandaloneRelease(fixture.options), /state file is invalid/i);

  assert.equal(fs.readFileSync(settings, "utf8"), originalSettings);
  assert.equal(fs.statSync(permission).isDirectory(), true);
  for (const extension of EXTENSIONS) {
    assert.equal(
      fs.existsSync(path.join(agentDirectory, "pihub", "packages", ...extension.name.split("/"), "package.json")),
      false,
    );
  }
});

test("a service-phase crash journal rolls forward and repairs mixed extension facades", async (t) => {
  const archive = createArchive(runtimeEntries({ extensions: true }));
  const release = signedRelease(archive);
  const fixture = installFixture(t, archive, release, { withExtensions: true });
  await bootstrap.installStandaloneRelease(fixture.options);

  const damagedFacade = path.join(
    fixture.home,
    ".pi",
    "agent",
    "pihub",
    "packages",
    ...EXTENSIONS[0].name.split("/"),
    "package.json",
  );
  fs.writeFileSync(damagedFacade, JSON.stringify({ name: EXTENSIONS[0].name, pi: {} }));
  const stagingId = "c".repeat(32);
  fs.mkdirSync(path.join(fixture.dataRoot, "staging", stagingId), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.dataRoot, "state", "bootstrap-install.json"),
    bootstrap.canonicalizeReleaseJson({
      schemaVersion: 4,
      phase: "service",
      version: VERSION,
      previousVersion: null,
      previousPointerExisted: false,
      defaultExtensionsEnabled: true,
      selectedExtensions: EXTENSIONS.map(({ name, version }) => ({ name, version })),
      previousDefaultExtensions: null,
      stagingId,
    }),
  );
  const serviceCalls = [];
  const recoveryOptions = {
    ...fixture.options,
    fetchImpl: async () => { throw new Error("stop after recovery"); },
    serviceRunner: async (versionRoot, command) => serviceCalls.push({ command, versionRoot }),
  };

  await assert.rejects(bootstrap.installStandaloneRelease(recoveryOptions), /release request timed out/);

  assert.deepEqual(serviceCalls.map(({ command }) => command), ["install"]);
  assert.equal(fs.existsSync(path.join(fixture.dataRoot, "state", "bootstrap-install.json")), false);
  const repaired = JSON.parse(fs.readFileSync(damagedFacade, "utf8"));
  assert.equal(repaired.name, EXTENSIONS[0].name);
  assert.equal(repaired.version, EXTENSIONS[0].version);
  assert.equal(Array.isArray(repaired.pi.extensions), true);
  assert.equal(
    repaired.pi.extensions[0],
    path.join(
      fixture.dataRoot,
      "versions",
      VERSION,
      "extensions",
      "node_modules",
      ...EXTENSIONS[0].name.split("/"),
      ...EXTENSIONS[0].resource.split("/"),
    ),
  );
});


test("a local prebuilt archive installs without GitHub or signatures", async (t) => {
  const archive = createArchive(runtimeEntries());
  const archivePath = path.join(suiteRoot, "local-release.tar.gz");
  fs.writeFileSync(archivePath, archive);
  const fixture = installFixture(t, archive, null, {
    fetchImpl: async () => {
      throw new Error("network must not be used in local archive mode");
    },
    localAsset: { path: archivePath, sha256: sha256(archive) },
  });

  const result = await bootstrap.installStandaloneRelease(fixture.options);

  assert.deepEqual(result, { version: VERSION, installed: true });
  assert.equal(
    fs.readFileSync(path.join(fixture.dataRoot, "state", "current.json"), "utf8"),
    bootstrap.canonicalizeReleaseJson({ schemaVersion: 1, version: VERSION }),
  );
  assert.equal(fs.existsSync(path.join(fixture.dataRoot, "versions", VERSION, "bin", "runtime-entry.js")), true);
});

test("a local archive with a wrong or malformed sha256 is rejected", async (t) => {
  const archive = createArchive(runtimeEntries());
  const archivePath = path.join(suiteRoot, "local-tampered.tar.gz");
  fs.writeFileSync(archivePath, archive);

  const tampered = installFixture(t, archive, null, {
    localAsset: { path: archivePath, sha256: sha256("tampered") },
  });
  await assert.rejects(bootstrap.installStandaloneRelease(tampered.options), /integrity verification/i);
  assert.equal(fs.existsSync(path.join(tampered.dataRoot, "versions", VERSION)), false);

  const malformed = installFixture(t, archive, null, {
    localAsset: { path: archivePath, sha256: "not-a-sha256" },
  });
  await assert.rejects(bootstrap.installStandaloneRelease(malformed.options), /sha256 is invalid/i);
});

test("extension inventory accepts a full-size bundle file list", () => {
  // 72 locked packages pull in thousands of runtime files (onnxruntime/sharp);
  // the strict parser node cap must scale with MAX_EXTENSION_FILES.
  const files = [];
  for (let index = 0; index < 6000; index += 1) {
    files.push({
      path: `node_modules/@cortexkit/pi-magic-context/dist/f${String(index).padStart(5, "0")}.js`,
      size: 1,
      sha256: "a".repeat(64),
    });
  }
  const expected = EXTENSIONS.map(({ name, version }) => ({ name, version }));
  const raw = bootstrap.canonicalizeReleaseJson({
    schemaVersion: 1,
    packages: expected,
    files,
    totalBytes: files.length,
  });
  const parsed = bootstrap.parseExtensionInventory(raw, expected);
  assert.equal(parsed.files.length, 6000);
});

test("sanitized child environment keeps the explicit root-install opt-in", () => {
  const env = bootstrap.sanitizedChildEnvironment({
    PATH: "/usr/bin",
    PIHUB_ALLOW_ROOT: "1",
    PIHUB_ALLOW_ADMIN: "1",
    PIHUB_LOCAL_ARCHIVE: "/tmp/should-not-propagate.tgz",
    AWS_SECRET_ACCESS_KEY: "nope",
  });
  assert.equal(env.PIHUB_ALLOW_ROOT, "1");
  assert.equal(env.PIHUB_ALLOW_ADMIN, "1");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal("PIHUB_LOCAL_ARCHIVE" in env, false);
  assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);
});
