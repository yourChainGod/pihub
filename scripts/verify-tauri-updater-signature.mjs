import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { TextDecoder } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const serverRequire = createRequire(path.join(root, "server", "package.json"));
const { PublicKey, Signature } = serverRequire("@threema/wasm-minisign-verify");

export const TAURI_UPDATER_PUBLIC_KEY_PATH = path.join(root, "src-tauri", "updater.pubkey");

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_ENCODED_MINISIGN_BYTES = 16 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function requireSmallRegularFile(file, label) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error(`${label} must be a non-empty regular file`);
  }
  if (info.size > MAX_ENCODED_MINISIGN_BYTES) {
    throw new Error(`${label} is too large`);
  }
}

function decodeTauriMinisignText(file, label) {
  requireSmallRegularFile(file, label);
  const bytes = fs.readFileSync(file);
  let encoded;
  try {
    encoded = decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }

  if (encoded.endsWith("\r\n")) encoded = encoded.slice(0, -2);
  else if (encoded.endsWith("\n")) encoded = encoded.slice(0, -1);

  if (!encoded || encoded.includes("\0") || !BASE64_PATTERN.test(encoded)) {
    throw new Error(`${label} is not canonical Base64`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new Error(`${label} is not canonical Base64`);
  }

  let minisignText;
  try {
    minisignText = decoder.decode(decoded);
  } catch {
    throw new Error(`${label} does not contain valid UTF-8 Minisign text`);
  }
  if (!minisignText || minisignText.includes("\0")) {
    throw new Error(`${label} does not contain valid Minisign text`);
  }
  return { encoded, minisignText };
}

function safeFree(value) {
  try {
    value?.free();
  } catch {
    // A failed WASM verification can retain a Rust borrow; the process will reclaim it.
  }
}

export function verifyTauriUpdaterArtifact({
  artifactPath,
  signaturePath,
  publicKeyPath = TAURI_UPDATER_PUBLIC_KEY_PATH,
}) {
  const artifactInfo = fs.lstatSync(artifactPath, { throwIfNoEntry: false });
  if (!artifactInfo?.isFile() || artifactInfo.isSymbolicLink() || artifactInfo.nlink !== 1 || artifactInfo.size <= 0) {
    throw new Error("Tauri updater artifact must be a non-empty regular file");
  }

  const publicKeyText = decodeTauriMinisignText(publicKeyPath, "Tauri updater public key").minisignText;
  const signatureData = decodeTauriMinisignText(signaturePath, "Tauri updater signature");
  let publicKey;
  let signature;
  try {
    try {
      publicKey = PublicKey.decode(publicKeyText);
    } catch {
      throw new Error("Tauri updater public key is not a valid Minisign public key");
    }
    try {
      signature = Signature.decode(signatureData.minisignText);
    } catch {
      throw new Error("Tauri updater signature is not a valid Minisign signature");
    }
    try {
      if (publicKey.verify(fs.readFileSync(artifactPath), signature) !== true) {
        throw new Error("verification returned false");
      }
    } catch {
      throw new Error(`Tauri updater signature verification failed for ${path.basename(artifactPath)}`);
    }
    return signatureData.encoded;
  } finally {
    safeFree(signature);
    safeFree(publicKey);
  }
}
