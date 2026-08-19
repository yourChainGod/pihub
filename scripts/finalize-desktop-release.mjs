import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  TAURI_UPDATER_PUBLIC_KEY_PATH,
  verifyTauriUpdaterArtifact,
} from "./verify-tauri-updater-signature.mjs";
import {
  DESKTOP_UPDATE_MANIFEST_NAME,
  DESKTOP_UPDATE_SIGNATURE_NAME,
} from "./product-identity.mjs";

const CHECKSUM_NAME = "RELEASE-SHA256SUMS";
const MANIFEST_NAME = DESKTOP_UPDATE_MANIFEST_NAME;
const MANIFEST_SIGNATURE_NAME = DESKTOP_UPDATE_SIGNATURE_NAME;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requireRegularFile(file) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error(`Release asset must be a non-empty regular file: ${file}`);
  }
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseChecksums(file) {
  requireRegularFile(file);
  const entries = new Map();
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})[ ]{2}([A-Za-z0-9][A-Za-z0-9._+-]*)$/);
    if (!match || match[2].includes("..") || entries.has(match[2]) || match[2] === CHECKSUM_NAME) {
      throw new Error(`Invalid release checksum entry: ${line}`);
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function finalizeDesktopRelease({
  releaseDirectory,
  updaterPublicKeyPath = TAURI_UPDATER_PUBLIC_KEY_PATH,
}) {
  const directory = path.resolve(releaseDirectory);
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Release directory is missing: ${directory}`);
  }
  const checksumPath = path.join(directory, CHECKSUM_NAME);
  const previous = parseChecksums(checksumPath);
  const actualNames = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"));
  for (const name of actualNames) {
    if (!SAFE_NAME.test(name) || name.includes("..")) throw new Error(`Unsafe release asset filename: ${name}`);
    requireRegularFile(path.join(directory, name));
  }
  const expectedNames = new Set([...previous.keys(), MANIFEST_SIGNATURE_NAME, CHECKSUM_NAME]);
  if (actualNames.length !== expectedNames.size || actualNames.some((name) => !expectedNames.has(name))) {
    throw new Error("Release directory changed after assembly");
  }
  for (const [name, digest] of previous) {
    if (sha256(path.join(directory, name)) !== digest) {
      throw new Error(`Release artifact changed after assembly: ${name}`);
    }
  }
  if (!previous.has(MANIFEST_NAME)) throw new Error(`Assembled release is missing ${MANIFEST_NAME}`);
  verifyTauriUpdaterArtifact({
    artifactPath: path.join(directory, MANIFEST_NAME),
    signaturePath: path.join(directory, MANIFEST_SIGNATURE_NAME),
    publicKeyPath: updaterPublicKeyPath,
  });

  const finalized = new Map(previous);
  finalized.set(MANIFEST_SIGNATURE_NAME, sha256(path.join(directory, MANIFEST_SIGNATURE_NAME)));
  const output = [...finalized.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([name, digest]) => `${digest}  ${name}`)
    .join("\n");
  const temporaryPath = path.join(directory, `.${CHECKSUM_NAME}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${output}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporaryPath, checksumPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return finalized;
}

export function verifyFinalizedDesktopRelease({
  releaseDirectory,
  updaterPublicKeyPath = TAURI_UPDATER_PUBLIC_KEY_PATH,
}) {
  const directory = path.resolve(releaseDirectory);
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Release directory is missing: ${directory}`);
  }
  const checksums = parseChecksums(path.join(directory, CHECKSUM_NAME));
  if (!checksums.has(MANIFEST_NAME) || !checksums.has(MANIFEST_SIGNATURE_NAME)) {
    throw new Error("Finalized release is missing the signed desktop manifest");
  }
  const actualNames = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right, "en"));
  const expectedNames = new Set([...checksums.keys(), CHECKSUM_NAME]);
  if (actualNames.length !== expectedNames.size || actualNames.some((name) => !expectedNames.has(name))) {
    throw new Error("Finalized release asset inventory does not match its checksums");
  }
  for (const name of actualNames) {
    if (!SAFE_NAME.test(name) || name.includes("..")) throw new Error(`Unsafe release asset filename: ${name}`);
    requireRegularFile(path.join(directory, name));
  }
  for (const [name, digest] of checksums) {
    if (sha256(path.join(directory, name)) !== digest) {
      throw new Error(`Finalized release checksum mismatch: ${name}`);
    }
  }
  verifyTauriUpdaterArtifact({
    artifactPath: path.join(directory, MANIFEST_NAME),
    signaturePath: path.join(directory, MANIFEST_SIGNATURE_NAME),
    publicKeyPath: updaterPublicKeyPath,
  });
  return checksums;
}

function main() {
  finalizeDesktopRelease({ releaseDirectory: argument("--release") });
  console.log("Verified the signed desktop manifest and finalized release checksums");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) main();
