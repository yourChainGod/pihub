import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyServerLock, verifyServerLockFiles } from "./verify-server-lock.mjs";

const root = path.resolve(import.meta.dirname, "..");

function integrityFor(value = "pihub-lock-fixture") {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

function emptyFixture() {
  const packageJson = {
    name: "@pihub/server",
    version: "0.0.1",
    dependencies: {},
  };
  const packageLock = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: packageJson.name,
        version: packageJson.version,
        dependencies: {},
      },
    },
  };
  return { packageJson, packageLock };
}

function externalFixture() {
  const fixture = emptyFixture();
  fixture.packageJson.dependencies.fixture = "1.2.3";
  fixture.packageLock.packages[""].dependencies.fixture = "1.2.3";
  fixture.packageLock.packages["node_modules/fixture"] = {
    version: "1.2.3",
    resolved: "https://registry.npmjs.org/fixture/-/fixture-1.2.3.tgz",
    integrity: integrityFor(),
  };
  return fixture;
}

function linkedFixture() {
  const fixture = emptyFixture();
  fixture.packageLock.packages["node_modules/local-package"] = {
    resolved: "packages/local-package",
    link: true,
  };
  fixture.packageLock.packages["packages/local-package"] = {
    name: "local-package",
    version: "1.0.0",
  };
  return fixture;
}

function clone(value) {
  return structuredClone(value);
}

test("accepts a minimal lock with an exact production dependency", () => {
  const result = verifyServerLock(externalFixture());
  assert.deepEqual(result, {
    rootEntries: 1,
    externalEntries: 1,
    linkEntries: 0,
    linkTargetEntries: 0,
    bundledEntries: 0,
    productionDependencies: 1,
  });
});

test("accepts exact SemVer prerelease and build forms", () => {
  const fixture = externalFixture();
  const version = "1.2.3-rc.1+build.007";
  fixture.packageJson.dependencies.fixture = version;
  fixture.packageLock.packages[""].dependencies.fixture = version;
  fixture.packageLock.packages["node_modules/fixture"].version = version;
  assert.equal(verifyServerLock(fixture).productionDependencies, 1);
});

test("accepts the current Server package manifest and lock", () => {
  const packageJsonPath = path.join(root, "server", "package.json");
  const packageLockPath = path.join(root, "server", "package-lock.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
  const result = verifyServerLock({ packageJson, packageLock });
  assert.equal(result.rootEntries, 1);
  assert.equal(result.productionDependencies, Object.keys(packageJson.dependencies).length);
  assert.equal(result.externalEntries, Object.keys(packageLock.packages).length - 1);
  assert.equal(result.linkEntries, 0);
  assert.equal(result.linkTargetEntries, 0);
  assert.equal(result.bundledEntries, 0);
  assert.deepEqual(
    verifyServerLockFiles({ packageJsonPath, packageLockPath }),
    result,
  );
});

test("rejects invalid JSON and invalid lock structures fail-closed", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-lock-verifier-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packageJsonPath = path.join(directory, "package.json");
  const packageLockPath = path.join(directory, "package-lock.json");
  fs.writeFileSync(packageJsonPath, "{\n");
  fs.writeFileSync(packageLockPath, JSON.stringify(externalFixture().packageLock));
  assert.throws(
    () => verifyServerLockFiles({ packageJsonPath, packageLockPath }),
    /manifest is not valid JSON/,
  );

  const invalidVersion = externalFixture();
  invalidVersion.packageLock.lockfileVersion = 2;
  assert.throws(() => verifyServerLock(invalidVersion), /lockfileVersion 3/);

  const invalidPackages = externalFixture();
  invalidPackages.packageLock.packages = [];
  assert.throws(() => verifyServerLock(invalidPackages), /packages must be a JSON object/);

  const missingRoot = externalFixture();
  delete missingRoot.packageLock.packages[""];
  assert.throws(() => verifyServerLock(missingRoot), /missing its root package record/);
});

test("rejects tampered top-level and root identities", () => {
  const topLevel = externalFixture();
  topLevel.packageLock.version = "0.0.2";
  assert.throws(() => verifyServerLock(topLevel), /lock identity/);

  const rootIdentity = externalFixture();
  rootIdentity.packageLock.packages[""].name = "@pihub/other";
  assert.throws(() => verifyServerLock(rootIdentity), /root identity/);

  const invalidManifestVersion = externalFixture();
  invalidManifestVersion.packageJson.version = "v0.0.1";
  assert.throws(() => verifyServerLock(invalidManifestVersion), /exact SemVer/);
});

test("rejects production dependency key and value drift", () => {
  const missingKey = externalFixture();
  delete missingKey.packageLock.packages[""].dependencies.fixture;
  assert.throws(() => verifyServerLock(missingKey), /dependency keys/);

  const extraKey = externalFixture();
  extraKey.packageLock.packages[""].dependencies.extra = "1.0.0";
  assert.throws(() => verifyServerLock(extraKey), /dependency keys/);

  const changedValue = externalFixture();
  changedValue.packageLock.packages[""].dependencies.fixture = "1.2.4";
  assert.throws(() => verifyServerLock(changedValue), /does not match/);
});

test("rejects ranged, tagged, aliased, URL, git, file, and workspace production specs", () => {
  const invalidSpecs = [
    "^1.2.3",
    "~1.2.3",
    ">=1.2.3",
    "latest",
    "npm:other@1.2.3",
    "https://registry.npmjs.org/fixture/-/fixture-1.2.3.tgz",
    "git+https://example.invalid/fixture.git",
    "file:../fixture",
    "workspace:*",
  ];
  for (const spec of invalidSpecs) {
    const fixture = externalFixture();
    fixture.packageJson.dependencies.fixture = spec;
    fixture.packageLock.packages[""].dependencies.fixture = spec;
    assert.throws(() => verifyServerLock(fixture), /exact SemVer/, spec);
  }
});

test("rejects a ranged external package version", () => {
  const fixture = externalFixture();
  fixture.packageLock.packages["node_modules/fixture"].version = "^1.2.3";
  assert.throws(() => verifyServerLock(fixture), /exact SemVer/);
});

test("rejects missing and malformed SHA-512 integrity", () => {
  const missing = externalFixture();
  delete missing.packageLock.packages["node_modules/fixture"].integrity;
  assert.throws(() => verifyServerLock(missing), /missing its SHA-512 integrity/);

  const malformed = externalFixture();
  malformed.packageLock.packages["node_modules/fixture"].integrity = "sha512-not base64";
  assert.throws(() => verifyServerLock(malformed), /canonical SHA-512 integrity token/);

  const multiple = externalFixture();
  multiple.packageLock.packages["node_modules/fixture"].integrity += " sha256-deadbeef";
  assert.throws(() => verifyServerLock(multiple), /one canonical SHA-512 integrity token/);
});

test("rejects noncanonical base64 and SHA-512 values of the wrong length", () => {
  const noncanonical = externalFixture();
  noncanonical.packageLock.packages["node_modules/fixture"].integrity = integrityFor().replace(/=+$/, "");
  assert.throws(() => verifyServerLock(noncanonical), /not canonical base64/);

  const tooShort = externalFixture();
  tooShort.packageLock.packages["node_modules/fixture"].integrity = `sha512-${Buffer.alloc(63).toString("base64")}`;
  assert.throws(() => verifyServerLock(tooShort), /decode to 64 bytes/);
});

test("rejects unsafe or noncanonical resolved URLs without echoing credentials", () => {
  const cases = [
    "http://registry.npmjs.org/fixture/-/fixture-1.2.3.tgz",
    "https://registry.example/fixture/-/fixture-1.2.3.tgz",
    "https://registry.npmjs.org.evil.example/fixture/-/fixture-1.2.3.tgz",
    "https://registry.npmjs.org:444/fixture/-/fixture-1.2.3.tgz",
    "https://user:private-pass@registry.npmjs.org/fixture/-/fixture-1.2.3.tgz",
    "https://registry.npmjs.org/fixture/-/fixture-1.2.3.tgz?token=private",
    "https://registry.npmjs.org/fixture/-/fixture-1.2.3.tgz#private",
    "git:https://example.invalid/fixture.git",
    "file:../fixture.tgz",
    "workspace:fixture",
    "ftp://registry.npmjs.org/fixture.tgz",
    "unknown:fixture",
  ];
  for (const resolved of cases) {
    const fixture = externalFixture();
    fixture.packageLock.packages["node_modules/fixture"].resolved = resolved;
    assert.throws(
      () => verifyServerLock(fixture),
      (error) => {
        assert.match(error.message, /npm registry/);
        assert.equal(error.message.includes("private-pass"), false);
        assert.equal(error.message.includes("token=private"), false);
        return true;
      },
      resolved,
    );
  }
});

test("accepts a canonical registry URL with an explicit default HTTPS port", () => {
  const fixture = externalFixture();
  fixture.packageLock.packages["node_modules/fixture"].resolved =
    "https://registry.npmjs.org:443/fixture/-/fixture-1.2.3.tgz";
  assert.equal(verifyServerLock(fixture).externalEntries, 1);
});

test("validates internal link records and their targets", () => {
  const result = verifyServerLock(linkedFixture());
  assert.equal(result.linkEntries, 1);
  assert.equal(result.linkTargetEntries, 1);

  const dangling = linkedFixture();
  delete dangling.packageLock.packages["packages/local-package"];
  assert.throws(() => verifyServerLock(dangling), /dangling internal link/);

  const invalidRecord = linkedFixture();
  invalidRecord.packageLock.packages["node_modules/local-package"].version = "1.0.0";
  assert.throws(() => verifyServerLock(invalidRecord), /invalid internal link record/);
});

test("rejects absolute, traversing, encoded, URL, and non-portable link targets", () => {
  const targets = [
    "../packages/local-package",
    "/packages/local-package",
    "C:/packages/local-package",
    "packages\\local-package",
    "packages/%2e%2e/local-package",
    "https://example.invalid/local-package",
    "file:packages/local-package",
    "user@host/packages/local-package",
    "packages/./local-package",
    "packages/node_modules/local-package",
  ];
  for (const target of targets) {
    const fixture = linkedFixture();
    fixture.packageLock.packages["node_modules/local-package"].resolved = target;
    assert.throws(() => verifyServerLock(fixture), /unsafe internal link target/, target);
  }
});

test("accepts protected bundles and rejects invalid or unprotected bundles", () => {
  const valid = externalFixture();
  valid.packageLock.packages["node_modules/fixture/node_modules/bundled"] = {
    version: "2.0.0",
    inBundle: true,
  };
  const result = verifyServerLock(valid);
  assert.equal(result.bundledEntries, 1);

  const invalid = clone(valid);
  invalid.packageLock.packages["node_modules/fixture/node_modules/bundled"].resolved =
    "https://registry.npmjs.org/bundled/-/bundled-2.0.0.tgz";
  assert.throws(() => verifyServerLock(invalid), /invalid bundled package record/);

  const unprotected = emptyFixture();
  unprotected.packageLock.packages["node_modules/bundled"] = {
    version: "2.0.0",
    inBundle: true,
  };
  assert.throws(() => verifyServerLock(unprotected), /no protected external ancestor/);
});

test("rejects package records outside the root and referenced link structures", () => {
  const fixture = emptyFixture();
  fixture.packageLock.packages["vendor/unexpected"] = {
    name: "unexpected",
    version: "1.0.0",
  };
  assert.throws(() => verifyServerLock(fixture), /Unexpected package path/);
});
