import fs from "node:fs";
import path from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require(require.resolve("jiti", { paths: [path.join(root, "server")] }));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const releaseProtocol = await jiti.import(path.join(root, "server", "lib", "release-manifest.ts"));
const serverRelease = await jiti.import(path.join(root, "server", "lib", "server-release.ts"));

const REQUIRED_IDENTITIES = [
  "darwin/arm64",
  "darwin/x64",
  "linux/arm64",
  "linux/x64",
  "win32/arm64",
  "win32/x64",
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
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

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function loadPrivateKey() {
  const supplied = requiredEnvironment("PIHUB_SERVER_RELEASE_PRIVATE_KEY");
  let keyText = supplied;
  if (!supplied.includes("BEGIN")) {
    keyText = Buffer.from(supplied, "base64").toString("utf8");
  }
  if (!keyText.includes("BEGIN PRIVATE KEY")) {
    throw new Error("PIHUB_SERVER_RELEASE_PRIVATE_KEY must contain a PKCS#8 Ed25519 private key or its base64 encoding");
  }
  const passphrase = process.env.PIHUB_SERVER_RELEASE_PRIVATE_KEY_PASSWORD;
  const key = createPrivateKey(passphrase ? { key: keyText, passphrase } : keyText);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("PIHUB_SERVER_RELEASE_PRIVATE_KEY must be an Ed25519 private key");
  }
  return key;
}

function rawPublicKey(privateKey) {
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  if (!Buffer.isBuffer(der) || der.length !== prefix.length + 32 || !der.subarray(0, prefix.length).equals(prefix)) {
    throw new Error("Could not derive the Ed25519 release public key");
  }
  return der.subarray(prefix.length).toString("base64url");
}

const directory = path.resolve(process.argv[2] ?? path.join(root, "release-artifacts"));
const repository = requiredEnvironment("GITHUB_REPOSITORY");
const expectedRepository = `${serverRelease.SERVER_RELEASE_OWNER}/${serverRelease.SERVER_RELEASE_REPO}`;
if (repository !== expectedRepository) {
  throw new Error(`Server release repository must be ${expectedRepository}`);
}

const privateKey = loadPrivateKey();
if (rawPublicKey(privateKey) !== serverRelease.SERVER_RELEASE_PUBLIC_KEY) {
  throw new Error("Server release private key does not match the pinned Ed25519 public key");
}

const metadataFiles = fs.readdirSync(directory)
  .filter((name) => name.endsWith(".asset.json"))
  .sort();
if (metadataFiles.length !== REQUIRED_IDENTITIES.length) {
  throw new Error(`Expected ${REQUIRED_IDENTITIES.length} Server release asset descriptors`);
}

const identities = new Set();
let version;
const assets = [];
const checksums = new Map();
for (const metadataName of metadataFiles) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, metadataName), "utf8"));
  exactKeys(
    metadata,
    ["schemaVersion", "version", "platform", "arch", "filename", "sha256", "size", "sbom", "sbomSha256", "pi", "extensions"],
    metadataName,
  );
  // The pinned component manifest (pi + extensions) rides along in the asset
  // descriptor; validate its shape so a swapped archive cannot smuggle an
  // unlisted component set.
  if (
    !metadata.pi
    || metadata.pi.name !== "@earendil-works/pi-coding-agent"
    || !releaseProtocol.isReleaseVersion(metadata.pi.version)
    || !Array.isArray(metadata.extensions)
    || metadata.extensions.length === 0
    || metadata.extensions.some((entry) => !entry
      || typeof entry.name !== "string"
      || !releaseProtocol.isReleaseVersion(entry.version))
  ) {
    throw new Error(`${metadataName} contains invalid component pins`);
  }
  if (
    metadata.schemaVersion !== 1
    || !releaseProtocol.isReleaseVersion(metadata.version)
    || !["darwin", "linux", "win32"].includes(metadata.platform)
    || !["arm64", "x64"].includes(metadata.arch)
    || typeof metadata.filename !== "string"
    || metadata.filename !== `pihub-server-${metadata.version}-${metadata.platform}-${metadata.arch}.tar.gz`
    || typeof metadata.sbom !== "string"
    || metadata.sbom !== `pihub-server-${metadata.version}-${metadata.platform}-${metadata.arch}.cdx.json`
    || !SHA256_PATTERN.test(metadata.sha256)
    || !SHA256_PATTERN.test(metadata.sbomSha256)
    || !Number.isSafeInteger(metadata.size)
    || metadata.size <= 0
  ) {
    throw new Error(`${metadataName} contains invalid release metadata`);
  }
  version ??= metadata.version;
  if (metadata.version !== version) throw new Error("Server release assets have inconsistent versions");

  const identity = `${metadata.platform}/${metadata.arch}`;
  if (identities.has(identity)) throw new Error(`Duplicate Server release identity: ${identity}`);
  identities.add(identity);

  const archive = path.join(directory, metadata.filename);
  const sbom = path.join(directory, metadata.sbom);
  const archiveInfo = fs.lstatSync(archive);
  const sbomInfo = fs.lstatSync(sbom);
  if (
    !archiveInfo.isFile()
    || archiveInfo.isSymbolicLink()
    || archiveInfo.size !== metadata.size
    || await sha256File(archive) !== metadata.sha256
    || !sbomInfo.isFile()
    || sbomInfo.isSymbolicLink()
    || await sha256File(sbom) !== metadata.sbomSha256
  ) {
    throw new Error(`${metadataName} does not match its release files`);
  }

  checksums.set(metadata.filename, metadata.sha256);
  checksums.set(metadata.sbom, metadata.sbomSha256);
  const unsignedAsset = {
    version,
    platform: metadata.platform,
    arch: metadata.arch,
    url: `https://github.com/${repository}/releases/download/v${version}/${metadata.filename}`,
    sha256: metadata.sha256,
    size: metadata.size,
  };
  assets.push({
    ...unsignedAsset,
    signature: sign(null, releaseProtocol.releaseAssetSigningPayload(unsignedAsset), privateKey).toString("base64url"),
  });
}

for (const identity of REQUIRED_IDENTITIES) {
  if (!identities.has(identity)) throw new Error(`Missing Server release asset: ${identity}`);
}
assets.sort((left, right) => `${left.platform}/${left.arch}`.localeCompare(`${right.platform}/${right.arch}`, "en"));

const unsignedManifest = {
  schemaVersion: releaseProtocol.RELEASE_MANIFEST_SCHEMA_VERSION,
  owner: serverRelease.SERVER_RELEASE_OWNER,
  repo: serverRelease.SERVER_RELEASE_REPO,
  channel: serverRelease.SERVER_RELEASE_CHANNEL,
  version,
  assets,
};
const manifest = {
  ...unsignedManifest,
  signature: sign(null, releaseProtocol.releaseManifestSigningPayload(unsignedManifest), privateKey).toString("base64url"),
};
const manifestText = releaseProtocol.canonicalizeReleaseJson(manifest);
releaseProtocol.parseAndVerifyReleaseManifest(manifestText, serverRelease.createServerReleaseTrust());

const manifestName = "release-manifest.json";
const manifestPath = path.join(directory, manifestName);
fs.writeFileSync(manifestPath, manifestText, { mode: 0o644 });
checksums.set(manifestName, await sha256File(manifestPath));

const checksumLines = [...checksums.entries()]
  .sort(([left], [right]) => left.localeCompare(right, "en"))
  .map(([name, digest]) => `${digest}  ${name}`);
fs.writeFileSync(path.join(directory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, { mode: 0o644 });
fs.writeFileSync(
  path.join(directory, "server-release.json"),
  `${JSON.stringify({ schemaVersion: 1, version, tag: `v${version}`, manifest: manifestName }, null, 2)}\n`,
  { mode: 0o644 },
);

console.log(`Signed Server ${version} manifest for ${assets.length} platform assets`);
