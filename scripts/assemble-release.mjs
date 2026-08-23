import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
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
} from "./product-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const require = createRequire(import.meta.url);
const { createJiti } = require(require.resolve("jiti", { paths: [path.join(root, "server")] }));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const releaseProtocol = await jiti.import(path.join(root, "server", "lib", "release-manifest.ts"));
const serverRelease = await jiti.import(path.join(root, "server", "lib", "server-release.ts"));
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function sha256(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Invalid JSON release metadata: ${file}`);
  }
}

function requireRegularFile(file) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error(`Release input must be a non-empty regular file: ${file}`);
  }
  return info;
}

function safeName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) || name.includes("..")) {
    throw new Error(`Unsafe release asset filename: ${String(name)}`);
  }
  return name;
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

function readChecksums(file, description) {
  requireRegularFile(file);
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

export function assembleRelease(options) {
  const desktopDirectory = path.resolve(options.desktopDirectory);
  const serverDirectory = path.resolve(options.serverDirectory);
  const outputDirectory = path.resolve(options.outputDirectory);
  const repository = options.repository;
  const tag = options.tag;
  const pubDate = options.pubDate;
  const updaterPublicKeyPath = options.updaterPublicKeyPath ?? TAURI_UPDATER_PUBLIC_KEY_PATH;
  const version = packageJson.version;

  if (repository !== DESKTOP_RELEASE_REPOSITORY) throw new Error("Release repository identity mismatch");
  if (tag !== `v${version}`) throw new Error(`Release tag must be v${version}`);
  if (!Number.isFinite(Date.parse(pubDate)) || !/^\d{4}-\d{2}-\d{2}T/.test(pubDate)) {
    throw new Error("--pub-date must be an RFC 3339 timestamp");
  }
  for (const directory of [desktopDirectory, serverDirectory]) {
    if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Release input directory is missing: ${directory}`);
    }
  }
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  if (fs.readdirSync(outputDirectory).length !== 0) {
    throw new Error(`Release output directory must be empty: ${outputDirectory}`);
  }

  const copied = new Map();
  function copyAsset(source, expectedSha256) {
    requireRegularFile(source);
    const name = safeName(path.basename(source));
    const digest = sha256(source);
    if (expectedSha256 && digest !== expectedSha256) {
      throw new Error(`Release artifact hash mismatch: ${name}`);
    }
    if (copied.has(name)) throw new Error(`Duplicate release asset filename: ${name}`);
    const destination = path.join(outputDirectory, name);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    copied.set(name, { path: destination, sha256: digest });
    return name;
  }

  const desktopPrefix = `${DESKTOP_PRODUCT_NAME.replaceAll(" ", "-")}_${version}`;
  const targetDefinitions = new Map([
    ["darwin/universal", {
      required: [
        `${desktopPrefix}_universal.dmg`,
        `${desktopPrefix}_universal.app.tar.gz`,
        `${desktopPrefix}_universal.app.tar.gz.sig`,
      ],
      updaters: [{
        artifactName: `${desktopPrefix}_universal.app.tar.gz`,
        signatureName: `${desktopPrefix}_universal.app.tar.gz.sig`,
        keys: ["darwin-universal", "darwin-universal-app", "darwin-aarch64", "darwin-aarch64-app", "darwin-x86_64", "darwin-x86_64-app"],
      }],
    }],
    ["windows/x86_64", {
      required: [
        `${desktopPrefix}_x64-setup.exe`,
        `${desktopPrefix}_x64-setup.nsis.zip`,
        `${desktopPrefix}_x64-setup.nsis.zip.sig`,
      ],
      updaters: [{
        artifactName: `${desktopPrefix}_x64-setup.nsis.zip`,
        signatureName: `${desktopPrefix}_x64-setup.nsis.zip.sig`,
        keys: ["windows-x86_64", "windows-x86_64-nsis"],
      }],
    }],
    ["windows/aarch64", {
      required: [
        `${desktopPrefix}_arm64-setup.exe`,
        `${desktopPrefix}_arm64-setup.nsis.zip`,
        `${desktopPrefix}_arm64-setup.nsis.zip.sig`,
      ],
      updaters: [{
        artifactName: `${desktopPrefix}_arm64-setup.nsis.zip`,
        signatureName: `${desktopPrefix}_arm64-setup.nsis.zip.sig`,
        keys: ["windows-aarch64", "windows-aarch64-nsis"],
      }],
    }],
    ["linux/x86_64", {
      required: [
        `${desktopPrefix}_x86_64.AppImage`,
        `${desktopPrefix}_amd64.deb`,
        `${desktopPrefix}_amd64.deb.sig`,
        `${desktopPrefix}_x86_64.AppImage.tar.gz`,
        `${desktopPrefix}_x86_64.AppImage.tar.gz.sig`,
      ],
      updaters: [
        {
          artifactName: `${desktopPrefix}_x86_64.AppImage.tar.gz`,
          signatureName: `${desktopPrefix}_x86_64.AppImage.tar.gz.sig`,
          keys: ["linux-x86_64", "linux-x86_64-appimage"],
        },
        {
          artifactName: `${desktopPrefix}_amd64.deb`,
          signatureName: `${desktopPrefix}_amd64.deb.sig`,
          keys: ["linux-x86_64-deb"],
        },
      ],
    }],
    ["linux/aarch64", {
      required: [
        `${desktopPrefix}_aarch64.AppImage`,
        `${desktopPrefix}_arm64.deb`,
        `${desktopPrefix}_arm64.deb.sig`,
        `${desktopPrefix}_aarch64.AppImage.tar.gz`,
        `${desktopPrefix}_aarch64.AppImage.tar.gz.sig`,
      ],
      updaters: [
        {
          artifactName: `${desktopPrefix}_aarch64.AppImage.tar.gz`,
          signatureName: `${desktopPrefix}_aarch64.AppImage.tar.gz.sig`,
          keys: ["linux-aarch64", "linux-aarch64-appimage"],
        },
        {
          artifactName: `${desktopPrefix}_arm64.deb`,
          signatureName: `${desktopPrefix}_arm64.deb.sig`,
          keys: ["linux-aarch64-deb"],
        },
      ],
    }],
  ]);

  const metadataFiles = fs.readdirSync(desktopDirectory)
    .filter((name) => /^desktop-[A-Za-z0-9_-]+\.asset\.json$/.test(name))
    .sort();
  if (metadataFiles.length !== targetDefinitions.size) {
    throw new Error(`Expected ${targetDefinitions.size} desktop target metadata files, found ${metadataFiles.length}`);
  }

  const platforms = {};
  const platformIntegrity = {};
  const seenTargets = new Set();
  for (const metadataName of metadataFiles) {
    const metadata = readJson(path.join(desktopDirectory, metadataName));
    const target = `${metadata.platform}/${metadata.arch}`;
    const definition = targetDefinitions.get(target);
    if (!definition || seenTargets.has(target)) throw new Error(`Unexpected or duplicate desktop target: ${target}`);
    seenTargets.add(target);
    exactKeys(metadata, ["schemaVersion", "version", "platform", "arch", "files"], metadataName);
    if (metadata.schemaVersion !== 1 || metadata.version !== version || !Array.isArray(metadata.files)) {
      throw new Error(`Invalid desktop release metadata: ${metadataName}`);
    }
    const names = [];
    for (const file of metadata.files) {
      exactKeys(file, ["name", "size", "sha256"], `${metadataName} artifact`);
      if (!file || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error(`Invalid desktop artifact entry in ${metadataName}`);
      }
      const name = safeName(file.name);
      const source = path.join(desktopDirectory, name);
      const info = requireRegularFile(source);
      if (info.size !== file.size) throw new Error(`Desktop artifact size mismatch: ${name}`);
      copyAsset(source, file.sha256);
      names.push(name);
    }
    for (const requiredName of definition.required) {
      if (names.filter((name) => name === requiredName).length !== 1) throw new Error(`${target} is missing ${requiredName}`);
    }
    if (names.length !== definition.required.length || names.some((name) => !definition.required.includes(name))) {
      throw new Error(`${target} contains an unexpected desktop artifact`);
    }
    for (const updater of definition.updaters) {
      if (!names.includes(updater.artifactName) || !names.includes(updater.signatureName) || updater.signatureName !== `${updater.artifactName}.sig`) {
        throw new Error(`Updater artifact/signature pair is invalid for ${target}`);
      }
      const updaterName = updater.artifactName;
      const signatureName = updater.signatureName;
      const signature = verifyTauriUpdaterArtifact({
        artifactPath: path.join(outputDirectory, updaterName),
        signaturePath: path.join(outputDirectory, signatureName),
        publicKeyPath: updaterPublicKeyPath,
      });
      const url = `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(updaterName)}`;
      const updaterAsset = copied.get(updaterName);
      if (!updaterAsset) throw new Error(`Updater artifact was not copied: ${updaterName}`);
      const integrity = {
        sha256: updaterAsset.sha256,
        size: fs.statSync(updaterAsset.path).size,
      };
      for (const key of updater.keys) {
        if (platforms[key]) throw new Error(`Duplicate updater platform key: ${key}`);
        platforms[key] = { signature, url };
        platformIntegrity[key] = { ...integrity, target: key };
      }
    }
  }

  for (const target of targetDefinitions.keys()) {
    if (!seenTargets.has(target)) throw new Error(`Desktop target is missing: ${target}`);
  }

  const expectedServerTargets = new Set([
    "darwin/arm64", "darwin/x64", "linux/arm64", "linux/x64", "win32/x64",
  ]);
  const serverMetadataFiles = fs.readdirSync(serverDirectory)
    .filter((name) => name.endsWith(".asset.json"))
    .sort();
  if (serverMetadataFiles.length !== expectedServerTargets.size) {
    throw new Error(`Expected ${expectedServerTargets.size} Server target metadata files, found ${serverMetadataFiles.length}`);
  }
  const serverAssets = new Map();
  const expectedServerFiles = new Set(["release-manifest.json", "SHA256SUMS", "server-release.json"]);
  for (const metadataName of serverMetadataFiles) {
    const metadata = readJson(path.join(serverDirectory, metadataName));
    exactKeys(
      metadata,
      ["schemaVersion", "version", "platform", "arch", "filename", "sha256", "size", "sbom", "sbomSha256"],
      metadataName,
    );
    const target = `${metadata.platform}/${metadata.arch}`;
    if (!expectedServerTargets.delete(target) || metadata.schemaVersion !== 1 || metadata.version !== version) {
      throw new Error(`Unexpected or duplicate Server target metadata: ${metadataName}`);
    }
    if (!SHA256_PATTERN.test(metadata.sha256) || !SHA256_PATTERN.test(metadata.sbomSha256)) {
      throw new Error(`Invalid Server hashes in ${metadataName}`);
    }
    const archiveName = safeName(metadata.filename);
    const sbomName = safeName(metadata.sbom);
    if (
      archiveName !== `pihub-server-${version}-${metadata.platform}-${metadata.arch}.tar.gz`
      || sbomName !== `pihub-server-${version}-${metadata.platform}-${metadata.arch}.cdx.json`
      || !Number.isSafeInteger(metadata.size)
      || metadata.size <= 0
    ) {
      throw new Error(`Invalid Server asset identity in ${metadataName}`);
    }
    const archivePath = path.join(serverDirectory, archiveName);
    const archiveInfo = requireRegularFile(archivePath);
    const sbomPath = path.join(serverDirectory, sbomName);
    requireRegularFile(sbomPath);
    if (archiveInfo.size !== metadata.size || sha256(archivePath) !== metadata.sha256 || sha256(sbomPath) !== metadata.sbomSha256) {
      throw new Error(`Server release files do not match ${metadataName}`);
    }
    const sidecarName = `${archiveName}.sha256`;
    const sidecarPath = path.join(serverDirectory, sidecarName);
    requireRegularFile(sidecarPath);
    if (fs.readFileSync(sidecarPath, "utf8") !== `${metadata.sha256}  ${archiveName}\n`) {
      throw new Error(`Server checksum sidecar does not match ${metadataName}`);
    }
    for (const name of [metadataName, archiveName, sidecarName, sbomName]) expectedServerFiles.add(name);
    serverAssets.set(target, { metadata, archiveName, archivePath, sidecarPath, sbomName, sbomPath });
  }
  if (expectedServerTargets.size !== 0) throw new Error("One or more Server release targets are missing");

  const serverNames = fs.readdirSync(serverDirectory).sort((left, right) => left.localeCompare(right, "en"));
  if (serverNames.length !== expectedServerFiles.size || serverNames.some((name) => !expectedServerFiles.has(name))) {
    throw new Error("Server release directory contains an unexpected file");
  }
  const manifestName = "release-manifest.json";
  const manifestPath = path.join(serverDirectory, manifestName);
  const trust = options.serverReleaseTrust ?? serverRelease.createServerReleaseTrust();
  const verifiedManifest = releaseProtocol.parseAndVerifyReleaseManifest(fs.readFileSync(manifestPath), trust);
  if (verifiedManifest.version !== version || verifiedManifest.assets.length !== serverAssets.size) {
    throw new Error("Server release manifest does not match the desktop release version");
  }
  const manifestTargets = new Set();
  for (const asset of verifiedManifest.assets) {
    const target = `${asset.platform}/${asset.arch}`;
    const expected = serverAssets.get(target);
    if (
      !expected
      || manifestTargets.has(target)
      || asset.url !== `https://github.com/${repository}/releases/download/${tag}/${expected.archiveName}`
      || asset.sha256 !== expected.metadata.sha256
      || asset.size !== expected.metadata.size
    ) {
      throw new Error(`Server release manifest asset mismatch: ${target}`);
    }
    manifestTargets.add(target);
  }

  const expectedChecksums = new Map([[manifestName, sha256(manifestPath)]]);
  for (const expected of serverAssets.values()) {
    expectedChecksums.set(expected.archiveName, expected.metadata.sha256);
    expectedChecksums.set(expected.sbomName, expected.metadata.sbomSha256);
  }
  const serverChecksumPath = path.join(serverDirectory, "SHA256SUMS");
  const serverChecksums = readChecksums(serverChecksumPath, "Server SHA256SUMS");
  if (
    serverChecksums.size !== expectedChecksums.size
    || [...expectedChecksums].some(([name, digest]) => serverChecksums.get(name) !== digest)
  ) {
    throw new Error("Server SHA256SUMS does not match the signed release set");
  }

  const serverReleaseMetadata = readJson(path.join(serverDirectory, "server-release.json"));
  exactKeys(serverReleaseMetadata, ["schemaVersion", "version", "tag", "manifest"], "server-release.json");
  if (
    serverReleaseMetadata.schemaVersion !== 1
    || serverReleaseMetadata.version !== version
    || serverReleaseMetadata.tag !== tag
    || serverReleaseMetadata.manifest !== manifestName
  ) {
    throw new Error("server-release.json does not match the signed release");
  }
  for (const expected of serverAssets.values()) {
    copyAsset(expected.archivePath, expected.metadata.sha256);
    copyAsset(expected.sidecarPath);
    copyAsset(expected.sbomPath, expected.metadata.sbomSha256);
  }
  copyAsset(manifestPath, expectedChecksums.get(manifestName));
  copyAsset(serverChecksumPath);
  copyAsset(path.join(serverDirectory, "server-release.json"));

  const desktopManifest = {
    version,
    notes: `${DESKTOP_PRODUCT_NAME} ${tag}`,
    pub_date: new Date(pubDate).toISOString(),
    platforms: Object.fromEntries(Object.entries(platforms).sort(([left], [right]) => left.localeCompare(right, "en"))),
    pihub: {
      schemaVersion: 1,
      kind: DESKTOP_UPDATE_KIND,
      repository,
      channel: DESKTOP_UPDATE_CHANNEL,
      tag,
      platforms: Object.fromEntries(Object.entries(platformIntegrity).sort(([left], [right]) => left.localeCompare(right, "en"))),
    },
  };
  const desktopManifestPath = path.join(outputDirectory, DESKTOP_UPDATE_MANIFEST_NAME);
  fs.writeFileSync(desktopManifestPath, `${JSON.stringify(desktopManifest, null, 2)}\n`, { mode: 0o644 });
  copied.set(DESKTOP_UPDATE_MANIFEST_NAME, { path: desktopManifestPath, sha256: sha256(desktopManifestPath) });

  const checksumLines = [...copied.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([name, value]) => `${value.sha256}  ${name}`);
  fs.writeFileSync(path.join(outputDirectory, "RELEASE-SHA256SUMS"), `${checksumLines.join("\n")}\n`, { mode: 0o644 });

  console.log(`Assembled ${copied.size + 1} verified release assets for ${tag}`);
  return desktopManifest;
}

function main() {
  assembleRelease({
    desktopDirectory: argument("--desktop"),
    serverDirectory: argument("--server"),
    outputDirectory: argument("--output"),
    repository: argument("--repository"),
    tag: argument("--tag"),
    pubDate: argument("--pub-date"),
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) main();
