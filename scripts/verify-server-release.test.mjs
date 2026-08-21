import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import {
  createServerStagingInventory,
  verifyServerReleaseArchive,
  verifyServerReleaseDirectory,
} from "./verify-server-release.mjs";
import { normalizeServerReleaseSbom } from "./server-release-sbom.mjs";
import { addDefaultExtensionFixture } from "./default-extension-test-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const SERVER_VERSION = JSON.parse(fs.readFileSync(path.join(root, "server", "package.json"), "utf8")).version;
const require = createRequire(import.meta.url);
const tar = require(require.resolve("tar", { paths: [path.join(root, "server")] }));

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-release-scan-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const staging = path.join(directory, "staging");
  fs.mkdirSync(path.join(staging, ".next"), { recursive: true });
  fs.writeFileSync(path.join(staging, "package.json"), `{"name":"@pihub/server","version":"${SERVER_VERSION}"}\n`);
  fs.writeFileSync(path.join(staging, ".next", "BUILD_ID"), "portable-build\n");
  fs.writeFileSync(path.join(staging, "runtime.js"), "module.exports = 'clean';\n");
  await addDefaultExtensionFixture(staging);
  return { archive: path.join(directory, "server.tar.gz"), directory, staging };
}

function collectRegularFiles(staging) {
  const files = [];
  const visit = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile()) files.push(childRelative);
    }
  };
  visit(staging, "");
  return files.sort();
}

async function pack(staging, archive, files = collectRegularFiles(staging)) {
  await tar.create({
    cwd: staging,
    file: archive,
    gzip: true,
    noDirRecurse: true,
    noMtime: true,
    portable: true,
    strict: true,
  }, files);
}

function sha256(filename) {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function packagePurl(packageName, version) {
  const encodedName = packageName.startsWith("@")
    ? `${encodeURIComponent(packageName.slice(0, packageName.indexOf("/")))}/${encodeURIComponent(packageName.slice(packageName.indexOf("/") + 1))}`
    : encodeURIComponent(packageName);
  return `pkg:npm/${encodedName}@${version}`;
}

function npmSbomComponent(packageName, version, packagePath) {
  return {
    "bom-ref": `${packageName}@${version}`,
    type: "library",
    name: packageName,
    version,
    purl: packagePurl(packageName, version),
    properties: [{ name: "cdx:npm:package:path", value: packagePath }],
  };
}

function npmSbomDocument(packageName, version, components, rootDependencies) {
  const rootReference = `${packageName}@${version}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
    version: 1,
    metadata: {
      timestamp: "2026-08-19T00:00:00.000Z",
      component: {
        "bom-ref": rootReference,
        type: "application",
        name: "npm-generated-stage",
        version,
        purl: packagePurl(packageName, version),
        properties: [{ name: "cdx:npm:package:path", value: "" }],
      },
    },
    components,
    dependencies: [
      { ref: rootReference, dependsOn: rootDependencies },
      ...components.map((component) => ({ ref: component["bom-ref"], dependsOn: [] })),
    ],
  };
}

test("streaming Server release scan matches every staged file by path, size, and hash", async (t) => {
  const { archive, staging } = await fixture(t);
  const expectedInventory = await createServerStagingInventory(staging);
  await pack(staging, archive);
  const result = await verifyServerReleaseArchive(archive, { expectedInventory });
  assert.equal(result.entries, expectedInventory.files.length);
  assert.equal(result.files.length, expectedInventory.files.length);
  assert.equal(result.extensions.packages.length, 7);
  assert.equal(result.totalFileBytes, expectedInventory.totalBytes);

  fs.writeFileSync(path.join(staging, "runtime.js"), "module.exports = 'other';\n");
  const changedInventory = await createServerStagingInventory(staging);
  await assert.rejects(
    verifyServerReleaseArchive(archive, { expectedInventory: changedInventory }),
    /does not match the staging inventory/,
  );
});

test("streaming Server release scan rejects private paths without disclosing the username", async (t) => {
  const { archive, staging } = await fixture(t);
  const privatePath = ["", "Users", ["private", "builder"].join("-"), "credentials", "models.json"].join("/");
  fs.writeFileSync(path.join(staging, "runtime.js"), `module.exports = ${JSON.stringify(privatePath)};\n`);
  await pack(staging, archive);
  await assert.rejects(
    verifyServerReleaseArchive(archive),
    (error) => {
      assert.match(error.message, /privacy scan failed \(absolute-user-path/);
      assert.equal(error.message.includes("private-builder"), false);
      return true;
    },
  );
});

test("streaming Server release scan enforces entry and expansion limits", async (t) => {
  const { archive, staging } = await fixture(t);
  await pack(staging, archive);
  await assert.rejects(
    verifyServerReleaseArchive(archive, { limits: { maxEntries: 2 } }),
    /too many entries/,
  );
  await assert.rejects(
    verifyServerReleaseArchive(archive, { limits: { maxExpandedBytes: 512 } }),
    /streamed expansion limit/,
  );
});

test("streaming Server release scan rejects links and special entries", async (t) => {
  const { archive, staging } = await fixture(t);
  fs.symlinkSync("runtime.js", path.join(staging, "runtime-link.js"));
  await tar.create({
    cwd: staging,
    file: archive,
    gzip: true,
    noDirRecurse: true,
    noMtime: true,
    portable: true,
    strict: true,
  }, ["runtime-link.js"]);
  await assert.rejects(
    verifyServerReleaseArchive(archive),
    /only regular files/,
  );
});

test("streaming Server release scan enforces extension lock, inventory, and NOTICE semantics", async (t) => {
  const inventoryFixture = await fixture(t);
  fs.appendFileSync(path.join(inventoryFixture.staging, "extensions", "inventory.json"), "\n");
  await pack(inventoryFixture.staging, inventoryFixture.archive);
  await assert.rejects(
    verifyServerReleaseArchive(inventoryFixture.archive),
    /inventory is not canonical/,
  );

  const lockFixture = await fixture(t);
  const lockPath = path.join(lockFixture.staging, "extensions", "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.packages["node_modules/pi-simplify"].resolved = "https://packages.example.invalid/pi-simplify.tgz";
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await pack(lockFixture.staging, lockFixture.archive);
  await assert.rejects(
    verifyServerReleaseArchive(lockFixture.archive),
    /official npm registry|unsafe npm registry/,
  );

  const noticeFixture = await fixture(t);
  fs.appendFileSync(
    path.join(noticeFixture.staging, "THIRD_PARTY_NOTICES.extensions.txt"),
    "tampered\n",
  );
  await pack(noticeFixture.staging, noticeFixture.archive);
  await assert.rejects(
    verifyServerReleaseArchive(noticeFixture.archive),
    /notices do not match/,
  );
});

test("Server release directory binds archive, SBOM, checksum, and metadata", async (t) => {
  const { directory, staging } = await fixture(t);
  const release = path.join(directory, "release");
  fs.mkdirSync(release);
  const base = `pihub-server-${SERVER_VERSION}-darwin-arm64`;
  const archiveName = `${base}.tar.gz`;
  const archive = path.join(release, archiveName);
  const dependencyDirectory = path.join(staging, "node_modules", "fixture-dependency");
  fs.mkdirSync(dependencyDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(dependencyDirectory, "package.json"),
    '{"name":"fixture-dependency","version":"1.2.3"}\n',
  );
  fs.writeFileSync(path.join(staging, "package-lock.json"), `${JSON.stringify({
    name: "@pihub/server",
    version: SERVER_VERSION,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "@pihub/server", version: "0.0.1" },
      "node_modules/fixture-dependency": { version: "1.2.3" },
    },
  }, null, 2)}\n`);
  const extensionRoot = path.join(staging, "extensions");
  const extensionPackages = collectRegularFiles(extensionRoot)
    .filter((relative) => relative.startsWith("node_modules/") && relative.endsWith("/package.json"))
    .map((relative) => {
      const metadata = JSON.parse(fs.readFileSync(path.join(extensionRoot, relative), "utf8"));
      return npmSbomComponent(metadata.name, metadata.version, relative.slice(0, -"/package.json".length));
    });
  const extensionSbom = npmSbomDocument(
    "@pihub/default-extensions",
    SERVER_VERSION,
    extensionPackages,
    extensionPackages.map((component) => component["bom-ref"]),
  );
  await pack(staging, archive);
  const sbomName = `${base}.cdx.json`;
  const sbom = path.join(release, sbomName);
  const fixtureDependency = npmSbomComponent(
    "fixture-dependency",
    "1.2.3",
    "node_modules/fixture-dependency",
  );
  const serverSbom = npmSbomDocument(
    "@pihub/server",
    SERVER_VERSION,
    [fixtureDependency],
    [fixtureDependency["bom-ref"]],
  );
  const sbomDocument = normalizeServerReleaseSbom(serverSbom, extensionSbom, {
    arch: "arm64",
    archiveName,
    archiveSha256: sha256(archive),
    archiveSize: fs.statSync(archive).size,
    packageName: "@pihub/server",
    platform: "darwin",
    stagingDirectory: staging,
    version: SERVER_VERSION,
  });
  fs.writeFileSync(sbom, `${JSON.stringify(sbomDocument, null, 2)}\n`);
  fs.writeFileSync(path.join(release, `${archiveName}.sha256`), `${sha256(archive)}  ${archiveName}\n`);
  const assetManifestPath = path.join(release, `${base}.asset.json`);
  const assetManifest = {
    schemaVersion: 1,
    version: SERVER_VERSION,
    platform: "darwin",
    arch: "arm64",
    filename: archiveName,
    sha256: sha256(archive),
    size: fs.statSync(archive).size,
    sbom: sbomName,
    sbomSha256: sha256(sbom),
  };
  fs.writeFileSync(assetManifestPath, `${JSON.stringify(assetManifest)}\n`);

  const result = await verifyServerReleaseDirectory(release);
  assert.equal(result.archive.extensions.packages.length, 7);
  fs.appendFileSync(sbom, "tampered\n");
  await assert.rejects(verifyServerReleaseDirectory(release), /hash does not match/);

  fs.writeFileSync(sbom, `${JSON.stringify(sbomDocument, null, 2)}\n`);
  const platformProperty = sbomDocument.metadata.properties.find(
    ({ name }) => name === "pihub:release:platform",
  );
  platformProperty.value = "linux";
  fs.writeFileSync(sbom, `${JSON.stringify(sbomDocument, null, 2)}\n`);
  assetManifest.sbomSha256 = sha256(sbom);
  fs.writeFileSync(assetManifestPath, `${JSON.stringify(assetManifest)}\n`);
  await assert.rejects(verifyServerReleaseDirectory(release), /release binding is missing or inconsistent/);
});
