import fs from "node:fs";
import path from "node:path";

import {
  DESKTOP_RELEASE_REPOSITORY,
  DESKTOP_UPDATER_ENDPOINT,
} from "./product-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const PINNED_UPDATER_PUBLIC_KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU4OTk1MzI4ODJFMjMyRApSV1F0SXk2SU1wV0pEampHUEF0RnYxSTltOTM2Z0x1L0RUY0ZDaFlrcDBpWFNHUFkveU5NaDRuOQo=";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const repository = required("GITHUB_REPOSITORY");
if (repository !== DESKTOP_RELEASE_REPOSITORY) {
  throw new Error(`GITHUB_REPOSITORY must be exactly ${DESKTOP_RELEASE_REPOSITORY}`);
}
const pubkeyPath = path.join(root, "src-tauri", "updater.pubkey");
if (!fs.existsSync(pubkeyPath)) {
  throw new Error("src-tauri/updater.pubkey is required; generate the private key outside the repository and commit only its public key");
}
const pubkey = fs.readFileSync(pubkeyPath, "utf8").trim();
if (pubkey !== PINNED_UPDATER_PUBLIC_KEY) {
  throw new Error("src-tauri/updater.pubkey does not match the pinned release trust root");
}

const endpoint = process.env.PIHUB_UPDATER_ENDPOINT?.trim() || DESKTOP_UPDATER_ENDPOINT;
const parsedEndpoint = new URL(endpoint);
if (parsedEndpoint.href !== DESKTOP_UPDATER_ENDPOINT || parsedEndpoint.username || parsedEndpoint.password) {
  throw new Error(`PIHUB_UPDATER_ENDPOINT must be exactly ${DESKTOP_UPDATER_ENDPOINT}`);
}

const output = path.resolve(process.argv[2] ?? "src-tauri/tauri.release.generated.conf.json");
const bundle = {
  createUpdaterArtifacts: true,
};

if (process.env.RUNNER_OS === "Windows") {
  const thumbprint = required("WINDOWS_CERTIFICATE_THUMBPRINT").replaceAll(" ", "").toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(thumbprint)) {
    throw new Error("WINDOWS_CERTIFICATE_THUMBPRINT must be a 40-character SHA-1 thumbprint");
  }
  bundle.windows = {
    certificateThumbprint: thumbprint,
    digestAlgorithm: "sha256",
    timestampUrl: "http://timestamp.digicert.com",
  };
}

const config = {
  $schema: "https://schema.tauri.app/config/2",
  build: {
    beforeBuildCommand: "",
  },
  bundle,
  plugins: {
    updater: {
      endpoints: [endpoint],
      pubkey,
    },
  },
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`Prepared signed updater config for ${endpoint} at ${output}`);
