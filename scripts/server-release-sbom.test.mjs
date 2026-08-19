import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeServerReleaseSbom,
  verifyServerReleaseSbom,
} from "./server-release-sbom.mjs";

const VERSION = "0.0.1";
const SERVER_NAME = "@pihub/server";
const EXTENSION_NAME = "@pihub/default-extensions";
const SHARED_NAME = "shared-package";
const EXTENSION_ONLY_NAME = "extension-only";
const OMITTED_PI_NAME = "@earendil-works/pi-ai";

function packagePurl(packageName, version) {
  const encodedName = packageName.startsWith("@")
    ? `${encodeURIComponent(packageName.slice(0, packageName.indexOf("/")))}/${encodeURIComponent(packageName.slice(packageName.indexOf("/") + 1))}`
    : encodeURIComponent(packageName);
  return `pkg:npm/${encodedName}@${version}`;
}

function component(packageName, version, packagePath, extra = {}) {
  return {
    "bom-ref": `${packageName}@${version}`,
    type: "library",
    name: packageName,
    version,
    scope: "required",
    purl: packagePurl(packageName, version),
    properties: [{ name: "cdx:npm:package:path", value: packagePath }],
    licenses: [{ license: { id: "MIT" } }],
    ...extra,
  };
}

function npmDocument(packageName, generatedName, components, dependencies) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000000",
    metadata: {
      timestamp: "2026-01-01T00:00:00.000Z",
      component: {
        "bom-ref": `${packageName}@${VERSION}`,
        type: "application",
        name: generatedName,
        version: VERSION,
        scope: "required",
        purl: packagePurl(packageName, VERSION),
        properties: [{ name: "cdx:npm:package:path", value: "" }],
      },
    },
    components,
    dependencies,
  };
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function writePackage(treeRoot, relative, packageName, version) {
  writeJson(path.join(treeRoot, relative, "package.json"), { name: packageName, version });
}

function createFixture(t) {
  const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-server-sbom-"));
  t.after(() => fs.rmSync(stagingDirectory, { recursive: true, force: true }));
  const extensionRoot = path.join(stagingDirectory, "extensions");

  writePackage(stagingDirectory, "", SERVER_NAME, VERSION);
  writePackage(stagingDirectory, "node_modules/shared-package", SHARED_NAME, "1.0.0");
  writePackage(extensionRoot, "", EXTENSION_NAME, VERSION);
  writePackage(extensionRoot, "node_modules/shared-package", SHARED_NAME, "1.0.0");
  writePackage(extensionRoot, "node_modules/extension-only", EXTENSION_ONLY_NAME, "2.0.0");

  writeJson(path.join(stagingDirectory, "package-lock.json"), {
    name: SERVER_NAME,
    version: VERSION,
    lockfileVersion: 3,
    packages: {
      "": { name: SERVER_NAME, version: VERSION },
      "node_modules/shared-package": { version: "1.0.0" },
    },
  });
  writeJson(path.join(extensionRoot, "package-lock.json"), {
    name: EXTENSION_NAME,
    version: VERSION,
    lockfileVersion: 3,
    packages: {
      "": { name: EXTENSION_NAME, version: VERSION },
      "node_modules/shared-package": { version: "1.0.0" },
      "node_modules/extension-only": { version: "2.0.0" },
      "node_modules/@earendil-works/pi-ai": { version: "0.84.2", peer: true },
    },
  });

  const serverRootReference = `${SERVER_NAME}@${VERSION}`;
  const extensionRootReference = `${EXTENSION_NAME}@${VERSION}`;
  const sharedReference = `${SHARED_NAME}@1.0.0`;
  const extensionOnlyReference = `${EXTENSION_ONLY_NAME}@2.0.0`;
  const omittedPiReference = `${OMITTED_PI_NAME}@0.84.2`;
  const serverSbom = npmDocument(
    SERVER_NAME,
    "random-server-stage",
    [component(SHARED_NAME, "1.0.0", "node_modules/shared-package")],
    [
      { ref: serverRootReference, dependsOn: [sharedReference] },
      { ref: sharedReference, dependsOn: [] },
    ],
  );
  const extensionSbom = npmDocument(
    EXTENSION_NAME,
    "random-extension-stage",
    [
      component(SHARED_NAME, "1.0.0", "node_modules/shared-package"),
      component(EXTENSION_ONLY_NAME, "2.0.0", "node_modules/extension-only"),
      component(OMITTED_PI_NAME, "0.84.2", "node_modules/@earendil-works/pi-ai"),
    ],
    [
      { ref: extensionRootReference, dependsOn: [sharedReference, extensionOnlyReference] },
      { ref: sharedReference, dependsOn: [] },
      { ref: extensionOnlyReference, dependsOn: [omittedPiReference] },
      { ref: omittedPiReference, dependsOn: [] },
    ],
  );
  const release = {
    arch: process.arch,
    archiveName: `pihub-server-${VERSION}-${process.platform}-${process.arch}.tar.gz`,
    archiveSha256: "a".repeat(64),
    archiveSize: 1024,
    packageName: SERVER_NAME,
    platform: process.platform,
    stagingDirectory,
    version: VERSION,
  };
  return { extensionRoot, extensionSbom, release, serverSbom, stagingDirectory };
}

function normalizeFixture(fixture) {
  return normalizeServerReleaseSbom(fixture.serverSbom, fixture.extensionSbom, fixture.release);
}

function packagePaths(componentValue) {
  return componentValue.properties
    .filter((property) => property.name === "cdx:npm:package:path")
    .map((property) => property.value)
    .sort();
}

function archiveInventory(document) {
  const packageJsonPaths = [document.metadata.component, ...document.components]
    .flatMap((componentValue) => packagePaths(componentValue))
    .map((relative) => relative ? `${relative}/package.json` : "package.json");
  return {
    files: [...new Set(packageJsonPaths)].map((relative) => ({
      path: relative,
      sha256: "b".repeat(64),
      size: 1,
    })),
  };
}

function releaseVerificationOptions(release, inventory) {
  const options = { ...release };
  delete options.stagingDirectory;
  return { ...options, archiveInventory: inventory };
}

test("merged Server SBOM is physical, canonical, and byte-stable", (t) => {
  const fixture = createFixture(t);
  const first = normalizeFixture(fixture);
  const second = normalizeFixture(fixture);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.metadata.component.name, "server");
  assert.equal("timestamp" in first.metadata, false);
  assert.match(first.serialNumber, /^urn:uuid:[a-f0-9-]{36}$/);

  const extensionRoot = first.components.find((entry) => entry["bom-ref"] === `${EXTENSION_NAME}@${VERSION}`);
  assert.ok(extensionRoot);
  assert.equal(extensionRoot.name, "default-extensions");
  assert.deepEqual(packagePaths(extensionRoot), ["extensions"]);
  const shared = first.components.filter((entry) => entry["bom-ref"] === `${SHARED_NAME}@1.0.0`);
  assert.equal(shared.length, 1);
  assert.deepEqual(packagePaths(shared[0]), [
    "extensions/node_modules/shared-package",
    "node_modules/shared-package",
  ]);
  assert.equal(first.components.some((entry) => entry.name === OMITTED_PI_NAME), false);

  const rootDependency = first.dependencies.find((entry) => entry.ref === `${SERVER_NAME}@${VERSION}`);
  assert.ok(rootDependency.dependsOn.includes(`${EXTENSION_NAME}@${VERSION}`));
  const references = [first.metadata.component, ...first.components].map((entry) => entry["bom-ref"]);
  assert.equal(new Set(references).size, references.length);
  assert.equal(first.dependencies.length, references.length);
  assert.deepEqual(
    Object.fromEntries(first.metadata.properties.map(({ name, value }) => [name, value])),
    {
      "pihub:release:arch": fixture.release.arch,
      "pihub:release:archive:name": fixture.release.archiveName,
      "pihub:release:archive:sha256": fixture.release.archiveSha256,
      "pihub:release:archive:size": String(fixture.release.archiveSize),
      "pihub:release:platform": fixture.release.platform,
    },
  );

  const inventory = archiveInventory(first);
  assert.equal(
    verifyServerReleaseSbom(first, releaseVerificationOptions(fixture.release, inventory)),
    first,
  );
});

test("normalization rejects unsafe extension component paths", (t) => {
  const fixture = createFixture(t);
  fixture.extensionSbom.components[0].properties[0].value = "../outside";
  assert.throws(() => normalizeFixture(fixture), /package path is unsafe/);
});

test("normalization rejects a required package missing from staging", (t) => {
  const fixture = createFixture(t);
  fs.rmSync(path.join(fixture.extensionRoot, "node_modules/extension-only"), { recursive: true });
  assert.throws(
    () => normalizeFixture(fixture),
    /required dependency does not resolve to a physical package/,
  );
});

test("normalization accepts a missing lock-marked optional package", (t) => {
  const fixture = createFixture(t);
  const optional = component("optional-platform-package", "3.0.0", "node_modules/optional-platform-package", {
    scope: "optional",
  });
  fixture.extensionSbom.components.push(optional);
  const rootDependency = fixture.extensionSbom.dependencies
    .find((entry) => entry.ref === `${EXTENSION_NAME}@${VERSION}`);
  rootDependency.dependsOn.push(optional["bom-ref"]);
  fixture.extensionSbom.dependencies.push({ ref: optional["bom-ref"], dependsOn: [] });
  const lockPath = path.join(fixture.extensionRoot, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.packages["node_modules/optional-platform-package"] = { version: "3.0.0", optional: true };
  writeJson(lockPath, lock);

  const normalized = normalizeFixture(fixture);
  assert.equal(normalized.components.some((entry) => entry.name === optional.name), false);
});

test("normalization rejects an incomplete npm dependency graph", (t) => {
  const fixture = createFixture(t);
  fixture.extensionSbom.dependencies = fixture.extensionSbom.dependencies
    .filter((entry) => entry.ref !== `${EXTENSION_ONLY_NAME}@2.0.0`);
  assert.throws(() => normalizeFixture(fixture), /dependency graph is incomplete/);
});

test("normalization rejects conflicting metadata for one cross-tree reference", (t) => {
  const fixture = createFixture(t);
  fixture.extensionSbom.components[0].licenses = [{ license: { id: "Apache-2.0" } }];
  assert.throws(
    () => normalizeFixture(fixture),
    /reuses a component reference for different metadata/,
  );
});

test("verification rejects a missing Server-to-extension root edge", (t) => {
  const fixture = createFixture(t);
  const normalized = normalizeFixture(fixture);
  const rootDependency = normalized.dependencies.find((entry) => entry.ref === `${SERVER_NAME}@${VERSION}`);
  rootDependency.dependsOn = rootDependency.dependsOn
    .filter((reference) => reference !== `${EXTENSION_NAME}@${VERSION}`);
  assert.throws(
    () => verifyServerReleaseSbom(normalized, releaseVerificationOptions(fixture.release)),
    /root dependency on default extensions is missing/,
  );
});

test("verification rejects package paths outside the four release domains", (t) => {
  const fixture = createFixture(t);
  const normalized = normalizeFixture(fixture);
  const extensionOnly = normalized.components.find((entry) => entry.name === EXTENSION_ONLY_NAME);
  extensionOnly.properties.find((entry) => entry.name === "cdx:npm:package:path").value = "other/node_modules/extension-only";
  assert.throws(
    () => verifyServerReleaseSbom(normalized, releaseVerificationOptions(fixture.release)),
    /outside the installed package trees/,
  );
});

test("verification binds every package path to the signed archive inventory", (t) => {
  const fixture = createFixture(t);
  const normalized = normalizeFixture(fixture);
  const inventory = archiveInventory(normalized);
  inventory.files = inventory.files.filter(
    (entry) => entry.path !== "extensions/node_modules/extension-only/package.json",
  );
  assert.throws(
    () => verifyServerReleaseSbom(
      normalized,
      releaseVerificationOptions(fixture.release, inventory),
    ),
    /package path is missing from the release archive inventory/,
  );
});

test("verification rejects an incomplete normalized dependency graph", (t) => {
  const fixture = createFixture(t);
  const normalized = normalizeFixture(fixture);
  normalized.dependencies = normalized.dependencies
    .filter((entry) => entry.ref !== `${EXTENSION_ONLY_NAME}@2.0.0`);
  assert.throws(
    () => verifyServerReleaseSbom(normalized, releaseVerificationOptions(fixture.release)),
    /dependency graph is incomplete/,
  );
});

test("verification rejects duplicate component references", (t) => {
  const fixture = createFixture(t);
  const normalized = normalizeFixture(fixture);
  normalized.components.push(structuredClone(normalized.components.find((entry) => entry.name === EXTENSION_ONLY_NAME)));
  assert.throws(
    () => verifyServerReleaseSbom(normalized, releaseVerificationOptions(fixture.release)),
    /component references are not unique/,
  );
});

test("release binding rejects archive metadata replay", (t) => {
  const fixture = createFixture(t);
  const normalized = normalizeFixture(fixture);
  assert.throws(
    () => verifyServerReleaseSbom(normalized, {
      ...releaseVerificationOptions(fixture.release),
      archiveSha256: "b".repeat(64),
    }),
    /serial number is not bound|release binding is missing/,
  );
});
