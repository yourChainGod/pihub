import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DESKTOP_BINARY_NAME,
  DESKTOP_BUNDLE_IDENTIFIER,
  DESKTOP_KEYRING_SERVICE,
  DESKTOP_PACKAGE_NAME,
  DESKTOP_PRODUCT_NAME,
  DESKTOP_RELEASE_REPOSITORY,
  DESKTOP_UPDATE_CHANNEL,
  DESKTOP_UPDATE_KIND,
  DESKTOP_UPDATE_MANIFEST_NAME,
  DESKTOP_UPDATE_SIGNATURE_NAME,
  DESKTOP_UPDATER_ENDPOINT,
  DESKTOP_UPDATER_SIGNATURE_ENDPOINT,
  LEGACY_DESKTOP_BUNDLE_IDENTIFIER,
  LEGACY_DESKTOP_KEYRING_SERVICE,
} from "./product-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function cargoPackageValue(source, key) {
  const packageSection = source.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
  return packageSection?.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1];
}

function rustStringConstant(source, name) {
  return source.match(new RegExp(`const ${name}:\\s*&str\\s*=\\s*"([^"]+)"`))?.[1];
}

test("desktop product identity stays consistent across npm, Cargo, and Tauri", () => {
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const cargoToml = read("src-tauri/Cargo.toml");
  const cargoLock = read("src-tauri/Cargo.lock");
  const tauri = readJson("src-tauri/tauri.conf.json");
  const macos = readJson("src-tauri/tauri.macos.conf.json");
  const windows = readJson("src-tauri/tauri.windows.conf.json");
  const linux = readJson("src-tauri/tauri.linux.conf.json");
  const main = read("src-tauri/src/main.rs");

  assert.equal(packageJson.name, DESKTOP_PACKAGE_NAME);
  assert.equal(packageLock.name, DESKTOP_PACKAGE_NAME);
  assert.equal(packageLock.packages?.[""]?.name, DESKTOP_PACKAGE_NAME);
  assert.equal(cargoPackageValue(cargoToml, "name"), DESKTOP_PACKAGE_NAME);
  assert.match(
    cargoLock,
    new RegExp(`\\[\\[package\\]\\]\\nname = "${DESKTOP_PACKAGE_NAME}"\\nversion = "0\\.0\\.1"`),
  );
  assert.equal(tauri.productName, DESKTOP_PRODUCT_NAME);
  assert.equal(tauri.mainBinaryName, DESKTOP_BINARY_NAME);
  assert.equal(tauri.identifier, DESKTOP_BUNDLE_IDENTIFIER);
  assert.equal(macos.bundle?.macOS?.bundleName, DESKTOP_PRODUCT_NAME);
  assert.equal(windows.bundle?.windows?.nsis?.startMenuFolder, DESKTOP_PRODUCT_NAME);
  assert.deepEqual(linux.bundle?.targets, ["appimage", "deb"]);
  assert.match(main, /pihub_desktop_lib::run\(\)/);
});

test("desktop v1 updater identity is pinned and has no legacy manifest fallback", () => {
  const updater = read("src-tauri/src/desktop_updater.rs");
  const security = read("src-tauri/src/desktop_updater_security.rs");
  const updaterRuntime = updater.split("#[cfg(test)]")[0];
  const securityRuntime = security.split("#[cfg(test)]")[0];
  const preparation = read("scripts/prepare-tauri-release.mjs");
  const releaseCheck = read("scripts/check-release-config.mjs");

  assert.equal(DESKTOP_RELEASE_REPOSITORY, "yourChainGod/pihub");
  assert.equal(DESKTOP_UPDATE_MANIFEST_NAME, "pihub-desktop-v1.json");
  assert.equal(DESKTOP_UPDATE_SIGNATURE_NAME, "pihub-desktop-v1.json.sig");
  assert.equal(DESKTOP_UPDATE_CHANNEL, "desktop-v1-stable");
  assert.equal(DESKTOP_UPDATE_KIND, "pihub.desktop-v1-update-manifest");
  assert.equal(
    DESKTOP_UPDATER_ENDPOINT,
    `https://github.com/${DESKTOP_RELEASE_REPOSITORY}/releases/latest/download/${DESKTOP_UPDATE_MANIFEST_NAME}`,
  );
  assert.equal(DESKTOP_UPDATER_SIGNATURE_ENDPOINT, `${DESKTOP_UPDATER_ENDPOINT}.sig`);

  assert.ok(updater.includes(`"${DESKTOP_UPDATER_ENDPOINT}"`));
  assert.ok(security.includes(`"${DESKTOP_UPDATER_SIGNATURE_ENDPOINT}"`));
  assert.equal(rustStringConstant(security, "RELEASE_CHANNEL"), DESKTOP_UPDATE_CHANNEL);
  assert.equal(rustStringConstant(security, "RELEASE_KIND"), DESKTOP_UPDATE_KIND);
  assert.match(preparation, /import\s*\{[\s\S]*DESKTOP_UPDATER_ENDPOINT[\s\S]*\}\s*from "\.\/product-identity\.mjs"/);
  assert.match(releaseCheck, /from "\.\/product-identity\.mjs"/);

  for (const [label, source] of [
    ["Tauri updater runtime", updaterRuntime],
    ["Tauri updater security", securityRuntime],
    ["release config preparation", preparation],
  ]) {
    assert.doesNotMatch(source, /releases\/latest\/download\/latest\.json(?:\.sig)?/, `${label} must not fall back to latest.json`);
  }
});

test("active credential and bundle identities cannot alias the legacy 0.2.1 install", () => {
  // lib.rs is split into domain modules; device identity lives in devices.rs
  // and keyring identity in credentials.rs.
  const deviceModule = read("src-tauri/src/devices.rs");
  const credentialModule = read("src-tauri/src/credentials.rs");
  const rust = `${deviceModule}\n${credentialModule}`;
  const identityModule = read("scripts/product-identity.mjs");

  assert.notEqual(DESKTOP_BUNDLE_IDENTIFIER, LEGACY_DESKTOP_BUNDLE_IDENTIFIER);
  assert.notEqual(DESKTOP_KEYRING_SERVICE, LEGACY_DESKTOP_KEYRING_SERVICE);
  assert.equal(rustStringConstant(rust, "PIHUB_DESKTOP_BUNDLE_IDENTIFIER"), DESKTOP_BUNDLE_IDENTIFIER);
  assert.equal(rustStringConstant(rust, "PIHUB_KEYRING_SERVICE"), DESKTOP_KEYRING_SERVICE);
  assert.equal(rustStringConstant(rust, "LEGACY_DESKTOP_BUNDLE_IDENTIFIER"), LEGACY_DESKTOP_BUNDLE_IDENTIFIER);
  assert.equal(rustStringConstant(rust, "LEGACY_DESKTOP_KEYRING_SERVICE"), LEGACY_DESKTOP_KEYRING_SERVICE);

  for (const legacyValue of [LEGACY_DESKTOP_BUNDLE_IDENTIFIER, LEGACY_DESKTOP_KEYRING_SERVICE]) {
    for (const [relativePath, source] of [
      ["scripts/product-identity.mjs", identityModule],
      ["src-tauri/src/devices.rs + credentials.rs", rust],
    ]) {
      const lines = source.split("\n").flatMap((line, index) =>
        line.includes(legacyValue) ? [{ line: index + 1, text: line }] : []
      );
      assert.ok(lines.length > 0, `${relativePath} must retain an explicit legacy identity constant`);
      for (const occurrence of lines) {
        assert.match(
          occurrence.text,
          /LEGACY_DESKTOP_(?:BUNDLE_IDENTIFIER|KEYRING_SERVICE)/,
          `${relativePath}:${occurrence.line} uses a legacy identity outside its named migration boundary`,
        );
      }
    }
  }

  assert.match(rust, /fn import_legacy_device_metadata\(/);
  assert.match(rust, /credentials_migrated:\s*false/);
  assert.doesNotMatch(rust, /keyring::Entry::new\(\s*LEGACY_DESKTOP_KEYRING_SERVICE/);
});
