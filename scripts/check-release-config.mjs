import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  DESKTOP_BINARY_NAME,
  DESKTOP_BUNDLE_IDENTIFIER,
  DESKTOP_KEYRING_SERVICE,
  DESKTOP_PACKAGE_NAME,
  DESKTOP_PRODUCT_NAME,
  DESKTOP_UPDATE_CHANNEL,
  DESKTOP_UPDATE_KIND,
  DESKTOP_UPDATER_ENDPOINT,
  DESKTOP_UPDATER_SIGNATURE_ENDPOINT,
  LEGACY_DESKTOP_BUNDLE_IDENTIFIER,
  LEGACY_DESKTOP_KEYRING_SERVICE,
} from "./product-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const EXPECTED_DESKTOP_VERSION = "0.0.1";
const PINNED_UPDATER_PUBLIC_KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU4OTk1MzI4ODJFMjMyRApSV1F0SXk2SU1wV0pEampHUEF0RnYxSTltOTM2Z0x1L0RUY0ZDaFlrcDBpWFNHUFkveU5NaDRuOQo=";

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function cargoPackageVersion(relativePath) {
  const packageSection = read(relativePath).split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
  return packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

function cargoLockVersion(relativePath, packageName) {
  const blocks = read(relativePath).split("[[package]]");
  for (const block of blocks) {
    if (block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] === packageName) {
      return block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    }
  }
  return undefined;
}

const appPackage = readJson("package.json");
const appLock = readJson("package-lock.json");
const tauri = readJson("src-tauri/tauri.conf.json");
const serverPackage = readJson("server/package.json");
const serverLock = readJson("server/package-lock.json");
const appSource = read("src/App.tsx");
// lib.rs is split into domain modules; release constants live in
// credentials.rs / devices.rs / setup.rs, so check the concatenated sources.
const rustSource = [
  "src-tauri/src/lib.rs",
  "src-tauri/src/credentials.rs",
  "src-tauri/src/devices.rs",
  "src-tauri/src/setup.rs",
].map(read).join("\n");
const desktopUpdaterSource = read("src-tauri/src/desktop_updater.rs");
const desktopUpdaterSecuritySource = read("src-tauri/src/desktop_updater_security.rs");
const cargoManifest = read("src-tauri/Cargo.toml");
const desktopCapability = readJson("src-tauri/capabilities/default.json");
const releasePreparation = read("scripts/prepare-tauri-release.mjs");
const updaterPublicKey = read("src-tauri/updater.pubkey").trim();

const appVersion = appPackage.version;
const serverVersion = serverPackage.version;
const piAgentVersion = serverPackage.dependencies?.["@earendil-works/pi-coding-agent"];
const errors = [];

expectVersionReset();

function expectVersionReset() {
  if (appVersion !== EXPECTED_DESKTOP_VERSION) {
    errors.push(`package.json desktop version must be reset to ${EXPECTED_DESKTOP_VERSION}`);
  }
}

if (updaterPublicKey !== PINNED_UPDATER_PUBLIC_KEY) {
  errors.push("src-tauri/updater.pubkey does not match the pinned release trust root");
}
if (!desktopUpdaterSource.includes(`pub const DESKTOP_UPDATER_ENDPOINT: &str =\n    "${DESKTOP_UPDATER_ENDPOINT}";`)) {
  errors.push("desktop updater runtime endpoint is not pinned to the PiHub GitHub release manifest");
}
if (!desktopUpdaterSource.includes(`pub const DESKTOP_UPDATER_PUBLIC_KEY: &str = "${PINNED_UPDATER_PUBLIC_KEY}";`)) {
  errors.push("desktop updater runtime public key does not match the pinned release trust root");
}
if (!releasePreparation.includes("DESKTOP_RELEASE_REPOSITORY")
    || !releasePreparation.includes("DESKTOP_UPDATER_ENDPOINT")
    || !releasePreparation.includes("endpoints: [endpoint]")) {
  errors.push("release-generated updater configuration is not pinned to yourChainGod/pihub");
}
for (const [label, source, expected] of [
  ["desktop updater signature endpoint", desktopUpdaterSecuritySource, DESKTOP_UPDATER_SIGNATURE_ENDPOINT],
  ["desktop updater signed channel", desktopUpdaterSecuritySource, DESKTOP_UPDATE_CHANNEL],
  ["desktop updater manifest kind", desktopUpdaterSecuritySource, DESKTOP_UPDATE_KIND],
]) {
  if (!source.includes(`"${expected}"`)) errors.push(`${label} is inconsistent with the desktop v1 identity`);
}
for (const dependency of ["tauri-plugin-process", "tauri-plugin-updater"]) {
  if (!new RegExp(`^${dependency}\\s*=`, "m").test(cargoManifest)) {
    errors.push(`src-tauri/Cargo.toml: missing ${dependency}`);
  }
}
for (const pluginInit of ["tauri_plugin_process::init()", "tauri_plugin_updater::Builder::new()"] ) {
  if (!rustSource.includes(pluginInit)) errors.push(`src-tauri/src/lib.rs: missing ${pluginInit}`);
}
for (const deniedPermission of [
  "process:deny-exit",
  "process:deny-restart",
  "updater:deny-check",
  "updater:deny-download",
  "updater:deny-install",
  "updater:deny-download-and-install",
]) {
  if (!desktopCapability.permissions?.includes(deniedPermission)) {
    errors.push(`src-tauri/capabilities/default.json: missing ${deniedPermission}`);
  }
}

function expect(label, actual, expected) {
  if (actual !== expected) {
    errors.push(`${label}: expected ${expected}, got ${actual ?? "<missing>"}`);
  }
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(appVersion)) {
  errors.push(`package.json: invalid semantic version ${appVersion}`);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(serverVersion)) {
  errors.push(`server/package.json: invalid semantic version ${serverVersion}`);
}

expect("package-lock.json root version", appLock.version, appVersion);
expect("package-lock.json package version", appLock.packages?.[""]?.version, appVersion);
expect("package.json desktop package name", appPackage.name, DESKTOP_PACKAGE_NAME);
expect("package-lock.json root package name", appLock.name, DESKTOP_PACKAGE_NAME);
expect("package-lock.json package name", appLock.packages?.[""]?.name, DESKTOP_PACKAGE_NAME);
expect("src-tauri/tauri.conf.json version", tauri.version, appVersion);
expect("src-tauri/tauri.conf.json productName", tauri.productName, DESKTOP_PRODUCT_NAME);
expect("src-tauri/tauri.conf.json identifier", tauri.identifier, DESKTOP_BUNDLE_IDENTIFIER);
expect("src-tauri/tauri.conf.json mainBinaryName", tauri.mainBinaryName, DESKTOP_BINARY_NAME);
expect("src-tauri/Cargo.toml version", cargoPackageVersion("src-tauri/Cargo.toml"), appVersion);
expect("src-tauri/Cargo.lock pihub-desktop version", cargoLockVersion("src-tauri/Cargo.lock", DESKTOP_PACKAGE_NAME), appVersion);
expect("src/App.tsx displayed version", appSource.match(/PiHub\s*<span>([^<]+)<\/span>/)?.[1], appVersion);
expect(
  "src-tauri/src/lib.rs active keyring service",
  rustSource.match(/const PIHUB_KEYRING_SERVICE:\s*&str\s*=\s*"([^"]+)"/)?.[1],
  DESKTOP_KEYRING_SERVICE,
);
expect(
  "src-tauri/src/lib.rs desktop bundle identifier",
  rustSource.match(/const PIHUB_DESKTOP_BUNDLE_IDENTIFIER:\s*&str\s*=\s*"([^"]+)"/)?.[1],
  DESKTOP_BUNDLE_IDENTIFIER,
);
expect(
  "src-tauri/src/lib.rs legacy bundle identifier",
  rustSource.match(/const LEGACY_DESKTOP_BUNDLE_IDENTIFIER:\s*&str\s*=\s*"([^"]+)"/)?.[1],
  LEGACY_DESKTOP_BUNDLE_IDENTIFIER,
);
expect(
  "src-tauri/src/lib.rs legacy keyring identity is documented but not active",
  rustSource.match(/const LEGACY_DESKTOP_KEYRING_SERVICE:\s*&str\s*=\s*"([^"]+)"/)?.[1],
  LEGACY_DESKTOP_KEYRING_SERVICE,
);

expect("server/package-lock.json root version", serverLock.version, serverVersion);
expect("server/package-lock.json package version", serverLock.packages?.[""]?.version, serverVersion);
expect(
  "src-tauri/src/lib.rs PIHUB_SERVER_VERSION",
  rustSource.match(/const PIHUB_SERVER_VERSION:\s*&str\s*=\s*"([^"]+)"/)?.[1],
  serverVersion,
);
expect(
  "src-tauri/src/lib.rs PIHUB_PI_AGENT_VERSION",
  rustSource.match(/const PIHUB_PI_AGENT_VERSION:\s*&str\s*=\s*"([^"]+)"/)?.[1],
  piAgentVersion,
);

expect("package.json server:build script", appPackage.scripts?.["server:build"], "node scripts/build-portable-server.mjs");
expect("server/package.json build script", serverPackage.scripts?.build, "node ../scripts/build-portable-server.mjs");
expect("src-tauri/tauri.conf.json beforeBuildCommand", tauri.build?.beforeBuildCommand, "npm run build");
for (const obsoleteScript of ["server:pack", "server:smoke", "bundle:prepare"]) {
  if (Object.hasOwn(appPackage.scripts ?? {}, obsoleteScript)) {
    errors.push(`package.json must not expose obsolete embedded Server script ${obsoleteScript}`);
  }
}
for (const [source, destination] of Object.entries(tauri.bundle?.resources ?? {})) {
  if (/pihub-server.*\.(?:tgz|tar\.gz)$/i.test(`${source}\n${destination}`)) {
    errors.push("src-tauri/tauri.conf.json must not bundle a Server archive");
  }
}

const expectedTargets = new Map([
  ["src-tauri/tauri.macos.conf.json", ["dmg"]],
  ["src-tauri/tauri.windows.conf.json", ["nsis"]],
  ["src-tauri/tauri.linux.conf.json", ["appimage", "deb"]],
]);
for (const [configPath, targets] of expectedTargets) {
  expect(`${configPath} bundle targets`, JSON.stringify(readJson(configPath).bundle?.targets), JSON.stringify(targets));
}

const tagFlag = process.argv.indexOf("--tag");
const tag = tagFlag >= 0 ? process.argv[tagFlag + 1] : process.env.PIHUB_RELEASE_TAG;
if (tag && tag !== `v${appVersion}`) {
  errors.push(`release tag: expected v${appVersion}, got ${tag}`);
}
if (tag && process.env.GITHUB_ACTIONS === "true") {
  try {
    execFileSync("git", ["show-ref", "--verify", `refs/tags/${tag}`], { stdio: "ignore" });
  } catch {
    errors.push(`release tag: refs/tags/${tag} does not exist in the checked-out repository`);
  }
}

if (errors.length > 0) {
  console.error("Release configuration check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Release configuration is consistent: app ${appVersion}, server ${serverVersion}`);
