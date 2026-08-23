import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  verifyFinalizedDesktopRelease,
} from "./finalize-desktop-release.mjs";
import {
  TAURI_UPDATER_PUBLIC_KEY_PATH,
  verifyTauriUpdaterArtifact,
} from "./verify-tauri-updater-signature.mjs";
import {
  DESKTOP_PRODUCT_NAME,
  DESKTOP_RELEASE_REPOSITORY,
  DESKTOP_UPDATE_CHANNEL,
  DESKTOP_UPDATE_KIND,
  DESKTOP_UPDATE_MANIFEST_NAME,
  DESKTOP_UPDATE_SIGNATURE_NAME,
} from "./product-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const require = createRequire(import.meta.url);
const { createJiti } = require(require.resolve("jiti", { paths: [path.join(root, "server")] }));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const releaseProtocol = await jiti.import(path.join(root, "server", "lib", "release-manifest.ts"));
const serverRelease = await jiti.import(path.join(root, "server", "lib", "server-release.ts"));
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const DESKTOP_MANIFEST_NAME = DESKTOP_UPDATE_MANIFEST_NAME;
const DESKTOP_MANIFEST_SIGNATURE_NAME = DESKTOP_UPDATE_SIGNATURE_NAME;
const DESKTOP_TARGETS = [
  "darwin-aarch64",
  "darwin-aarch64-app",
  "darwin-universal",
  "darwin-universal-app",
  "darwin-x86_64",
  "darwin-x86_64-app",
  "linux-aarch64",
  "linux-aarch64-appimage",
  "linux-aarch64-deb",
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "windows-aarch64",
  "windows-aarch64-nsis",
  "windows-x86_64",
  "windows-x86_64-nsis",
];
const SERVER_TARGETS = new Set([
  "darwin/arm64",
  "darwin/x64",
  "linux/arm64",
  "linux/x64",
  "win32/x64",
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function exactKeys(value, keys, description) {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error(`${description} has an invalid schema`);
  }
}

function regularFile(file) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error(`Release candidate file is missing or unsafe: ${path.basename(file)}`);
  }
  return info;
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readJson(file) {
  regularFile(file);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Release candidate JSON is invalid: ${path.basename(file)}`);
  }
}

function parseChecksums(file, description) {
  regularFile(file);
  const text = fs.readFileSync(file, "utf8");
  if (!text.endsWith("\n") || text.includes("\r") || text.trim().length === 0) {
    throw new Error(`${description} is not canonical`);
  }
  const entries = new Map();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = line.match(/^([a-f0-9]{64})[ ]{2}([A-Za-z0-9][A-Za-z0-9._+-]*)$/);
    if (!match || match[2].includes("..") || entries.has(match[2])) {
      throw new Error(`${description} contains an invalid entry`);
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

function releaseAssetName(urlText, repository, tag) {
  const url = new URL(urlText);
  const prefix = `/${DESKTOP_RELEASE_REPOSITORY}/releases/download/${tag}/`;
  if (
    repository !== DESKTOP_RELEASE_REPOSITORY
    || url.protocol !== "https:"
    || url.hostname !== "github.com"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || !url.pathname.startsWith(prefix)
  ) {
    throw new Error("Release candidate URL is not pinned to the immutable tag");
  }
  const encoded = url.pathname.slice(prefix.length);
  const name = decodeURIComponent(encoded);
  if (!SAFE_NAME.test(name) || name.includes("..") || encodeURIComponent(name) !== encoded) {
    throw new Error("Release candidate URL contains an unsafe asset name");
  }
  return name;
}

export function verifyReleaseCandidate({
  directory,
  repository,
  tag,
  updaterPublicKeyPath = TAURI_UPDATER_PUBLIC_KEY_PATH,
  serverReleaseTrust = serverRelease.createServerReleaseTrust(),
}) {
  const releaseDirectory = path.resolve(directory);
  const version = packageJson.version;
  if (repository !== DESKTOP_RELEASE_REPOSITORY || tag !== `v${version}`) {
    throw new Error("Release candidate identity does not match PiHub");
  }
  const finalChecksums = verifyFinalizedDesktopRelease({ releaseDirectory, updaterPublicKeyPath });
  const expectedInventory = new Set([
    "RELEASE-SHA256SUMS",
    DESKTOP_MANIFEST_NAME,
    DESKTOP_MANIFEST_SIGNATURE_NAME,
  ]);

  const latest = readJson(path.join(releaseDirectory, DESKTOP_MANIFEST_NAME));
  exactKeys(latest, ["version", "notes", "pub_date", "platforms", "pihub"], DESKTOP_MANIFEST_NAME);
  exactKeys(
    latest.pihub,
    ["schemaVersion", "kind", "repository", "channel", "tag", "platforms"],
    `${DESKTOP_MANIFEST_NAME} pihub`,
  );
  if (
    latest.version !== version
    || latest.notes !== `${DESKTOP_PRODUCT_NAME} ${tag}`
    || new Date(latest.pub_date).toISOString() !== latest.pub_date
    || latest.pihub.schemaVersion !== 1
    || latest.pihub.kind !== DESKTOP_UPDATE_KIND
    || latest.pihub.repository !== repository
    || latest.pihub.channel !== DESKTOP_UPDATE_CHANNEL
    || latest.pihub.tag !== tag
  ) {
    throw new Error(`${DESKTOP_MANIFEST_NAME} does not match the release candidate identity`);
  }
  const platformKeys = Object.keys(latest.platforms).sort((left, right) => left.localeCompare(right, "en"));
  const integrityKeys = Object.keys(latest.pihub.platforms).sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(platformKeys) !== JSON.stringify(DESKTOP_TARGETS) || JSON.stringify(integrityKeys) !== JSON.stringify(DESKTOP_TARGETS)) {
    throw new Error(`${DESKTOP_MANIFEST_NAME} does not contain the exact desktop target set`);
  }
  const verifiedUpdaterAssets = new Set();
  for (const target of DESKTOP_TARGETS) {
    const platform = latest.platforms[target];
    const integrity = latest.pihub.platforms[target];
    exactKeys(platform, ["signature", "url"], `${DESKTOP_MANIFEST_NAME} ${target}`);
    exactKeys(integrity, ["sha256", "size", "target"], `${DESKTOP_MANIFEST_NAME} integrity ${target}`);
    const name = releaseAssetName(platform.url, repository, tag);
    const artifact = path.join(releaseDirectory, name);
    const info = regularFile(artifact);
    if (
      integrity.target !== target
      || !SHA256_PATTERN.test(integrity.sha256)
      || integrity.sha256 !== sha256(artifact)
      || integrity.size !== info.size
    ) {
      throw new Error(`Desktop updater integrity mismatch: ${target}`);
    }
    const signatureName = `${name}.sig`;
    const signaturePath = path.join(releaseDirectory, signatureName);
    const signatureText = fs.readFileSync(signaturePath, "utf8").replace(/\r?\n$/, "");
    if (signatureText !== platform.signature) throw new Error(`Desktop updater signature mismatch: ${target}`);
    if (!verifiedUpdaterAssets.has(name)) {
      verifyTauriUpdaterArtifact({
        artifactPath: artifact,
        signaturePath,
        publicKeyPath: updaterPublicKeyPath,
      });
      verifiedUpdaterAssets.add(name);
    }
    expectedInventory.add(name);
    expectedInventory.add(signatureName);
  }

  const manifestName = "release-manifest.json";
  const manifestPath = path.join(releaseDirectory, manifestName);
  const manifest = releaseProtocol.parseAndVerifyReleaseManifest(
    fs.readFileSync(manifestPath),
    serverReleaseTrust,
  );
  if (manifest.version !== version || manifest.assets.length !== SERVER_TARGETS.size) {
    throw new Error("Server release manifest has the wrong version or target count");
  }
  const serverChecksums = parseChecksums(path.join(releaseDirectory, "SHA256SUMS"), "Server SHA256SUMS");
  const expectedServerChecksums = new Map([[manifestName, sha256(manifestPath)]]);
  const seenServerTargets = new Set();
  for (const asset of manifest.assets) {
    const target = `${asset.platform}/${asset.arch}`;
    const name = `pihub-server-${version}-${asset.platform}-${asset.arch}.tar.gz`;
    if (!SERVER_TARGETS.has(target) || seenServerTargets.has(target) || releaseAssetName(asset.url, repository, tag) !== name) {
      throw new Error(`Unexpected Server release target: ${target}`);
    }
    const archive = path.join(releaseDirectory, name);
    const info = regularFile(archive);
    if (asset.sha256 !== sha256(archive) || asset.size !== info.size) {
      throw new Error(`Server release archive mismatch: ${target}`);
    }
    const sidecarName = `${name}.sha256`;
    regularFile(path.join(releaseDirectory, sidecarName));
    if (fs.readFileSync(path.join(releaseDirectory, sidecarName), "utf8") !== `${asset.sha256}  ${name}\n`) {
      throw new Error(`Server release sidecar mismatch: ${target}`);
    }
    const sbomName = `pihub-server-${version}-${asset.platform}-${asset.arch}.cdx.json`;
    const sbomPath = path.join(releaseDirectory, sbomName);
    regularFile(sbomPath);
    expectedServerChecksums.set(name, asset.sha256);
    expectedServerChecksums.set(sbomName, sha256(sbomPath));
    expectedInventory.add(name);
    expectedInventory.add(sidecarName);
    expectedInventory.add(sbomName);
    seenServerTargets.add(target);
  }
  if (
    serverChecksums.size !== expectedServerChecksums.size
    || [...expectedServerChecksums].some(([name, digest]) => serverChecksums.get(name) !== digest)
  ) {
    throw new Error("Server SHA256SUMS does not match the signed candidate");
  }
  expectedInventory.add(manifestName);
  expectedInventory.add("SHA256SUMS");
  const serverMetadata = readJson(path.join(releaseDirectory, "server-release.json"));
  exactKeys(serverMetadata, ["schemaVersion", "version", "tag", "manifest"], "server-release.json");
  if (serverMetadata.schemaVersion !== 1 || serverMetadata.version !== version || serverMetadata.tag !== tag || serverMetadata.manifest !== manifestName) {
    throw new Error("server-release.json does not match the release candidate");
  }
  expectedInventory.add("server-release.json");

  const desktopPrefix = `${DESKTOP_PRODUCT_NAME.replaceAll(" ", "-")}_${version}`;
  const nativeInstallers = [
    `${desktopPrefix}_universal.dmg`,
    `${desktopPrefix}_x64-setup.exe`,
    `${desktopPrefix}_arm64-setup.exe`,
    `${desktopPrefix}_x86_64.AppImage`,
    `${desktopPrefix}_aarch64.AppImage`,
  ];
  for (const name of nativeInstallers) {
    if (!finalChecksums.has(name)) throw new Error(`Native desktop installer is missing: ${name}`);
    expectedInventory.add(name);
  }

  if (
    expectedInventory.size !== finalChecksums.size + 1
    || [...finalChecksums.keys()].some((name) => !expectedInventory.has(name))
  ) {
    throw new Error("Release candidate contains an unexpected or unverified asset");
  }
  return { version, assets: finalChecksums.size + 1 };
}

function main() {
  const result = verifyReleaseCandidate({
    directory: argument("--directory"),
    repository: argument("--repository"),
    tag: argument("--tag"),
  });
  console.log(`Verified release candidate v${result.version} (${result.assets} assets)`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) main();
