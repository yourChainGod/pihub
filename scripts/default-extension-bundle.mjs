import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { verifyServerLock } from "./verify-server-lock.mjs";
import { npmSpawnInvocation, prepareSecureNpmEnvironment } from "./secure-npm-environment.mjs";
import { pruneExtensionPlatformModules } from "./server-resource-privacy.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

export const DEFAULT_EXTENSION_SOURCE_DIRECTORY = path.join(repositoryRoot, "extensions");
export const DEFAULT_EXTENSION_NOTICE_FILE = "THIRD_PARTY_NOTICES.extensions.txt";
export const DEFAULT_EXTENSION_INVENTORY_SCHEMA_VERSION = 1;
export const DEFAULT_EXTENSION_LOCK_SHA256 = "073459426c243c34c5787e10b9f7bc050f7b2b714bfc9ffd404af0e345729bb4";
export const DEFAULT_EXTENSION_PACKAGES = Object.freeze([
  Object.freeze({ name: "@cortexkit/pi-magic-context", version: "0.38.0" }),
  Object.freeze({ name: "pi-todo-rail", version: "0.2.3" }),
  Object.freeze({ name: "@ff-labs/pi-fff", version: "0.10.5" }),
  Object.freeze({ name: "pi-simplify", version: "0.2.3" }),
  Object.freeze({ name: "@gotgenes/pi-permission-system", version: "26.3.0" }),
  Object.freeze({ name: "@eko24ive/pi-ask", version: "1.2.0" }),
  Object.freeze({ name: "@gotgenes/pi-subagents", version: "19.3.2" }),
]);
export const DEFAULT_EXTENSION_RESOURCE_LAYOUT = Object.freeze({
  "@cortexkit/pi-magic-context": Object.freeze({ extensions: Object.freeze(["dist/index.js"]) }),
  "pi-todo-rail": Object.freeze({ extensions: Object.freeze(["index.ts"]) }),
  "@ff-labs/pi-fff": Object.freeze({ extensions: Object.freeze(["src/index.ts"]) }),
  "pi-simplify": Object.freeze({ extensions: Object.freeze(["dist/index.js"]) }),
  "@gotgenes/pi-permission-system": Object.freeze({ extensions: Object.freeze(["src/index.ts"]) }),
  "@eko24ive/pi-ask": Object.freeze({
    extensions: Object.freeze(["src/index.ts"]),
    skills: Object.freeze(["skills"]),
  }),
  "@gotgenes/pi-subagents": Object.freeze({ extensions: Object.freeze(["src/index.ts"]) }),
});

const EXPECTED_NODE_ENGINE = ">=22.19.0 <23";
const HOST_PI_VERSION = "0.84.2";
const HOST_PI_PACKAGES = Object.freeze([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);
const LOCKED_PI_PACKAGES = new Set([
  ...HOST_PI_PACKAGES,
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-client",
  "@earendil-works/pi-protocol",
  "@earendil-works/pi-telemetry",
]);
export {
  HOST_PI_PACKAGES as DEFAULT_EXTENSION_HOST_PI_PACKAGES,
  HOST_PI_VERSION as DEFAULT_EXTENSION_HOST_PI_VERSION,
};
const EXPECTED_PI_PEERS = Object.freeze({
  "@cortexkit/pi-magic-context": Object.freeze({
    "@earendil-works/pi-coding-agent": "^0.80.2",
    "@earendil-works/pi-tui": "^0.80.2",
  }),
  "pi-todo-rail": Object.freeze({
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  }),
  "@ff-labs/pi-fff": Object.freeze({
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  }),
  "pi-simplify": Object.freeze({
    "@earendil-works/pi-ai": ">=0.74.0",
    "@earendil-works/pi-coding-agent": ">=0.74.0",
    "@earendil-works/pi-tui": ">=0.74.0",
  }),
  "@gotgenes/pi-permission-system": Object.freeze({
    "@earendil-works/pi-coding-agent": ">=0.79.0",
    "@earendil-works/pi-tui": ">=0.79.0",
  }),
  "@eko24ive/pi-ask": Object.freeze({
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  }),
  "@gotgenes/pi-subagents": Object.freeze({
    "@earendil-works/pi-ai": ">=0.75.0",
    "@earendil-works/pi-coding-agent": ">=0.80.5",
    "@earendil-works/pi-tui": ">=0.75.0",
  }),
});
// Magic Context 0.38.0 declares the 0.80.x Pi peer range, but its published
// extension API is backward-compatible with the audited 0.84.2 host used by
// PiHub. Keep this narrow, version-pinned exception explicit and reviewable.
const AUDITED_PEER_COMPATIBILITY_OVERRIDES = Object.freeze({
  "@cortexkit/pi-magic-context": Object.freeze({
    "@earendil-works/pi-coding-agent": new Set(["0.84.2"]),
    "@earendil-works/pi-tui": new Set(["0.84.2"]),
  }),
});
const ALLOWED_PHYSICAL_INSTALL_SCRIPTS = new Map([
  ["tree-sitter-bash", "0.25.1"],
  // The package ships all supported native binaries. Its postinstall is never
  // executed because staging uses --ignore-scripts; allowing the exact pin
  // keeps the bundle self-contained without permitting a network lifecycle.
  ["onnxruntime-node", "1.24.3"],
  // sharp >= 0.35 no longer ships an install script; it selects its
  // already-published platform binary purely through optional dependencies.
]);
const AUDITED_PRIVACY_FINDINGS = new Map([
  [
    // Upstream Rust build-machine paths (`C:\Users\runneradmin\.cargo\...`)
    // embedded in the win32-arm64 fff binary; build paths only, no user data.
    "node_modules/@ff-labs/fff-bin-win32-arm64/fff_c.dll",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "8a2db277c10c120bc048719dd23210130f7824c1a7fb2381bdc4c8aad949f6e8",
    }),
  ],
  [
    "node_modules/@gotgenes/pi-subagents/CHANGELOG.md",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "a25b7a31b8843b6d86ca02fe8f13bd49044dd2f2715aad0eed9828fa2ac769aa",
    }),
  ],
  [
    // The match is pi-magic-context's own redaction regex
    // (`/\/Users\/[^/]+\//g -> /Users/<USER>/`), not a real user path.
    "node_modules/@cortexkit/pi-magic-context/dist/index.js",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "b133fd5dcfef321dcbdd0808b9152ed65348041868ed34dfe0c60ce9504ad839",
    }),
  ],
  // The remaining entries are upstream build-machine paths embedded in
  // sourcemaps and native binaries (onnxruntime / quickjs); no user data.
  [
    "node_modules/@jitl/quickjs-singlefile-cjs-release-asyncify/dist/index.js.map",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "3bb92e2e724e9bb62b1d3dea29a944dee25c4adca3ade6304fe9f46e56c2707d",
    }),
  ],
  [
    "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.24.3.dylib",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "76831409ce6eded92b4cb343cf422c458a60c1ea1d5f3cfa69692ab7fcc67f0f",
    }),
  ],
  [
    "node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "ffa33e57e56799a89ff4986ae579ca0de0be81867c5e3219ac9fdb0f7d1bbd89",
    }),
  ],
  [
    "node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs.map",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "9e28dafe0b543ac196289b2ea17adfea882c8da9785210ec03befd23f93eb148",
    }),
  ],
  [
    "node_modules/onnxruntime-web/dist/ort.bundle.min.mjs.map",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "021e478c265610e90df70140f9ef7f9aa7ebc31e9fb4de1e116106200966c1cd",
    }),
  ],
  [
    "node_modules/onnxruntime-web/dist/ort.jspi.bundle.min.mjs.map",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "c0edd24b06adb1d2f7ec54dcaff3c3d4befaecd5110e5b8a2ba7032de6eb6ed6",
    }),
  ],
  [
    "node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs.map",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "fdedcaffabc56b2add8d23e72faf5adc72cda9667eda6b621e162cacbe53f9d0",
    }),
  ],
  [
    "node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs.map",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "5250a487fcbc2f2cba84cd4d5b0c8e7bebf34ce0969863389e3ef1274d53f341",
    }),
  ],
  [
    "node_modules/zod/src/v4/mini/tests/string.test.ts",
    Object.freeze({
      rules: new Set(["jwt"]),
      sha256: "efb9ef22f2179e700a2033edd4e1e03a6fe4f6b95fa4bc0bd29223065e1ec0a0",
    }),
  ],
  // win32 staged tree (first Windows release build): native binaries embed
  // upstream CI build paths; AWS SDK type docs and @types/node contain
  // documented example patterns (placeholder keys/secrets, not real data).
  [
    "node_modules/@aws-sdk/nested-clients/dist-types/submodules/sso-oidc/commands/CreateTokenCommand.d.ts",
    Object.freeze({
      rules: new Set(["generic-secret"]),
      sha256: "8fe8f076a7acd3ce108c090daff013c07dfe23fe89113408caa789f7c7fcedb5",
    }),
  ],
  [
    "node_modules/@aws-sdk/nested-clients/dist-types/submodules/sts/commands/AssumeRoleCommand.d.ts",
    Object.freeze({
      rules: new Set(["aws-access-key"]),
      sha256: "85d68f3dbf85b1bb5c6070799c79112252c457189eff62b83c85649e36c6406a",
    }),
  ],
  [
    "node_modules/@aws-sdk/nested-clients/dist-types/submodules/sts/commands/AssumeRoleWithWebIdentityCommand.d.ts",
    Object.freeze({
      rules: new Set(["aws-access-key"]),
      sha256: "a5dc443adbff96a09d32f4829f694bebee4194cf30949aaf63a1cc1d977334f2",
    }),
  ],
  [
    "node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "7e9e91204ee1f002052070a90332d24a166e0cbc433095cebe4136651e8d91c8",
    }),
  ],
  [
    "node_modules/@earendil-works/pi-coding-agent/examples/extensions/overlay-qa-tests.ts",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "4b1778e9e247c9eb24fe48e13fff0272f6f78b8102b4ed085d03598c3b98773f",
    }),
  ],
  [
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@aws-sdk/nested-clients/dist-types/submodules/sso-oidc/commands/CreateTokenCommand.d.ts",
    Object.freeze({
      rules: new Set(["generic-secret"]),
      sha256: "3ad424e44a64663b5e74e2a9184cabffbae4b267dfc10b64b45408a3558d3e4c",
    }),
  ],
  [
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@aws-sdk/nested-clients/dist-types/submodules/sts/commands/AssumeRoleCommand.d.ts",
    Object.freeze({
      rules: new Set(["aws-access-key"]),
      sha256: "984324c6cd5584aa5cbde353d2b7394d96cfa5f658b0f62bab10ef7154163dd0",
    }),
  ],
  [
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@aws-sdk/nested-clients/dist-types/submodules/sts/commands/AssumeRoleWithWebIdentityCommand.d.ts",
    Object.freeze({
      rules: new Set(["aws-access-key"]),
      sha256: "ce324928c5245ce3f8522f2fd3e00fd6e8ee8c477188515d9c1571fdb5b0a1b8",
    }),
  ],
  [
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/clipboard/src/clipboard_rs/platform/x11.rs",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "5e44069a1a9e5b04f2ea82805965efb1a48dc900f8fbddb47665f915f1575cb8",
    }),
  ],
  [
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "2b75a71676a9054323a223c7853570fa44bf73a701d6c3160219ec0971052fd5",
    }),
  ],
  [
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c",
    }),
  ],
  [
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@types/node/fs.d.ts",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "c906fb15bd2aabc9ed1e3f44eb6a8661199d6c320b3aa196b826121552cb3695",
    }),
  ],
  [
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@types/node/process.d.ts",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "bceb58df66ab8fb00170df20cd813978c5ab84be1d285710c4eb005d8e9d8efb",
    }),
  ],
  [
    "node_modules/@ff-labs/fff-bin-win32-x64/fff_c.dll",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "109f968f5cea7fad106ae42018b152bc9317efa74e14809c44a3bb39de18962f",
    }),
  ],
  [
    "node_modules/@types/node/fs.d.ts",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "6d81823c5704398a68b98e3c7a459334fc0403ad5e6953f4317b5b4919e289e4",
    }),
  ],
  [
    "node_modules/@types/node/process.d.ts",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "1c16d778cc142455f35a3f1a411227b9901c671756338af12a9175958500ce66",
    }),
  ],
  [
    "node_modules/@yuuang/ffi-rs-win32-ia32-msvc/ffi-rs.win32-ia32-msvc.node",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "86aba53b5636ab4e84b23201d429deac03bca74432d19fc2bd920f908cf9ded5",
    }),
  ],
  [
    "node_modules/@yuuang/ffi-rs-win32-x64-msvc/ffi-rs.win32-x64-msvc.node",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "2cb551f9b5745e7a36c67806562e5b6d0d74513a3c91eafa7a654d69b461aaaf",
    }),
  ],
]);
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_LICENSE_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PI_PACKAGE_PREFIX = "@earendil-works/pi-";
const CONTROL_CHARACTERS = /\p{Cc}/u;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function comparePortable(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(comparePortable)
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalExtensionJson(value) {
  return JSON.stringify(canonicalize(value));
}

function readRegularFile(filename, description, maxBytes = MAX_JSON_BYTES) {
  const info = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0 || info.size > maxBytes) {
    throw new Error(`${description} must be a bounded regular file`);
  }
  return fs.readFileSync(filename, "utf8");
}

function readFormattedJson(filename, description) {
  const source = readRegularFile(filename, description);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${description} is not valid JSON`);
  }
  if (`${JSON.stringify(value, null, 2)}\n` !== source) {
    throw new Error(`${description} must use deterministic two-space JSON without duplicate keys`);
  }
  return value;
}

function expectedDependencies() {
  return Object.fromEntries(DEFAULT_EXTENSION_PACKAGES.map(({ name, version }) => [name, version]));
}

function exactDependencies(value) {
  const expected = expectedDependencies();
  return isRecord(value)
    && Object.keys(value).length === DEFAULT_EXTENSION_PACKAGES.length
    && DEFAULT_EXTENSION_PACKAGES.every(({ name, version }) => value[name] === version)
    && Object.keys(value).every((name) => expected[name] === value[name]);
}

function exactStringMap(value, expected) {
  return isRecord(value)
    && Object.keys(value).length === Object.keys(expected).length
    && Object.entries(expected).every(([name, version]) => value[name] === version);
}

function parseVersion(value, description) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`${description} must be an exact stable SemVer version`);
  return match.slice(1).map(Number);
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function satisfiesSupportedRange(version, range) {
  const candidate = parseVersion(version, "Host Pi version");
  if (range === "*") return true;
  if (range.startsWith(">=")) {
    return compareVersion(candidate, parseVersion(range.slice(2), "Pi peer range")) >= 0;
  }
  if (range.startsWith("^")) {
    const lower = parseVersion(range.slice(1), "Pi peer range");
    const upper = lower[0] > 0
      ? [lower[0] + 1, 0, 0]
      : lower[1] > 0
        ? [0, lower[1] + 1, 0]
        : [0, 0, lower[2] + 1];
    return compareVersion(candidate, lower) >= 0 && compareVersion(candidate, upper) < 0;
  }
  return compareVersion(candidate, parseVersion(range, "Pi peer range")) === 0;
}

function exactOverrides(value) {
  return value === undefined
    || (isRecord(value)
      && Object.values(value).every((version) => typeof version === "string"
        && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)));
}

function validateManifest(manifest, expectedVersion) {
  if (!isRecord(manifest)
      || !hasExactKeys(manifest, [
        "name",
        "version",
        "private",
        "engines",
        "dependencies",
        ...(manifest.overrides !== undefined ? ["overrides"] : []),
      ])
      || manifest.name !== "@pihub/default-extensions"
      || manifest.version !== expectedVersion
      || manifest.private !== true
      || manifest.scripts !== undefined
      || !hasExactKeys(manifest.engines, ["node"])
      || manifest.engines.node !== EXPECTED_NODE_ENGINE
      || !exactDependencies(manifest.dependencies)
      || !exactOverrides(manifest.overrides)) {
    throw new Error("Default extension package manifest contract is invalid");
  }
}

function packagePath(root, packageName) {
  return path.join(root, "node_modules", ...packageName.split("/"));
}

function packageLockKeyFor(relative) {
  const segments = relative.split("/");
  if (segments.at(-1) !== "package.json") return null;
  let marker = -1;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === "node_modules") marker = index;
  }
  if (marker === -1) return null;
  const identity = segments.slice(marker + 1, -1);
  if (identity.length === 1 && !identity[0].startsWith("@")) return segments.slice(0, -1).join("/");
  if (identity.length === 2 && identity[0].startsWith("@")) return segments.slice(0, -1).join("/");
  return null;
}

function packageNameFromLockKey(lockKey) {
  const segments = lockKey.split("/");
  const marker = segments.lastIndexOf("node_modules");
  const identity = segments.slice(marker + 1);
  return identity[0].startsWith("@") ? `${identity[0]}/${identity[1]}` : identity[0];
}

function verifyCommittedLock(manifest, lock) {
  const lockForRegistryVerification = structuredClone(lock);
  let omittedPeerIntegrityEntries = 0;
  for (const [lockKey, entry] of Object.entries(lockForRegistryVerification.packages ?? {})) {
    if (lockKey === "" || !isRecord(entry) || entry.integrity !== undefined) continue;
    const packageName = packageNameFromLockKey(lockKey);
    if (entry.peer !== true || !LOCKED_PI_PACKAGES.has(packageName) || entry.version !== HOST_PI_VERSION) {
      throw new Error(`${lockKey} is missing its SHA-512 integrity`);
    }
    // npm v10 omits integrity only for redundant peer-solver records. These
    // records are never materialized by `npm ci --omit=peer`; the clone keeps
    // the shared registry validator strict without weakening the committed lock.
    entry.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
    omittedPeerIntegrityEntries += 1;
  }
  const summary = {
    ...verifyServerLock({ packageJson: manifest, packageLock: lockForRegistryVerification }),
    omittedPeerIntegrityEntries,
  };
  if (lock.requires !== true || summary.linkEntries !== 0 || summary.linkTargetEntries !== 0 || summary.bundledEntries !== 0) {
    throw new Error("Default extension lock must contain only official registry packages");
  }
  for (const { name, version } of DEFAULT_EXTENSION_PACKAGES) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!isRecord(entry) || entry.version !== version || entry.peer === true) {
      throw new Error(`Default extension lock does not pin ${name}@${version}`);
    }
  }
  for (const [lockKey, entry] of Object.entries(lock.packages)) {
    const packageName = lockKey === "" ? null : packageNameFromLockKey(lockKey);
    if (packageName?.startsWith(PI_PACKAGE_PREFIX) !== true) continue;
    if (!isRecord(entry) || entry.peer !== true || entry.version !== HOST_PI_VERSION) {
      throw new Error(`Pi package lock entry must be an omitted ${HOST_PI_VERSION} peer: ${lockKey}`);
    }
    if (!LOCKED_PI_PACKAGES.has(packageName)) {
      throw new Error(`Default extension lock contains an unreviewed Pi peer: ${packageName}`);
    }
  }
  return summary;
}

function validatePortableRelative(relative) {
  if (typeof relative !== "string"
      || relative.length === 0
      || relative.length > 1024
      || relative.includes("\\")
      || relative.startsWith("/")
      || CONTROL_CHARACTERS.test(relative)
      || relative.normalize("NFC") !== relative) {
    throw new Error(`Default extension bundle contains an unsafe path: ${relative}`);
  }
  const segments = relative.split("/");
  if (segments.length > 32 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Default extension bundle contains an unsafe path: ${relative}`);
  }
  return relative;
}

function collectRegularFiles(root) {
  const files = [];
  const portablePaths = new Set();
  let totalBytes = 0;
  const visit = (directory, relative) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => comparePortable(left.name, right.name));
    for (const entry of entries) {
      const childRelative = validatePortableRelative(relative ? `${relative}/${entry.name}` : entry.name);
      const portableKey = childRelative.toLowerCase();
      if (portablePaths.has(portableKey)) {
        throw new Error(`Default extension bundle contains a portable path collision: ${childRelative}`);
      }
      portablePaths.add(portableKey);
      const child = path.join(directory, entry.name);
      const info = fs.lstatSync(child);
      if (info.isSymbolicLink()) throw new Error(`Default extension bundle contains a symbolic link: ${childRelative}`);
      if (info.isDirectory()) {
        visit(child, childRelative);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error(`Default extension bundle contains a hard link or special entry: ${childRelative}`);
      }
      if (info.size > MAX_FILE_BYTES) throw new Error(`Default extension bundle file is too large: ${childRelative}`);
      totalBytes += info.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Default extension bundle exceeds the expanded-size limit");
      }
      files.push({ path: childRelative, size: info.size, source: child });
      if (files.length > MAX_FILES) throw new Error("Default extension bundle contains too many files");
    }
  };
  visit(root, "");
  files.sort((left, right) => comparePortable(left.path, right.path));
  return { files, totalBytes };
}

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(filename);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

export function isAuditedDefaultExtensionPrivacyFinding(extensionRoot, finding) {
  if (!isRecord(finding) || typeof finding.path !== "string" || typeof finding.rule !== "string") return false;
  const relative = finding.path
    .replace(/^archive!/, "")
    .replace(/^extensions\//, "");
  const audited = AUDITED_PRIVACY_FINDINGS.get(relative);
  if (!audited?.rules.has(finding.rule)) return false;
  const filename = path.join(extensionRoot, ...relative.split("/"));
  const info = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) return false;
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex") === audited.sha256;
}

async function inventoryRecords(root) {
  const tree = collectRegularFiles(root);
  const files = tree.files.filter(({ path: relative }) => relative !== "inventory.json");
  const records = [];
  let totalBytes = 0;
  for (const file of files) {
    records.push({ path: file.path, size: file.size, sha256: await sha256File(file.source) });
    totalBytes += file.size;
  }
  return { files: records, totalBytes };
}

export async function createDefaultExtensionInventory(root) {
  const records = await inventoryRecords(root);
  return {
    schemaVersion: DEFAULT_EXTENSION_INVENTORY_SCHEMA_VERSION,
    packages: DEFAULT_EXTENSION_PACKAGES.map(({ name, version }) => ({ name, version })),
    files: records.files,
    totalBytes: records.totalBytes,
  };
}

function validateInventorySchema(inventory) {
  if (!hasExactKeys(inventory, ["schemaVersion", "packages", "files", "totalBytes"])
      || inventory.schemaVersion !== DEFAULT_EXTENSION_INVENTORY_SCHEMA_VERSION
      || !Array.isArray(inventory.packages)
      || inventory.packages.length !== DEFAULT_EXTENSION_PACKAGES.length
      || !Array.isArray(inventory.files)
      || inventory.files.length === 0
      || inventory.files.length > MAX_FILES
      || !Number.isSafeInteger(inventory.totalBytes)
      || inventory.totalBytes < 0
      || inventory.totalBytes > MAX_TOTAL_BYTES) {
    throw new Error("Default extension inventory schema is invalid");
  }
  for (let index = 0; index < DEFAULT_EXTENSION_PACKAGES.length; index += 1) {
    const actual = inventory.packages[index];
    const expected = DEFAULT_EXTENSION_PACKAGES[index];
    if (!hasExactKeys(actual, ["name", "version"])
        || actual.name !== expected.name || actual.version !== expected.version) {
      throw new Error("Default extension inventory package order is invalid");
    }
  }
  let previous = null;
  let totalBytes = 0;
  for (const file of inventory.files) {
    if (!hasExactKeys(file, ["path", "size", "sha256"])
        || validatePortableRelative(file.path) !== file.path
        || file.path === "inventory.json"
        || (file.path !== "package.json" && file.path !== "package-lock.json" && !file.path.startsWith("node_modules/"))
        || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES
        || !SHA256_PATTERN.test(file.sha256)
        || (previous !== null && comparePortable(previous, file.path) >= 0)) {
      throw new Error("Default extension inventory file contract is invalid");
    }
    previous = file.path;
    totalBytes += file.size;
  }
  if (totalBytes !== inventory.totalBytes) throw new Error("Default extension inventory total is invalid");
}

async function verifyInventory(root, inventory) {
  validateInventorySchema(inventory);
  const actual = await inventoryRecords(root);
  if (actual.totalBytes !== inventory.totalBytes || actual.files.length !== inventory.files.length) {
    throw new Error("Default extension bundle does not match its inventory");
  }
  for (let index = 0; index < actual.files.length; index += 1) {
    const left = actual.files[index];
    const right = inventory.files[index];
    if (left.path !== right.path || left.size !== right.size || left.sha256 !== right.sha256) {
      throw new Error("Default extension bundle does not match its inventory");
    }
  }
}

function readPackageMetadata(filename, description) {
  const source = readRegularFile(filename, description, 256 * 1024);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${description} is invalid JSON`);
  }
}

function verifyHostPi(serverRoot) {
  const manifest = readPackageMetadata(path.join(serverRoot, "package.json"), "Server package manifest");
  if (!isRecord(manifest.dependencies)) throw new Error("Server package dependencies are invalid");
  for (const packageName of HOST_PI_PACKAGES) {
    if (manifest.dependencies[packageName] !== HOST_PI_VERSION) {
      throw new Error(`Server host must pin ${packageName}@${HOST_PI_VERSION}`);
    }
    const metadata = readPackageMetadata(
      path.join(packagePath(serverRoot, packageName), "package.json"),
      `Server host package ${packageName}`,
    );
    if (metadata.name !== packageName || metadata.version !== HOST_PI_VERSION) {
      throw new Error(`Server host package identity is invalid: ${packageName}`);
    }
  }
  return Object.fromEntries(HOST_PI_PACKAGES.map((name) => [name, HOST_PI_VERSION]));
}

function verifyDirectPackage(root, lock, extension, hostVersions) {
  const packageRoot = packagePath(root, extension.name);
  const metadata = readPackageMetadata(path.join(packageRoot, "package.json"), `Extension ${extension.name}`);
  if (metadata.name !== extension.name || metadata.version !== extension.version) {
    throw new Error(`Default extension package identity is invalid: ${extension.name}`);
  }
  const expectedPeers = EXPECTED_PI_PEERS[extension.name];
  const actualPeers = Object.fromEntries(
    Object.entries(isRecord(metadata.peerDependencies) ? metadata.peerDependencies : {})
      .filter(([name]) => name.startsWith(PI_PACKAGE_PREFIX)),
  );
  if (!exactStringMap(actualPeers, expectedPeers)) {
    throw new Error(`Default extension Pi peer contract changed: ${extension.name}`);
  }
  if (extension.name === "pi-todo-rail" && metadata.peerDependencies?.typebox !== "*") {
    throw new Error("pi-todo-rail must pin its typebox peer contract");
  }
  for (const [name, range] of Object.entries(expectedPeers)) {
    const override = AUDITED_PEER_COMPATIBILITY_OVERRIDES[extension.name]?.[name];
    if (!satisfiesSupportedRange(hostVersions[name], range) && !override?.has(hostVersions[name])) {
      throw new Error(`${extension.name} does not support host ${name}@${hostVersions[name]}`);
    }
  }
  const layout = DEFAULT_EXTENSION_RESOURCE_LAYOUT[extension.name];
  for (const resources of Object.values(layout)) {
    for (const relative of resources) {
      const resource = path.join(packageRoot, ...relative.split("/"));
      const info = fs.lstatSync(resource, { throwIfNoEntry: false });
      if (!info || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        throw new Error(`Default extension resource is missing or unsafe: ${extension.name}/${relative}`);
      }
    }
  }
  const lockEntry = lock.packages[`node_modules/${extension.name}`];
  if (!isRecord(lockEntry) || lockEntry.version !== extension.version) {
    throw new Error(`Default extension is not pinned by the lock: ${extension.name}`);
  }
}

function verifyPhysicalPackages(root, lock, files) {
  const packageRoots = [];
  for (const file of files) {
    const lockKey = packageLockKeyFor(file.path);
    if (lockKey === null) continue;
    const metadata = readPackageMetadata(file.source, `Physical package metadata ${lockKey}`);
    const lockEntry = lock.packages[lockKey];
    const expectedName = packageNameFromLockKey(lockKey);
    if (!isRecord(lockEntry)
        || lockEntry.link === true
        || metadata.name !== expectedName
        || metadata.version !== lockEntry.version) {
      throw new Error(`Physical extension package is not bound to its lock record: ${lockKey}`);
    }
    if (metadata.name.startsWith(PI_PACKAGE_PREFIX)) {
      throw new Error(`Default extension bundle contains a nested Pi package: ${metadata.name}`);
    }
    if (lockEntry.hasInstallScript === true) {
      if (ALLOWED_PHYSICAL_INSTALL_SCRIPTS.get(metadata.name) !== metadata.version) {
        throw new Error(`Default extension bundle contains an unreviewed install script: ${metadata.name}`);
      }
    }
    packageRoots.push({ lockKey, metadata, root: path.dirname(file.source) });
  }
  const installScripts = packageRoots
    .filter(({ lockKey }) => lock.packages[lockKey].hasInstallScript === true)
    .map(({ metadata }) => `${metadata.name}@${metadata.version}`)
    .sort(comparePortable);
  const expectedInstallScripts = [...ALLOWED_PHYSICAL_INSTALL_SCRIPTS]
    .map(([name, version]) => `${name}@${version}`)
    .sort(comparePortable);
  if (JSON.stringify(installScripts) !== JSON.stringify(expectedInstallScripts)) {
    throw new Error("Default extension install-script allowlist is incomplete or stale");
  }
  const bashWasm = path.join(packagePath(root, "tree-sitter-bash"), "tree-sitter-bash.wasm");
  if (!fs.statSync(bashWasm, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("tree-sitter-bash must ship its reviewed WASM runtime when scripts are disabled");
  }
  return packageRoots;
}

export function verifyDefaultExtensionSource({
  sourceDirectory = DEFAULT_EXTENSION_SOURCE_DIRECTORY,
  expectedVersion,
} = {}) {
  const manifest = readFormattedJson(path.join(sourceDirectory, "package.json"), "Default extension package manifest");
  const lock = readFormattedJson(path.join(sourceDirectory, "package-lock.json"), "Default extension package lock");
  const version = expectedVersion ?? manifest.version;
  validateManifest(manifest, version);
  const lockSummary = verifyCommittedLock(manifest, lock);
  const lockSha256 = createHash("sha256")
    .update(fs.readFileSync(path.join(sourceDirectory, "package-lock.json")))
    .digest("hex");
  if (lockSha256 !== DEFAULT_EXTENSION_LOCK_SHA256) {
    throw new Error("Default extension lock graph changed without updating its audited digest");
  }
  return { lock, lockSha256, lockSummary, manifest, version };
}

export async function verifyDefaultExtensionBundle(root, {
  expectedVersion,
  serverRoot,
  requireInventory = true,
} = {}) {
  if (!serverRoot) throw new Error("Server root is required to verify default extension peers");
  const rootInfo = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Default extension bundle root is invalid");
  }
  const { lock, lockSummary, manifest, version } = verifyDefaultExtensionSource({
    sourceDirectory: root,
    expectedVersion,
  });
  const hostVersions = verifyHostPi(serverRoot);
  const tree = collectRegularFiles(root);
  if (tree.files.some(({ path: relative }) => relative.includes(`node_modules/${PI_PACKAGE_PREFIX}`))) {
    throw new Error("Default extension bundle contains a nested Pi package path");
  }
  const physicalPackages = verifyPhysicalPackages(root, lock, tree.files);
  for (const extension of DEFAULT_EXTENSION_PACKAGES) {
    verifyDirectPackage(root, lock, extension, hostVersions);
  }
  let inventory;
  if (requireInventory) {
    const inventorySource = readRegularFile(path.join(root, "inventory.json"), "Default extension inventory");
    try {
      inventory = JSON.parse(inventorySource);
    } catch {
      throw new Error("Default extension inventory is invalid JSON");
    }
    if (canonicalExtensionJson(inventory) !== inventorySource) {
      throw new Error("Default extension inventory is not canonical");
    }
    await verifyInventory(root, inventory);
  }
  return {
    inventory,
    lock,
    lockSummary,
    manifest,
    packages: physicalPackages,
    version,
  };
}

function repositoryUrl(metadata) {
  const value = typeof metadata.repository === "string"
    ? metadata.repository
    : isRecord(metadata.repository)
      ? metadata.repository.url
      : undefined;
  return typeof value === "string" ? value.replace(/^git\+/, "") : "not declared";
}

function licenseFiles(packageRoot) {
  return fs.readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name))
    .map((entry) => {
      const filename = path.join(packageRoot, entry.name);
      const info = fs.lstatSync(filename);
      if (info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_LICENSE_BYTES) {
        throw new Error(`Extension license file is unsafe: ${entry.name}`);
      }
      return { name: entry.name, text: fs.readFileSync(filename, "utf8").trimEnd() };
    })
    .sort((left, right) => comparePortable(left.name, right.name));
}

export function createDefaultExtensionNotices(verification) {
  const packages = [...verification.packages]
    .sort((left, right) => comparePortable(
      `${left.metadata.name}@${left.metadata.version}:${left.lockKey}`,
      `${right.metadata.name}@${right.metadata.version}:${right.lockKey}`,
    ));
  const lines = [
    "PiHub Default Extensions - Third-Party Notices",
    "",
    "This file is generated from the physical packages in the signed platform artifact.",
    "npm lifecycle scripts were not executed while producing this bundle.",
    "",
  ];
  for (const entry of packages) {
    const metadata = entry.metadata;
    const declaredLicense = typeof metadata.license === "string" ? metadata.license : "not declared";
    lines.push(
      `==============================================================================`,
      `${metadata.name}@${metadata.version}`,
      `Installed path: extensions/${entry.lockKey}`,
      `Declared license: ${declaredLicense}`,
      `Repository: ${repositoryUrl(metadata)}`,
    );
    const notices = licenseFiles(entry.root);
    if (notices.length === 0) {
      lines.push("License text: not included in the published npm tarball; see the declared upstream repository.", "");
      continue;
    }
    for (const notice of notices) {
      lines.push("", `--- ${notice.name} ---`, notice.text, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function runNpm(run, args, cwd) {
  const prepared = prepareSecureNpmEnvironment("pihub-extension-npm-", { legacyPeerDeps: true });
  try {
    if (run) return run(args, cwd, 128 * 1024 * 1024, { env: prepared.environment });
    const invocation = npmSpawnInvocation(args);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd,
      encoding: "utf8",
      env: prepared.environment,
      maxBuffer: 128 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || "npm failed").slice(0, 16_384));
    }
    return result.stdout;
  } finally {
    prepared.cleanup();
  }
}

export function installDefaultExtensionDependencies(run, cwd) {
  return runNpm(run, [
    "ci",
    "--ignore-scripts",
    "--omit=peer",
    "--engine-strict=true",
    "--no-bin-links",
    "--legacy-peer-deps=true",
    "--force=false",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org/",
  ], cwd);
}

export function assertExtensionBuildToolchain(run) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || minor < 19) {
    throw new Error(`Default extensions require Node 22.19.x or newer Node 22; got ${process.version}`);
  }
  const npmVersion = runNpm(run, ["--version"], repositoryRoot).trim();
  if (!/^10\.\d+\.\d+$/.test(npmVersion)) {
    throw new Error(`Default extensions require npm 10.x; got ${npmVersion}`);
  }
  return { node: process.versions.node, npm: npmVersion };
}

export async function stageDefaultExtensionBundle({
  destinationDirectory,
  expectedVersion,
  run,
  serverRoot,
  sourceDirectory = DEFAULT_EXTENSION_SOURCE_DIRECTORY,
  platform,
  arch,
} = {}) {
  if (!destinationDirectory || !serverRoot) throw new Error("Extension staging requires destination and Server roots");
  const toolchain = assertExtensionBuildToolchain(run);
  verifyDefaultExtensionSource({ sourceDirectory, expectedVersion });
  fs.mkdirSync(destinationDirectory, { mode: 0o700 });
  for (const name of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(sourceDirectory, name), path.join(destinationDirectory, name), fs.constants.COPYFILE_EXCL);
  }
  installDefaultExtensionDependencies(run, destinationDirectory);
  const hiddenLock = path.join(destinationDirectory, "node_modules", ".package-lock.json");
  if (fs.existsSync(hiddenLock)) fs.rmSync(hiddenLock);
  // A release archive targets exactly one platform/arch: drop every other
  // native payload before the inventory is computed over the staged tree.
  const prunedPlatformModules = platform && arch
    ? pruneExtensionPlatformModules(destinationDirectory, { platform, arch })
    : [];
  const preInventory = await verifyDefaultExtensionBundle(destinationDirectory, {
    expectedVersion,
    requireInventory: false,
    serverRoot,
  });
  const inventory = await createDefaultExtensionInventory(destinationDirectory);
  fs.writeFileSync(
    path.join(destinationDirectory, "inventory.json"),
    canonicalExtensionJson(inventory),
    { encoding: "utf8", flag: "wx", mode: 0o644 },
  );
  const verification = await verifyDefaultExtensionBundle(destinationDirectory, {
    expectedVersion,
    serverRoot,
  });
  const notices = createDefaultExtensionNotices(verification);
  return {
    ...verification,
    inventorySha256: createHash("sha256").update(canonicalExtensionJson(inventory)).digest("hex"),
    lockSha256: await sha256File(path.join(destinationDirectory, "package-lock.json")),
    notices,
    physicalPackages: preInventory.packages.length,
    prunedPlatformModules,
    toolchain,
  };
}

function main() {
  const serverManifest = readFormattedJson(
    path.join(repositoryRoot, "server", "package.json"),
    "Server package manifest",
  );
  const verification = verifyDefaultExtensionSource({ expectedVersion: serverManifest.version });
  console.log(
    `Verified ${verification.manifest.name}@${verification.version} lock `
    + `(${verification.lockSummary.externalEntries} registry records; `
    + `${verification.lockSummary.omittedPeerIntegrityEntries} omitted Pi peer records)`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Default extension verification failed");
    process.exitCode = 1;
  }
}
