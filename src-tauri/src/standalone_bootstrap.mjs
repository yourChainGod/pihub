import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import { spawn } from "node:child_process";
import { createGunzip } from "node:zlib";

const RELEASE_OWNER = "__RELEASE_OWNER__";
const RELEASE_REPO = "__RELEASE_REPO__";
const RELEASE_CHANNEL = "__RELEASE_CHANNEL__";
const RELEASE_PUBLIC_KEY = "__RELEASE_PUBLIC_KEY__";
const RELEASE_MANIFEST_URL = "__RELEASE_MANIFEST_URL__";
const MINIMUM_SERVER_VERSION = "__MINIMUM_SERVER_VERSION__";
const PI_AGENT_PACKAGE = "__PI_AGENT_PACKAGE__";
const PI_AGENT_VERSION = "__PI_AGENT_VERSION__";
const EXTENSION_PACKAGES_BASE64 = "__EXTENSION_PACKAGES_BASE64__";

const MANIFEST_SCHEMA_VERSION = 1;
const EXTENSION_INVENTORY_SCHEMA_VERSION = 1;
const CURRENT_POINTER_SCHEMA_VERSION = 1;
const DEFAULT_EXTENSIONS_PREFERENCE_SCHEMA_VERSION = 1;
const BOOTSTRAP_JOURNAL_SCHEMA_VERSION = 4;
const MANIFEST_SIGNATURE_DOMAIN = "PIHUB-RELEASE-MANIFEST-V1\n";
const ASSET_SIGNATURE_DOMAIN = "PIHUB-RELEASE-ASSET-V1\n";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_ARCHIVE_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_RATIO = 100;
const MAX_ARCHIVE_PATH_BYTES = 1024;
const MAX_ARCHIVE_PATH_DEPTH = 32;
const MAX_PAX_BYTES = 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_EXTENSION_INVENTORY_BYTES = 8 * 1024 * 1024;
const MAX_EXTENSION_FILES = 20_000;
const MAX_EXTENSION_TOTAL_BYTES = 1024 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const ASSET_TIMEOUT_MS = 10 * 60_000;
const HEALTH_TIMEOUT_MS = 30_000;
const MAX_HEALTH_BYTES = 32 * 1024;
const AUTO_PAIR_TTL_SECONDS = 600;
const AUTO_PAIR_CODE_PATTERN = /^pihub-[A-Za-z0-9_-]{43}$/;
// Full capability set, mirroring the pairing section of server/README.md.
const AUTO_PAIR_CAPABILITIES = Object.freeze([
  "agents:use",
  "sessions:read",
  "sessions:write",
  "files:read",
  "files:write",
  "workspaces:read",
  "workspaces:manage",
  "models:read",
  "models:manage",
  "providers:manage",
  "packages:read",
  "packages:manage",
  "terminal:use",
  "system:manage",
  "system:update",
  "devices:manage",
]);
const INTERNAL_NEXT_SENTINEL = "--pihub-internal-next-runtime-v1";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RELEASE_CDN_HOSTS = new Set([
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);
const PLATFORM_VALUES = new Set(["darwin", "linux", "win32"]);
const ARCH_VALUES = new Set(["arm64", "x64"]);
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const WINDOWS_INVALID_PATH_CHARACTERS = /[<>:"|?*\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;
const STAGING_ID_PATTERN = /^[a-f0-9]{32}$/;
const JOURNAL_PHASES = new Set([
  "downloading",
  "extracting",
  "candidate-health",
  "publishing",
  "switching",
  "service",
  "committing",
]);

function fail(message) {
  throw new Error(message);
}

function extensionPackages() {
  let value;
  try {
    value = JSON.parse(Buffer.from(EXTENSION_PACKAGES_BASE64, "base64").toString("utf8"));
  } catch {
    fail("Bundled extension contract is invalid");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    fail("Bundled extension contract is invalid");
  }
  const names = new Set();
  for (const entry of value) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["name", "version"])
        || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(entry.name)
        || !isReleaseVersion(entry.version) || names.has(entry.name)) {
      fail("Bundled extension contract is invalid");
    }
    names.add(entry.name);
  }
  return Object.freeze(value.map((entry) => Object.freeze(entry)));
}

function selectedExtensionPackages(value) {
  const all = extensionPackages();
  if (value === undefined || value === null) return all;
  if (!Array.isArray(value) || value.length > all.length) fail("Selected extension contract is invalid");
  const allowed = new Map(all.map((entry) => [entry.name, entry]));
  const seen = new Set();
  const selected = [];
  for (const entry of value) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["name", "version"]) || seen.has(entry.name)) {
      fail("Selected extension contract is invalid");
    }
    const expected = allowed.get(entry.name);
    if (!expected || expected.version !== entry.version) fail("Selected extension contract is invalid");
    seen.add(entry.name);
    selected.push(expected);
  }
  return Object.freeze(selected);
}

function decodeSelectedExtensionArgument(encoded) {
  if (!safeText(encoded, 16 * 1024) || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    fail("Selected extension argument is invalid");
  }
  let value;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length > 12 * 1024 || bytes.toString("base64url") !== encoded) fail("Selected extension argument is invalid");
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("Selected extension argument is invalid");
  }
  return selectedExtensionPackages(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function hasInvalidStringCharacters(value) {
  if (CONTROL_PATTERN.test(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function safeText(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !hasInvalidStringCharacters(value);
}

function isReleaseVersion(value) {
  if (!safeText(value, 96)) return false;
  const match = VERSION_PATTERN.exec(value);
  return Boolean(match) && !match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"));
}

function skipWhitespace(text, start) {
  let index = start;
  while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  return index;
}

function assertNoDuplicateJsonKeys(text, maxNodes = 20_000) {
  let index = 0;
  let nodes = 0;

  const parseString = () => {
    const start = index;
    if (text[index] !== '"') fail("Release manifest is not valid JSON");
    index += 1;
    while (index < text.length) {
      if (text[index] === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          fail("Release manifest is not valid JSON");
        }
      }
      if (text[index] === "\\") index += 2;
      else index += 1;
    }
    fail("Release manifest is not valid JSON");
  };

  const parseValue = (depth) => {
    nodes += 1;
    if (depth > 16 || nodes > maxNodes) fail("Release manifest exceeds structural limits");
    index = skipWhitespace(text, index);
    if (text[index] === "{") {
      index += 1;
      index = skipWhitespace(text, index);
      const keys = new Set();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        const key = parseString();
        if (keys.has(key)) fail("Release manifest contains a duplicate JSON key");
        keys.add(key);
        index = skipWhitespace(text, index);
        if (text[index] !== ":") fail("Release manifest is not valid JSON");
        index += 1;
        parseValue(depth + 1);
        index = skipWhitespace(text, index);
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail("Release manifest is not valid JSON");
        index += 1;
        index = skipWhitespace(text, index);
      }
      fail("Release manifest is not valid JSON");
    }
    if (text[index] === "[") {
      index += 1;
      index = skipWhitespace(text, index);
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue(depth + 1);
        index = skipWhitespace(text, index);
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail("Release manifest is not valid JSON");
        index += 1;
      }
      fail("Release manifest is not valid JSON");
    }
    if (text[index] === '"') {
      parseString();
      return;
    }
    const start = index;
    while (index < text.length && !/[\t\n\r ,\]}]/.test(text[index])) index += 1;
    if (start === index) fail("Release manifest is not valid JSON");
    try {
      JSON.parse(text.slice(start, index));
    } catch {
      fail("Release manifest is not valid JSON");
    }
  };

  parseValue(0);
  if (skipWhitespace(text, index) !== text.length) fail("Release manifest is not valid JSON");
}

function canonicalizeValue(value, depth, seen) {
  if (depth > 16) fail("JSON value exceeds structural limits");
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (hasInvalidStringCharacters(value)) fail("JSON string is invalid");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail("JSON number is invalid");
    return JSON.stringify(value);
  }
  if (!isRecord(value) && !Array.isArray(value)) fail("JSON value is invalid");
  if (seen.has(value)) fail("JSON value is cyclic");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalizeValue(entry, depth + 1, seen)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      if (hasInvalidStringCharacters(key)) fail("JSON key is invalid");
      return `${JSON.stringify(key)}:${canonicalizeValue(value[key], depth + 1, seen)}`;
    }).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalizeReleaseJson(value) {
  return canonicalizeValue(value, 0, new WeakSet());
}

function unsignedAsset(asset) {
  return {
    version: asset.version,
    platform: asset.platform,
    arch: asset.arch,
    url: asset.url,
    sha256: asset.sha256,
    size: asset.size,
  };
}

function unsignedManifest(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    owner: manifest.owner,
    repo: manifest.repo,
    channel: manifest.channel,
    version: manifest.version,
    assets: manifest.assets,
  };
}

function decodeSignature(value) {
  if (typeof value !== "string" || !SIGNATURE_PATTERN.test(value)) fail("Release signature is invalid");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 64 || decoded.toString("base64url") !== value) fail("Release signature is invalid");
  return decoded;
}

export function createReleaseTrust({ owner, repo, channel, publicKey }) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)
      || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(repo)
      || repo === "." || repo === ".."
      || !/^[a-z0-9](?:[a-z0-9._-]{0,31})$/.test(channel)) {
    fail("Release trust policy is invalid");
  }
  let key;
  try {
    if (typeof publicKey === "string" && /^[A-Za-z0-9_-]{43}$/.test(publicKey)) {
      const raw = Buffer.from(publicKey, "base64url");
      if (raw.length !== 32 || raw.toString("base64url") !== publicKey) fail("Release public key is invalid");
      key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    } else {
      key = createPublicKey(publicKey);
    }
  } catch {
    fail("Release public key is invalid");
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") fail("Release public key is invalid");
  return Object.freeze({ owner, repo, channel, publicKey: key });
}

function parseHttpsUrl(input) {
  const raw = input instanceof URL ? input.toString() : input;
  if (!safeText(raw, 2048) || raw.includes("\\")) fail("Release URL is not allowed");
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("Release URL is not allowed");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash
      || (url.port && url.port !== "443") || url.hostname.endsWith(".")) {
    fail("Release URL is not allowed");
  }
  return url;
}

function decodedSegments(url) {
  if (/%2f|%5c/i.test(url.pathname) || url.pathname.includes("\\")) fail("Release URL is not allowed");
  let segments;
  try {
    segments = url.pathname.split("/").slice(1).map((part) => decodeURIComponent(part));
  } catch {
    fail("Release URL is not allowed");
  }
  if (segments.some((part) => !part || part === "." || part === ".." || hasInvalidStringCharacters(part))) {
    fail("Release URL is not allowed");
  }
  return segments;
}

function assertGithubReleaseUrl(input, trust, { latest = false, version } = {}) {
  const url = parseHttpsUrl(input);
  if (url.hostname.toLowerCase() !== "github.com" || url.search) fail("Release URL is not allowed");
  const parts = decodedSegments(url);
  const validLatest = latest
    && parts.length === 6
    && parts[0] === trust.owner
    && parts[1] === trust.repo
    && parts[2] === "releases"
    && parts[3] === "latest"
    && parts[4] === "download";
  const validImmutable = !latest
    && parts.length === 6
    && parts[0] === trust.owner
    && parts[1] === trust.repo
    && parts[2] === "releases"
    && parts[3] === "download"
    && (parts[4] === version || parts[4] === `v${version}`);
  if (!validLatest && !validImmutable) fail("Release URL is not allowed");
  return url;
}

function assertRedirectUrl(input, trust, previousUrl) {
  const url = parseHttpsUrl(input);
  const host = url.hostname.toLowerCase();
  if (RELEASE_CDN_HOSTS.has(host)) {
    const previousHost = previousUrl.hostname.toLowerCase();
    if (previousHost !== "github.com" && !RELEASE_CDN_HOSTS.has(previousHost)) {
      fail("GitHub release redirect is not allowed");
    }
    decodedSegments(url);
    return url;
  }
  if (host !== "github.com" || url.search) fail("GitHub release redirect is not allowed");
  const parts = decodedSegments(url);
  if (parts.length !== 6 || parts[0] !== trust.owner || parts[1] !== trust.repo
      || parts[2] !== "releases" || !new Set(["download", "latest"]).has(parts[3])) {
    fail("GitHub release redirect is not allowed");
  }
  return url;
}

function verifyAssetSignature(asset, trust) {
  const payload = Buffer.from(`${ASSET_SIGNATURE_DOMAIN}${canonicalizeReleaseJson(unsignedAsset(asset))}`, "utf8");
  if (!verifySignature(null, payload, trust.publicKey, decodeSignature(asset.signature))) {
    fail("Release asset signature is invalid");
  }
}

export function parseAndVerifyReleaseManifest(input, trust) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) fail("Release manifest exceeds the size limit");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("Release manifest is not valid UTF-8");
  }
  assertNoDuplicateJsonKeys(text);
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    fail("Release manifest is not valid JSON");
  }
  if (canonicalizeReleaseJson(manifest) !== text) fail("Release manifest JSON is not canonical");
  if (!isRecord(manifest)
      || !hasExactKeys(manifest, ["schemaVersion", "owner", "repo", "channel", "version", "assets", "signature"])
      || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION
      || manifest.owner !== trust.owner || manifest.repo !== trust.repo || manifest.channel !== trust.channel
      || !isReleaseVersion(manifest.version)
      || !Array.isArray(manifest.assets) || manifest.assets.length === 0 || manifest.assets.length > 32) {
    fail("Release manifest schema is invalid");
  }
  const identities = new Set();
  for (const asset of manifest.assets) {
    if (!isRecord(asset)
        || !hasExactKeys(asset, ["version", "platform", "arch", "url", "sha256", "size", "signature"])
        || asset.version !== manifest.version
        || !PLATFORM_VALUES.has(asset.platform) || !ARCH_VALUES.has(asset.arch)
        || !safeText(asset.url, 2048) || !SHA256_PATTERN.test(asset.sha256)
        || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES) {
      fail("Release asset schema is invalid");
    }
    assertGithubReleaseUrl(asset.url, trust, { version: manifest.version });
    const identity = `${asset.platform}/${asset.arch}`;
    if (identities.has(identity)) fail("Release manifest contains duplicate assets");
    identities.add(identity);
    verifyAssetSignature(asset, trust);
  }
  const manifestPayload = Buffer.from(
    `${MANIFEST_SIGNATURE_DOMAIN}${canonicalizeReleaseJson(unsignedManifest(manifest))}`,
    "utf8",
  );
  if (!verifySignature(null, manifestPayload, trust.publicKey, decodeSignature(manifest.signature))) {
    fail("Release manifest signature is invalid");
  }
  return Object.freeze(manifest);
}

function parsedSemver(version) {
  const [withoutBuild] = version.split("+", 1);
  const [core, prerelease = ""] = withoutBuild.split("-", 2);
  return {
    core: core.split(".").map((part) => BigInt(part)),
    prerelease: prerelease ? prerelease.split(".") : [],
  };
}

export function compareReleaseVersions(left, right) {
  if (!isReleaseVersion(left) || !isReleaseVersion(right)) fail("Release version is invalid");
  const a = parsedSemver(left);
  const b = parsedSemver(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return BigInt(av) > BigInt(bv) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}

export function detectReleaseTarget({
  platform = process.platform,
  arch = process.arch,
  reportHeader = process.report?.getReport?.()?.header,
} = {}) {
  if (!PLATFORM_VALUES.has(platform) || !ARCH_VALUES.has(arch)) fail("Unsupported Server release platform or architecture");
  if (platform === "linux") {
    const glibc = reportHeader?.glibcVersionRuntime;
    if (typeof glibc !== "string" || !/^\d+\.\d+$/.test(glibc)) {
      fail("Linux musl and unknown libc runtimes are not supported by signed PiHub Server assets");
    }
  }
  return Object.freeze({ platform, arch });
}

async function openPinnedResponse(input, trust, {
  fetchImpl = globalThis.fetch,
  initialKind,
  version,
  timeoutMs,
  maxRedirects = 3,
  accept,
}) {
  let url = assertGithubReleaseUrl(input, trust, initialKind === "manifest" ? { latest: true } : { version });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: accept, "User-Agent": "PiHub-Bootstrap/1" },
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!REDIRECT_STATUSES.has(response.status)) {
        return { response, dispose: () => { clearTimeout(timer); controller.abort(); } };
      }
      if (redirects >= maxRedirects) {
        await response.body?.cancel();
        fail("GitHub release redirected too many times");
      }
      const location = response.headers.get("location");
      if (!location || CONTROL_PATTERN.test(location)) {
        await response.body?.cancel();
        fail("GitHub release redirect is invalid");
      }
      const next = assertRedirectUrl(new URL(location, url), trust, url);
      await response.body?.cancel();
      url = next;
    }
  } catch (error) {
    clearTimeout(timer);
    controller.abort();
    if (error instanceof Error && error.message.startsWith("GitHub release")) throw error;
    if (error instanceof Error && error.message === "Release URL is not allowed") throw error;
    fail(controller.signal.aborted ? "GitHub release request timed out" : "GitHub release request failed");
  }
}

async function readBoundedResponse(response, maxBytes) {
  if (!response.ok || !response.body) fail("GitHub release request failed");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body.cancel();
    fail("GitHub release response exceeds the size limit");
  }
  const chunks = [];
  let received = 0;
  const reader = response.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      fail("GitHub release response exceeds the size limit");
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks, received);
}

async function fetchVerifiedManifest(trust, options = {}) {
  const request = await openPinnedResponse(options.manifestUrl ?? RELEASE_MANIFEST_URL, trust, {
    fetchImpl: options.fetchImpl,
    initialKind: "manifest",
    timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    accept: "application/json",
  });
  try {
    return parseAndVerifyReleaseManifest(await readBoundedResponse(request.response, MAX_MANIFEST_BYTES), trust);
  } finally {
    request.dispose();
  }
}

async function downloadVerifiedAsset(asset, trust, destination, options = {}) {
  const request = await openPinnedResponse(asset.url, trust, {
    fetchImpl: options.fetchImpl,
    initialKind: "asset",
    version: asset.version,
    timeoutMs: options.assetTimeoutMs ?? ASSET_TIMEOUT_MS,
    accept: "application/octet-stream",
  });
  let handle;
  try {
    const { response } = request;
    if (!response.ok || !response.body) fail("GitHub release asset download failed");
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") fail("Release asset content encoding is not allowed");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== asset.size)) {
      fail("Release asset size verification failed");
    }
    handle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let received = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > asset.size) {
        await reader.cancel();
        fail("Release asset size verification failed");
      }
      hash.update(chunk.value);
      await handle.write(chunk.value);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (received !== asset.size || hash.digest("hex") !== asset.sha256) {
      fail("Release asset integrity verification failed");
    }
    await chmod(destination, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    request.dispose();
  }
}

function decodeTarText(buffer, field) {
  const zero = buffer.indexOf(0);
  const contents = zero === -1 ? buffer : buffer.subarray(0, zero);
  if (zero !== -1 && buffer.subarray(zero).some((byte) => byte !== 0)) fail(`Release archive ${field} is invalid`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    fail(`Release archive ${field} is not valid UTF-8`);
  }
}

function parseTarNumber(buffer, field) {
  if ((buffer[0] & 0x80) !== 0) fail(`Release archive ${field} uses an unsupported numeric encoding`);
  const raw = buffer.toString("ascii");
  if (!/^[0-7]*[\0 ]*$/.test(raw)) fail(`Release archive ${field} is invalid`);
  const value = raw.replace(/[\0 ]+$/g, "");
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) fail(`Release archive ${field} is invalid`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`Release archive ${field} is invalid`);
  return parsed;
}

function parsePaxRecords(buffer) {
  const values = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space <= offset) fail("Release archive PAX metadata is invalid");
    const lengthText = buffer.subarray(offset, space).toString("ascii");
    if (!/^[1-9]\d*$/.test(lengthText)) fail("Release archive PAX metadata is invalid");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > buffer.length || buffer[end - 1] !== 0x0a) {
      fail("Release archive PAX metadata is invalid");
    }
    const record = buffer.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) fail("Release archive PAX metadata is invalid");
    let key;
    let value;
    try {
      key = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(0, equals));
      value = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(equals + 1));
    } catch {
      fail("Release archive PAX metadata is not valid UTF-8");
    }
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key) || hasInvalidStringCharacters(value) || values.has(key)) {
      fail("Release archive PAX metadata is invalid");
    }
    values.set(key, value);
    offset = end;
  }
  if (offset !== buffer.length) fail("Release archive PAX metadata is invalid");
  return values;
}

function normalizeArchivePath(value, kind) {
  if (kind === "directory") value = value.replace(/\/+$/, "");
  if (!value || value.normalize("NFC") !== value || CONTROL_PATTERN.test(value)
      || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)
      || Buffer.byteLength(value, "utf8") > MAX_ARCHIVE_PATH_BYTES) {
    fail("Release archive contains an unsafe path");
  }
  const segments = value.split("/");
  if (segments.length > MAX_ARCHIVE_PATH_DEPTH || segments.some((segment) => (
    !segment || segment === "." || segment === ".." || segment.normalize("NFC") !== segment
    || Buffer.byteLength(segment, "utf8") > 255 || WINDOWS_INVALID_PATH_CHARACTERS.test(segment)
    || /[. ]$/.test(segment) || WINDOWS_RESERVED_STEM.test(segment.split(".", 1)[0])
  ))) {
    fail("Release archive contains an unsafe path");
  }
  return value;
}

async function ensureArchiveParent(root, relativePath) {
  const parts = relativePath.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("Release extraction parent is unsafe");
    await chmod(current, 0o700);
  }
}

function verifyTarChecksum(header) {
  const expected = parseTarNumber(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) fail("Release archive header checksum is invalid");
}

class PortableTarExtractor {
  constructor(root, archiveBytes) {
    if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0 || archiveBytes > MAX_ASSET_BYTES) {
      fail("Release archive compressed size is invalid");
    }
    this.root = root;
    this.archiveBytes = archiveBytes;
    this.streamLimit = Math.min(
      MAX_ARCHIVE_TOTAL_BYTES + (MAX_ARCHIVE_ENTRIES * 1024) + (2 * MAX_PAX_BYTES),
      archiveBytes * MAX_ARCHIVE_RATIO,
    );
    this.buffer = Buffer.alloc(0);
    this.current = null;
    this.padding = 0;
    this.pendingPax = null;
    this.zeroBlocks = 0;
    this.ended = false;
    this.rawEntries = 0;
    this.entries = [];
    this.knownPaths = new Set();
    this.knownFiles = new Set();
    this.descendantParents = new Set();
    this.expectedFiles = new Map();
    this.expectedDirectories = new Set();
    this.totalBytes = 0;
    this.streamBytes = 0;
  }

  async consume(chunk) {
    if (chunk.length === 0) return;
    this.streamBytes += chunk.length;
    if (!Number.isSafeInteger(this.streamBytes) || this.streamBytes > this.streamLimit) {
      fail("Release archive expands beyond the stream limit");
    }
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      if (this.ended) {
        if (this.buffer.some((byte) => byte !== 0)) fail("Release archive contains trailing data");
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.current) {
        if (this.current.remaining > 0) {
          const length = Math.min(this.current.remaining, this.buffer.length);
          const part = this.buffer.subarray(0, length);
          this.buffer = this.buffer.subarray(length);
          this.current.remaining -= length;
          if (this.current.capture) {
            this.current.chunks.push(Buffer.from(part));
          } else {
            await this.current.handle.write(part);
          }
          if (this.current.remaining > 0) return;
        }
        if (this.current.handle) {
          await this.current.handle.close();
          this.current.handle = null;
        }
        if (this.current.capture) {
          this.pendingPax = parsePaxRecords(Buffer.concat(this.current.chunks, this.current.size));
        }
        this.padding = (512 - (this.current.size % 512)) % 512;
        this.current = null;
      }
      if (this.padding > 0) {
        if (this.buffer.length < this.padding) return;
        if (this.buffer.subarray(0, this.padding).some((byte) => byte !== 0)) {
          fail("Release archive padding is invalid");
        }
        this.buffer = this.buffer.subarray(this.padding);
        this.padding = 0;
      }
      if (this.buffer.length < 512) return;
      const header = this.buffer.subarray(0, 512);
      this.buffer = this.buffer.subarray(512);
      if (header.every((byte) => byte === 0)) {
        this.zeroBlocks += 1;
        if (this.zeroBlocks === 2) this.ended = true;
        continue;
      }
      if (this.zeroBlocks !== 0) fail("Release archive end marker is invalid");
      await this.beginEntry(header);
      if (this.current?.remaining === 0) {
        if (this.current.handle) {
          await this.current.handle.close();
          this.current.handle = null;
        }
        this.current = null;
      }
    }
  }

  async beginEntry(header) {
    verifyTarChecksum(header);
    this.rawEntries += 1;
    if (this.rawEntries > MAX_ARCHIVE_ENTRIES + 128) fail("Release archive contains too many entries");
    const rawSize = parseTarNumber(header.subarray(124, 136), "size");
    const type = String.fromCharCode(header[156] || 0x30);
    if (type === "x") {
      if (this.pendingPax || rawSize <= 0 || rawSize > MAX_PAX_BYTES) fail("Release archive PAX metadata is invalid");
      this.current = { remaining: rawSize, size: rawSize, capture: true, chunks: [], handle: null };
      return;
    }
    if (type === "g" || type === "L" || type === "K") fail("Release archive metadata type is not allowed");
    const name = decodeTarText(header.subarray(0, 100), "path");
    const prefix = decodeTarText(header.subarray(345, 500), "path prefix");
    const pax = this.pendingPax;
    this.pendingPax = null;
    if (pax?.has("linkpath")) fail("Release archive links are not allowed");
    const entryPath = pax?.get("path") ?? (prefix ? `${prefix}/${name}` : name);
    const sizeText = pax?.get("size");
    const size = sizeText === undefined ? rawSize : Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || (sizeText !== undefined && !/^(0|[1-9]\d*)$/.test(sizeText))) {
      fail("Release archive entry size is invalid");
    }
    const kind = type === "0" ? "file" : type === "5" ? "directory" : null;
    if (!kind) fail("Release archive contains a link or special entry");
    if ((kind === "directory" && size !== 0) || (kind === "file" && size > MAX_ARCHIVE_FILE_BYTES)) {
      fail("Release archive entry size is invalid");
    }
    if (this.entries.length >= MAX_ARCHIVE_ENTRIES) fail("Release archive contains too many entries");
    const normalized = normalizeArchivePath(entryPath, kind);
    const portableKey = normalized.toLowerCase();
    if (this.knownPaths.has(portableKey)) fail("Release archive contains colliding paths");
    const parts = portableKey.split("/");
    let parent = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      parent = parent ? `${parent}/${parts[index]}` : parts[index];
      if (this.knownFiles.has(parent)) fail("Release archive contains conflicting paths");
      this.descendantParents.add(parent);
    }
    if (kind === "file" && this.descendantParents.has(portableKey)) fail("Release archive contains conflicting paths");
    this.knownPaths.add(portableKey);
    if (kind === "file") this.knownFiles.add(portableKey);
    this.totalBytes += size;
    if (!Number.isSafeInteger(this.totalBytes) || this.totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
      fail("Release archive expands beyond the size limit");
    }
    const record = { path: normalized, kind, size };
    this.entries.push(record);
    const segments = normalized.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      this.expectedDirectories.add(segments.slice(0, index).join("/"));
    }
    const destination = path.join(this.root, ...segments);
    if (kind === "directory") {
      this.expectedDirectories.add(normalized);
      await ensureArchiveParent(this.root, `${normalized}/placeholder`);
      try {
        await mkdir(destination, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const info = await lstat(destination);
      if (!info.isDirectory() || info.isSymbolicLink()) fail("Release archive directory is unsafe");
      await chmod(destination, 0o700);
      this.padding = 0;
      return;
    }
    this.expectedFiles.set(normalized, size);
    await ensureArchiveParent(this.root, normalized);
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const handle = await open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    this.current = { remaining: size, size, capture: false, chunks: [], handle };
    if (size === 0) {
      await handle.close();
      this.current.handle = null;
    }
  }

  async finish() {
    if (this.current?.handle) await this.current.handle.close().catch(() => undefined);
    if (this.current || this.padding !== 0 || this.pendingPax || !this.ended || this.buffer.length !== 0) {
      fail("Release archive is truncated");
    }
    if (this.entries.length === 0 || this.expectedFiles.size === 0
        || this.totalBytes / this.archiveBytes > MAX_ARCHIVE_RATIO) {
      fail("Release archive contents are invalid");
    }
    return {
      entries: this.entries,
      expectedFiles: this.expectedFiles,
      expectedDirectories: this.expectedDirectories,
      totalBytes: this.totalBytes,
    };
  }
}

async function auditExtractedTree(root, archive) {
  let files = 0;
  let total = 0;
  const seenFiles = new Set();
  const seenDirectories = new Set();
  const visit = async (directory, relative) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) fail("Extracted release contains a symbolic link");
      if (info.isDirectory()) {
        if (!archive.expectedDirectories.has(name)) fail("Extracted release contains an unexpected directory");
        seenDirectories.add(name);
        await chmod(absolute, 0o700);
        await visit(absolute, name);
      } else if (info.isFile()) {
        const expected = archive.expectedFiles.get(name);
        if (expected === undefined || expected !== info.size || info.nlink !== 1) {
          fail("Extracted release file tree does not match the signed archive");
        }
        seenFiles.add(name);
        files += 1;
        total += info.size;
        await chmod(absolute, 0o600);
      } else {
        fail("Extracted release contains a special file");
      }
    }
  };
  await visit(root, "");
  if (files !== archive.expectedFiles.size || total !== archive.totalBytes
      || seenFiles.size !== archive.expectedFiles.size
      || [...archive.expectedDirectories].some((name) => !seenDirectories.has(name))) {
    fail("Extracted release file totals do not match the signed archive");
  }
}

export async function extractStandaloneArchive(archivePath, destination, archiveBytes) {
  const rootInfo = await lstat(destination);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("Release staging directory is unsafe");
  const parser = new PortableTarExtractor(destination, archiveBytes);
  const gunzip = createGunzip();
  const input = createReadStream(archivePath);
  const forwardInputError = (error) => gunzip.destroy(error);
  input.once("error", forwardInputError);
  input.pipe(gunzip);
  try {
    for await (const chunk of gunzip) await parser.consume(chunk);
    const archive = await parser.finish();
    await auditExtractedTree(destination, archive);
    return archive;
  } catch (error) {
    input.destroy();
    gunzip.destroy();
    throw error;
  } finally {
    input.off("error", forwardInputError);
  }
}

function safeAbsolutePath(value, description) {
  if (typeof value !== "string" || !path.isAbsolute(value) || CONTROL_PATTERN.test(value)) {
    fail(`${description} must be an absolute path without control characters`);
  }
  return path.resolve(value);
}

export function getServerDataRoot({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === "darwin") {
    return safeAbsolutePath(path.join(safeAbsolutePath(home, "Home directory"), "Library", "Application Support", "PiHub", "Server"), "Server data root");
  }
  if (platform === "linux") {
    const base = env.XDG_DATA_HOME?.trim()
      ? safeAbsolutePath(env.XDG_DATA_HOME.trim(), "XDG_DATA_HOME")
      : path.join(safeAbsolutePath(home, "Home directory"), ".local", "share");
    return safeAbsolutePath(path.join(base, "pihub", "server"), "Server data root");
  }
  if (platform === "win32") {
    if (!env.LOCALAPPDATA?.trim()) fail("LOCALAPPDATA is required for PiHub Server installation");
    return path.win32.resolve(path.win32.join(env.LOCALAPPDATA.trim(), "PiHub", "Server"));
  }
  fail("Unsupported Server data platform");
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("Refusing to use an unsafe Server state directory");
  await chmod(directory, 0o700);
}

async function readRegularFileBounded(file, maxBytes) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) {
    fail("Server state file is invalid");
  }
  return readFile(file, "utf8");
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" && !new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWritePrivate(file, contents) {
  await ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(16).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await chmod(file, 0o600);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseCurrentPointer(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("Installed Server current pointer is invalid");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "version"])
      || value.schemaVersion !== CURRENT_POINTER_SCHEMA_VERSION
      || (value.version !== null && !isReleaseVersion(value.version))
      || canonicalizeReleaseJson(value) !== raw) {
    fail("Installed Server current pointer is invalid");
  }
  return value;
}

function currentPointerText(version) {
  if (version !== null && !isReleaseVersion(version)) fail("Server current version is invalid");
  return canonicalizeReleaseJson({ schemaVersion: CURRENT_POINTER_SCHEMA_VERSION, version });
}

function parseBootstrapJournal(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("Bootstrap recovery journal is invalid");
  }
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schemaVersion",
        "phase",
        "version",
        "previousVersion",
        "previousPointerExisted",
        "defaultExtensionsEnabled",
        "selectedExtensions",
        "previousDefaultExtensions",
        "stagingId",
      ])
      || value.schemaVersion !== BOOTSTRAP_JOURNAL_SCHEMA_VERSION
      || !JOURNAL_PHASES.has(value.phase) || !isReleaseVersion(value.version)
      || (value.previousVersion !== null && !isReleaseVersion(value.previousVersion))
      || typeof value.previousPointerExisted !== "boolean"
      || typeof value.defaultExtensionsEnabled !== "boolean"
      || !Array.isArray(value.selectedExtensions)
      || (value.previousDefaultExtensions !== null && (
        !isRecord(value.previousDefaultExtensions)
        || !hasExactKeys(value.previousDefaultExtensions, ["enabled", "selectedExtensions"])
        || typeof value.previousDefaultExtensions.enabled !== "boolean"
        || !Array.isArray(value.previousDefaultExtensions.selectedExtensions)
      ))
      || !STAGING_ID_PATTERN.test(value.stagingId)
      || canonicalizeReleaseJson(value) !== raw) {
    fail("Bootstrap recovery journal is invalid");
  }
  selectedExtensionPackages(value.selectedExtensions);
  if (value.defaultExtensionsEnabled !== (value.selectedExtensions.length > 0)) {
    fail("Bootstrap recovery journal is invalid");
  }
  if (value.previousDefaultExtensions !== null) {
    selectedExtensionPackages(value.previousDefaultExtensions.selectedExtensions);
    if (value.previousDefaultExtensions.enabled !== (value.previousDefaultExtensions.selectedExtensions.length > 0)) {
      fail("Bootstrap recovery journal is invalid");
    }
  }
  return value;
}

function defaultExtensionsPreferenceText(enabled, selectedPackages = enabled ? extensionPackages() : []) {
  const selected = selectedExtensionPackages(selectedPackages);
  return canonicalizeReleaseJson({
    schemaVersion: DEFAULT_EXTENSIONS_PREFERENCE_SCHEMA_VERSION,
    enabled,
    ...(enabled ? { selectedPackages: selected.map(({ name, version }) => ({ name, version })) } : {}),
  });
}

function parseDefaultExtensionsPreference(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("Default extension preference is invalid");
  }
  if (!isRecord(value)
      || value.schemaVersion !== DEFAULT_EXTENSIONS_PREFERENCE_SCHEMA_VERSION
      || typeof value.enabled !== "boolean"
      || canonicalizeReleaseJson(value) !== raw) {
    fail("Default extension preference is invalid");
  }
  const keys = Object.keys(value).sort();
  const legacyKeys = ["enabled", "schemaVersion"].sort();
  const selectedKeys = ["enabled", "schemaVersion", "selectedPackages"].sort();
  if ((keys.length !== legacyKeys.length && keys.length !== selectedKeys.length)
      || !keys.every((key, index) => key === (keys.length === legacyKeys.length ? legacyKeys : selectedKeys)[index])) {
    fail("Default extension preference is invalid");
  }
  const selectedExtensions = value.enabled
    ? (keys.length === legacyKeys.length ? extensionPackages() : selectedExtensionPackages(value.selectedPackages))
    : [];
  if (value.enabled !== (selectedExtensions.length > 0)) fail("Default extension preference is invalid");
  return { enabled: value.enabled, selectedExtensions };
}

async function restorePointer(currentFile, previousPointerExisted, previousVersion) {
  if (previousPointerExisted) {
    await atomicWritePrivate(currentFile, currentPointerText(previousVersion));
  } else {
    await unlink(currentFile).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function restoreDefaultExtensionsPreference(file, previousPreference) {
  if (previousPreference === null) {
    await unlink(file).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  } else {
    await atomicWritePrivate(file, defaultExtensionsPreferenceText(previousPreference.enabled, previousPreference.selectedExtensions));
  }
}

async function recoverBootstrapJournal(paths, options = {}) {
  const raw = await readRegularFileBounded(paths.journalFile, 16 * 1024);
  if (raw === null) return;
  const journal = parseBootstrapJournal(raw);
  if (journal.phase === "switching") {
    await restorePointer(paths.currentFile, journal.previousPointerExisted, journal.previousVersion);
    await restoreDefaultExtensionsPreference(paths.defaultExtensionsPreferenceFile, journal.previousDefaultExtensions);
  } else if (journal.phase === "service") {
    const versionRoot = path.join(paths.versionsDirectory, journal.version);
    await validateBundledRuntime(versionRoot, journal.version, journal.selectedExtensions);
    await installPiLauncher(paths, { ...options, platform: options.target?.platform ?? process.platform });
    if (journal.defaultExtensionsEnabled) await provisionBundledExtensions(versionRoot, options, journal.selectedExtensions);
    await runServiceInstaller(versionRoot, options);
    await writeJournal(paths, journal, "committing");
  }
  const staging = path.join(paths.stagingDirectory, journal.stagingId);
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  await unlink(paths.journalFile);
}

async function writeJournal(paths, journal, phase) {
  const next = { ...journal, phase };
  await atomicWritePrivate(paths.journalFile, canonicalizeReleaseJson(next));
  return next;
}

function releasePaths(dataRoot) {
  return {
    dataRoot,
    versionsDirectory: path.join(dataRoot, "versions"),
    stagingDirectory: path.join(dataRoot, "staging"),
    stateDirectory: path.join(dataRoot, "state"),
    binDirectory: path.join(dataRoot, "bin"),
    currentFile: path.join(dataRoot, "state", "current.json"),
    defaultExtensionsPreferenceFile: path.join(dataRoot, "state", "default-extensions.json"),
    journalFile: path.join(dataRoot, "state", "bootstrap-install.json"),
  };
}

async function initializeReleasePaths(dataRoot, options = {}) {
  const paths = releasePaths(dataRoot);
  for (const directory of [paths.dataRoot, paths.versionsDirectory, paths.stagingDirectory, paths.stateDirectory, paths.binDirectory]) {
    await ensurePrivateDirectory(directory);
  }
  await recoverBootstrapJournal(paths, options);
  return paths;
}

async function makePrivateStaging(paths) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const id = randomBytes(16).toString("hex");
    const root = path.join(paths.stagingDirectory, id);
    try {
      await mkdir(root, { mode: 0o700 });
      const candidate = path.join(root, "candidate");
      await mkdir(candidate, { mode: 0o700 });
      return { id, root, candidate, archive: path.join(root, "release.tar.gz") };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  fail("Could not create private Server staging");
}

async function assertRegularFile(file, description) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail(`${description} is missing or unsafe`);
  return info;
}

async function readPackageMetadata(packageRoot, expectedName, expectedVersion) {
  const file = path.join(packageRoot, "package.json");
  const raw = await readRegularFileBounded(file, MAX_PACKAGE_JSON_BYTES);
  if (raw === null) fail(`Bundled package is missing: ${expectedName}`);
  let metadata;
  try {
    metadata = JSON.parse(raw);
  } catch {
    fail(`Bundled package metadata is invalid: ${expectedName}`);
  }
  if (!isRecord(metadata) || metadata.name !== expectedName || metadata.version !== expectedVersion) {
    fail(`Bundled package identity is invalid: ${expectedName}`);
  }
  return metadata;
}

const EXTENSION_RESOURCE_LAYOUT = Object.freeze({
  "@cortexkit/pi-magic-context": { extensions: ["dist/index.js"] },
  "pi-todo-rail": { extensions: ["index.ts"] },
  "@ff-labs/pi-fff": { extensions: ["src/index.ts"] },
  "pi-simplify": { extensions: ["dist/index.js"] },
  "@gotgenes/pi-permission-system": { extensions: ["src/index.ts"] },
  "@eko24ive/pi-ask": { extensions: ["src/index.ts"], skills: ["skills"] },
  "@gotgenes/pi-subagents": { extensions: ["src/index.ts"] },
});

function packagePath(root, name) {
  return path.join(root, "node_modules", ...name.split("/"));
}

function extensionDirectory(root) {
  return path.join(root, "extensions");
}

function extensionPackagePath(root, name) {
  return path.join(extensionDirectory(root), "node_modules", ...name.split("/"));
}

function comparePortablePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactExtensionDependencies(value, expected) {
  if (!isRecord(value) || Object.keys(value).length !== expected.length) return false;
  return expected.every((entry) => value[entry.name] === entry.version);
}

export function parseExtensionInventory(raw, expectedPackages) {
  if (Buffer.byteLength(raw, "utf8") === 0 || Buffer.byteLength(raw, "utf8") > MAX_EXTENSION_INVENTORY_BYTES) {
    fail("Bundled extension inventory exceeds the size limit");
  }
  // The inventory lists one {path,size,sha256} object per bundled file; scale
  // the node cap with the file cap (4 nodes per entry plus envelope) so a
  // legitimate full bundle is not rejected as a structural attack.
  assertNoDuplicateJsonKeys(raw, MAX_EXTENSION_FILES * 4 + 64);
  let inventory;
  try {
    inventory = JSON.parse(raw);
  } catch {
    fail("Bundled extension inventory is invalid JSON");
  }
  if (canonicalizeReleaseJson(inventory) !== raw
      || !isRecord(inventory)
      || !hasExactKeys(inventory, ["schemaVersion", "packages", "files", "totalBytes"])
      || inventory.schemaVersion !== EXTENSION_INVENTORY_SCHEMA_VERSION
      || !Array.isArray(inventory.packages) || inventory.packages.length !== expectedPackages.length
      || !Array.isArray(inventory.files) || inventory.files.length === 0
      || inventory.files.length > MAX_EXTENSION_FILES
      || !Number.isSafeInteger(inventory.totalBytes) || inventory.totalBytes < 0
      || inventory.totalBytes > MAX_EXTENSION_TOTAL_BYTES) {
    fail("Bundled extension inventory schema is invalid");
  }
  for (let index = 0; index < expectedPackages.length; index += 1) {
    const actual = inventory.packages[index];
    const expected = expectedPackages[index];
    if (!isRecord(actual) || !hasExactKeys(actual, ["name", "version"])
        || actual.name !== expected.name || actual.version !== expected.version) {
      fail("Bundled extension inventory package contract is invalid");
    }
  }
  let previous = null;
  let totalBytes = 0;
  const portable = new Set();
  const forbiddenPiPath = `node_modules/${PI_AGENT_PACKAGE}`;
  for (const file of inventory.files) {
    if (!isRecord(file) || !hasExactKeys(file, ["path", "size", "sha256"])
        || !safeText(file.path, MAX_ARCHIVE_PATH_BYTES)
        || normalizeArchivePath(file.path, "file") !== file.path
        || file.path === "inventory.json"
        || (file.path !== "package.json" && file.path !== "package-lock.json" && !file.path.startsWith("node_modules/"))
        || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_ARCHIVE_FILE_BYTES
        || !SHA256_PATTERN.test(file.sha256)
        || (previous !== null && comparePortablePaths(previous, file.path) >= 0)) {
      fail("Bundled extension inventory file contract is invalid");
    }
    const key = file.path.toLowerCase();
    if (portable.has(key)
        || file.path === forbiddenPiPath || file.path.startsWith(`${forbiddenPiPath}/`)
        || file.path.includes(`/${forbiddenPiPath}/`)) {
      fail("Bundled extension inventory contains a forbidden or colliding path");
    }
    portable.add(key);
    previous = file.path;
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_EXTENSION_TOTAL_BYTES) {
      fail("Bundled extension inventory exceeds the expanded-size limit");
    }
  }
  if (totalBytes !== inventory.totalBytes) fail("Bundled extension inventory total is invalid");
  return inventory;
}

async function sha256RegularFile(file, expectedSize) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(file, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== expectedSize) {
      fail("Bundled extension file is unsafe or changed");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || (before.ino !== 0 && after.ino !== before.ino) || (before.dev !== 0 && after.dev !== before.dev)) {
      fail("Bundled extension file changed during verification");
    }
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function auditExtensionInventory(root, inventory) {
  const expected = new Map(inventory.files.map((entry) => [entry.path, entry]));
  const actual = [];
  const visit = async (directory, relative) => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => comparePortablePaths(left.name, right.name));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) fail("Bundled extension tree contains a symbolic link");
      if (info.isDirectory()) {
        await visit(child, childRelative);
      } else if (info.isFile() && info.nlink === 1) {
        if (childRelative === "inventory.json") continue;
        normalizeArchivePath(childRelative, "file");
        actual.push({ path: childRelative, size: info.size, source: child });
        if (actual.length > MAX_EXTENSION_FILES) fail("Bundled extension tree contains too many files");
      } else {
        fail("Bundled extension tree contains a hard link or special entry");
      }
    }
  };
  await visit(root, "");
  actual.sort((left, right) => comparePortablePaths(left.path, right.path));
  if (actual.length !== inventory.files.length) fail("Bundled extension tree does not match its inventory");
  for (let index = 0; index < actual.length; index += 1) {
    const file = actual[index];
    const record = inventory.files[index];
    if (file.path !== record.path || file.size !== record.size || expected.get(file.path) !== record
        || await sha256RegularFile(file.source, record.size) !== record.sha256) {
      fail("Bundled extension tree does not match its inventory");
    }
  }
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

function validRegistryLockRecord(record, version) {
  return isRecord(record)
    && record.version === version
    && record.link !== true
    && typeof record.resolved === "string"
    && /^https:\/\/registry\.npmjs\.org\/[^?#]+\/-\/[^?#]+\.tgz$/.test(record.resolved)
    && typeof record.integrity === "string"
    && /^sha512-[A-Za-z0-9+/]{80,}={0,2}$/.test(record.integrity);
}

async function validateExtensionLock(root, inventory, expectedPackages, version) {
  const packageRaw = await readRegularFileBounded(path.join(root, "package.json"), MAX_PACKAGE_JSON_BYTES);
  const lockRaw = await readRegularFileBounded(path.join(root, "package-lock.json"), MAX_EXTENSION_INVENTORY_BYTES);
  if (packageRaw === null || lockRaw === null) fail("Bundled extension package contract is missing");
  let packageJson;
  let lock;
  try {
    packageJson = JSON.parse(packageRaw);
    lock = JSON.parse(lockRaw);
  } catch {
    fail("Bundled extension package contract is invalid JSON");
  }
  if (!isRecord(packageJson) || packageJson.name !== "@pihub/default-extensions"
      || packageJson.version !== version || packageJson.private !== true
      || !exactExtensionDependencies(packageJson.dependencies, expectedPackages)
      || packageJson.scripts !== undefined
      || !isRecord(lock) || lock.name !== packageJson.name || lock.version !== version
      || lock.lockfileVersion !== 3 || lock.requires !== true || !isRecord(lock.packages)) {
    fail("Bundled extension package contract is invalid");
  }
  const rootRecord = lock.packages[""];
  if (!isRecord(rootRecord) || rootRecord.name !== packageJson.name || rootRecord.version !== version
      || !exactExtensionDependencies(rootRecord.dependencies, expectedPackages)) {
    fail("Bundled extension lock root is invalid");
  }
  for (const extension of expectedPackages) {
    const key = `node_modules/${extension.name}`;
    if (!validRegistryLockRecord(lock.packages[key], extension.version)) {
      fail(`Bundled extension is not pinned by the lock: ${extension.name}`);
    }
  }
  for (const file of inventory.files) {
    const lockKey = packageLockKeyFor(file.path);
    if (lockKey === null) continue;
    const metadataRaw = await readRegularFileBounded(path.join(root, ...file.path.split("/")), MAX_PACKAGE_JSON_BYTES);
    if (metadataRaw === null) fail("Bundled extension package metadata is missing");
    let metadata;
    try {
      metadata = JSON.parse(metadataRaw);
    } catch {
      fail("Bundled extension package metadata is invalid JSON");
    }
    if (!isRecord(metadata) || !safeText(metadata.name, 214) || !isReleaseVersion(metadata.version)
        || !validRegistryLockRecord(lock.packages[lockKey], metadata.version)) {
      fail(`Bundled extension package is not locked: ${lockKey}`);
    }
  }
}

async function validateExtensionBundle(root, version) {
  const expectedPackages = extensionPackages();
  let rootInfo;
  try {
    rootInfo = await lstat(extensionDirectory(root));
  } catch (error) {
    if (error?.code === "ENOENT") fail("Signed Server release does not contain the required extension bundle");
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("Bundled extension directory is unsafe");
  const inventoryRaw = await readRegularFileBounded(
    path.join(extensionDirectory(root), "inventory.json"),
    MAX_EXTENSION_INVENTORY_BYTES,
  );
  if (inventoryRaw === null) fail("Bundled extension inventory is missing");
  const inventory = parseExtensionInventory(inventoryRaw, expectedPackages);
  await auditExtensionInventory(extensionDirectory(root), inventory);
  await validateExtensionLock(extensionDirectory(root), inventory, expectedPackages, version);
  for (const extension of expectedPackages) {
    const layout = EXTENSION_RESOURCE_LAYOUT[extension.name];
    if (!layout) fail(`Unsupported bundled extension contract: ${extension.name}`);
    const packageRoot = extensionPackagePath(root, extension.name);
    await readPackageMetadata(packageRoot, extension.name, extension.version);
    const canonicalRoot = await realpath(packageRoot);
    for (const entries of Object.values(layout)) {
      for (const relative of entries) {
        const resource = path.join(packageRoot, ...relative.split("/"));
        const canonical = await realpath(resource);
        if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`)) {
          fail(`Bundled extension resource escapes its package: ${extension.name}`);
        }
        const info = await lstat(resource);
        if ((!info.isFile() && !info.isDirectory()) || info.isSymbolicLink()) {
          fail(`Bundled extension resource is unsafe: ${extension.name}`);
        }
      }
    }
  }
}

async function validateBundledRuntime(root, version, withExtensions) {
  await readPackageMetadata(root, "@pihub/server", version);
  for (const relative of [
    ".next/BUILD_ID",
    "node_modules/next/package.json",
    "node_modules/next/dist/bin/next",
    "bin/pi-web.js",
    "bin/runtime-entry.js",
  ]) {
    await assertRegularFile(path.join(root, ...relative.split("/")), `Server runtime file ${relative}`);
  }
  const agentRoot = packagePath(root, PI_AGENT_PACKAGE);
  await readPackageMetadata(agentRoot, PI_AGENT_PACKAGE, PI_AGENT_VERSION);
  await assertRegularFile(path.join(agentRoot, "dist", "cli.js"), "Bundled Pi CLI");
  if ((Array.isArray(withExtensions) ? withExtensions.length > 0 : withExtensions === true)) {
    await validateExtensionBundle(root, version);
    for (const relative of [
      "bin/default-extensions.js",
      "lib/default-extensions.ts",
      "lib/release-manifest.ts",
      "node_modules/jiti/package.json",
      "node_modules/jiti/lib/jiti.cjs",
      "node_modules/jiti/dist/jiti.cjs",
      "node_modules/jiti/dist/babel.cjs",
    ]) {
      await assertRegularFile(path.join(root, ...relative.split("/")), `Server runtime file ${relative}`);
    }
  }
}

async function sameRegularTree(left, right) {
  const compare = async (leftDirectory, rightDirectory) => {
    const leftEntries = (await readdir(leftDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
    const rightEntries = (await readdir(rightDirectory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
    if (leftEntries.length !== rightEntries.length) return false;
    for (let index = 0; index < leftEntries.length; index += 1) {
      const a = leftEntries[index];
      const b = rightEntries[index];
      if (a.name !== b.name) return false;
      const leftPath = path.join(leftDirectory, a.name);
      const rightPath = path.join(rightDirectory, b.name);
      const leftInfo = await lstat(leftPath);
      const rightInfo = await lstat(rightPath);
      if (leftInfo.isSymbolicLink() || rightInfo.isSymbolicLink()) return false;
      if (leftInfo.isDirectory() && rightInfo.isDirectory()) {
        if (!(await compare(leftPath, rightPath))) return false;
      } else if (leftInfo.isFile() && rightInfo.isFile() && leftInfo.size === rightInfo.size) {
        const [leftHash, rightHash] = await Promise.all([leftPath, rightPath].map(async (file) => {
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(file)) hash.update(chunk);
          return hash.digest("hex");
        }));
        if (leftHash !== rightHash) return false;
      } else {
        return false;
      }
    }
    return true;
  };
  return compare(left, right);
}

async function provisionBundledExtensions(versionRoot, options = {}, selectedPackages = extensionPackages()) {
  if (options.extensionProvisioner) {
    const result = await options.extensionProvisioner(versionRoot, {
      environment: options.env,
      expectedPackages: extensionPackages(),
      selectedPackages,
      home: options.home,
    });
    return typeof result === "function" ? result : result?.rollback;
  }
  const entry = path.join(versionRoot, "bin", "default-extensions.js");
  await assertRegularFile(entry, "Signed default extension provisioner");
  const imported = await import(pathToFileURL(entry).href);
  const api = imported.default ?? imported;
  if (typeof api?.provisionDefaultExtensions !== "function") {
    fail("Signed default extension provisioner contract is invalid");
  }
  const result = await api.provisionDefaultExtensions(versionRoot, {
    environment: options.env,
    expectedPackages: extensionPackages(),
    selectedPackages,
    home: options.home,
  });
  const selectedNames = new Set(selectedPackages.map((entry) => entry.name));
  const statusPackages = isRecord(result?.status) && Array.isArray(result.status.packages)
    ? result.status.packages
    : [];
  const selectedInstalled = statusPackages.filter((entry) =>
    isRecord(entry) && selectedNames.has(entry.name) && entry.installed === true,
  ).length;
  const unselectedEnabled = statusPackages.some((entry) =>
    isRecord(entry) && !selectedNames.has(entry.name) && entry.installed === true,
  );
  if (!isRecord(result) || typeof result.rollback !== "function"
      || !isRecord(result.status) || result.status.installedCount !== selectedPackages.length
      || result.status.total !== extensionPackages().length
      || result.status.source !== "signed-release"
      || selectedInstalled !== selectedPackages.length
      || unselectedEnabled) {
    await result?.rollback?.().catch(() => undefined);
    fail("Signed default extension provisioner did not verify the installed extensions");
  }
  return result.rollback;
}

export function sanitizedChildEnvironment(source = process.env, overrides = {}) {
  const exact = new Set([
    "PATH", "HOME", "USERPROFILE", "USER", "LOGNAME", "USERNAME", "SHELL", "COMSPEC",
    "TEMP", "TMP", "TMPDIR", "LANG", "LANGUAGE", "TZ", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
    "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "DBUS_SESSION_BUS_ADDRESS", "PATHEXT",
    "SystemRoot", "WINDIR", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PI_CODING_AGENT_DIR", "TAILSCALE_SOCKET",
    // Root/admin installs are gated on these explicit opt-ins (desktop danger
    // confirmation); the service-installer child must inherit them.
    "PIHUB_ALLOW_ROOT",
    "PIHUB_ALLOW_ADMIN",
    "TS_SOCKET",
  ]);
  const result = { NODE_ENV: "production" };
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string" && (exact.has(name) || /^LC_[A-Z0-9_]+$/.test(name))) result[name] = value;
  }
  return { ...result, ...overrides };
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : port > 0 ? resolve(port) : reject(new Error("Could not reserve a health port")));
    });
  });
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function captureBounded(stream, maxBytes = 64 * 1024) {
  const chunks = [];
  let bytes = 0;
  stream?.on("data", (chunk) => {
    if (bytes >= maxBytes) return;
    const kept = Buffer.from(chunk).subarray(0, maxBytes - bytes);
    chunks.push(kept);
    bytes += kept.length;
  });
  return () => Buffer.concat(chunks, bytes).toString("utf8");
}

async function verifyPiCli(versionRoot, options = {}) {
  if (options.piVerifier) return options.piVerifier(versionRoot);
  const entry = path.join(versionRoot, "bin", "runtime-entry.js");
  const child = spawn(process.execPath, [entry, "--version"], {
    cwd: versionRoot,
    env: sanitizedChildEnvironment(options.env, {
      PI_OFFLINE: "1",
      PI_CODING_AGENT_DIR: path.join(options.stagingRoot, "pi-cli-check"),
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = captureBounded(child.stdout);
  captureBounded(child.stderr);
  const result = await Promise.race([
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Bundled Pi CLI check timed out")), 10_000)),
  ]).finally(() => terminateChild(child));
  if (result.code !== 0 || !stdout().split(/\s+/).includes(PI_AGENT_VERSION)) {
    fail("Bundled Pi CLI failed its exact version check");
  }
}

async function fetchExactHealth(port, version, signal) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    credentials: "omit",
    signal,
  });
  const body = await readBoundedResponse(response, MAX_HEALTH_BYTES);
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return false;
  }
  return isRecord(value) && value.status === "ok" && value.version === version;
}

async function runCandidateHealth(versionRoot, version, options = {}) {
  if (options.healthCheck) return options.healthCheck(versionRoot, version);
  const port = await reserveLoopbackPort();
  const entry = path.join(versionRoot, "bin", "runtime-entry.js");
  const child = spawn(process.execPath, [entry, INTERNAL_NEXT_SENTINEL, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: versionRoot,
    env: sanitizedChildEnvironment(options.env, {
      PIHUB_HEADLESS: "1",
      PIHUB_SERVER_VERSION: version,
      PIHUB_SERVER_ROOT: versionRoot,
      PI_WEB_HOSTNAME: "127.0.0.1",
      PI_CODING_AGENT_DIR: path.join(options.stagingRoot, "candidate-agent"),
      PIHUB_AUTH_STATE_PATH: path.join(options.stagingRoot, "candidate-auth.json"),
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  captureBounded(child.stdout);
  captureBounded(child.stderr);
  let exited = false;
  child.once("exit", () => { exited = true; });
  const deadline = Date.now() + (options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
  try {
    while (Date.now() < deadline && !exited) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try {
        if (await fetchExactHealth(port, version, controller.signal)) return;
      } catch {
        // Candidate startup races are retried until the total deadline.
      } finally {
        clearTimeout(timer);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    fail("Signed Server candidate failed its exact version health check");
  } finally {
    await terminateChild(child);
  }
}

async function runServiceInstaller(versionRoot, options = {}, command = "install") {
  if (command !== "install" && command !== "uninstall") fail("Invalid persistent service operation");
  if (options.serviceRunner) return options.serviceRunner(versionRoot, command);
  const installer = path.join(versionRoot, "bin", "pihub-server-install.js");
  const child = spawn(process.execPath, [installer, command], {
    cwd: versionRoot,
    env: sanitizedChildEnvironment(options.env),
    stdio: "inherit",
    windowsHide: true,
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) fail(`PiHub persistent service ${command} failed`);
}

function piLauncherSource(dataRoot) {
  return `import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const dataRoot = ${JSON.stringify(dataRoot)};
const raw = readFileSync(path.join(dataRoot, "state", "current.json"), "utf8");
if (Buffer.byteLength(raw, "utf8") > 16384) throw new Error("PiHub current pointer is invalid");
const pointer = JSON.parse(raw);
if (pointer?.schemaVersion !== 1 || !/^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/.test(pointer.version)) throw new Error("PiHub current pointer is invalid");
const versions = realpathSync(path.join(dataRoot, "versions"));
const root = realpathSync(path.join(versions, pointer.version));
if (root !== versions && !root.startsWith(versions + path.sep)) throw new Error("PiHub current release path is invalid");
const entry = path.join(root, "bin", "runtime-entry.js");
const info = lstatSync(entry);
if (!info.isFile() || info.isSymbolicLink()) throw new Error("PiHub runtime entry is invalid");
// Importing runtime-entry.js leaves require.main undefined; the marker tells
// it this process is the pi launcher, not the Next supervisor.
process.env.PIHUB_STANDALONE_LAUNCHER = "1";
await import(pathToFileURL(entry).href);
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function installPiLauncher(paths, options = {}) {
  const launcher = path.join(paths.binDirectory, "pi-launcher.mjs");
  await atomicWritePrivate(launcher, piLauncherSource(paths.dataRoot));
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  if (platform === "win32") {
    if (!env.APPDATA?.trim()) fail("APPDATA is required to install the Pi launcher");
    const shimRoot = path.win32.join(env.APPDATA.trim(), "npm");
    await ensurePrivateDirectory(shimRoot);
    const windowsLauncher = path.win32.join(paths.dataRoot, "bin", "pi-launcher.mjs");
    await atomicWritePrivate(path.win32.join(shimRoot, "pi.cmd"), `@node.exe "${windowsLauncher.replaceAll("%", "%%")}" %*\r\n`);
    const psPath = windowsLauncher.replaceAll("'", "''");
    await atomicWritePrivate(path.win32.join(shimRoot, "pi.ps1"), `& node.exe '${psPath}' @args\r\nexit $LASTEXITCODE\r\n`);
  } else {
    const bin = path.join(safeAbsolutePath(home, "Home directory"), ".local", "bin");
    await ensurePrivateDirectory(bin);
    const shim = path.join(bin, "pi");
    await atomicWritePrivate(shim, `#!/bin/sh\nexec node ${shellQuote(launcher)} "$@"\n`);
    await chmod(shim, 0o700);
  }
}

async function stageLocalArchive(source, destination) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) fail("Local release archive is not a regular file");
  if (info.size <= 0 || info.size > MAX_ASSET_BYTES) fail("Local release archive size is invalid");
  let handle;
  try {
    handle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(source)) {
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(destination, 0o600);
    return { size: info.size, sha256: hash.digest("hex") };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readBundledServerVersion(root) {
  const raw = await readRegularFileBounded(path.join(root, "package.json"), MAX_PACKAGE_JSON_BYTES);
  if (raw === null) fail("Local release archive does not contain the Server package");
  let metadata;
  try {
    metadata = JSON.parse(raw);
  } catch {
    fail("Local release archive Server package metadata is invalid");
  }
  if (!isRecord(metadata) || metadata.name !== "@pihub/server" || !isReleaseVersion(metadata.version)) {
    fail("Local release archive Server version is invalid");
  }
  return metadata.version;
}

function normalizeLocalAssetOption(value) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail("Local release archive option is invalid");
  const archivePath = safeAbsolutePath(value.path, "Local release archive");
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    fail("Local release archive sha256 is invalid");
  }
  return Object.freeze({ path: archivePath, sha256: value.sha256 });
}

// Issues a one-time pairing code against the freshly installed Server's own
// auth state. The code is returned to the caller (stdout marker line) and the
// grant file never persists beyond this function's temp directory.
async function issueAutoPairingCode(versionRoot) {
  await assertRegularFile(path.join(versionRoot, "bin", "pihub-auth-admin.js"), "Server pairing admin tool");
  const directory = await mkdtemp(path.join(tmpdir(), "pihub-pairing-"));
  await chmod(directory, 0o700);
  try {
    const request = path.join(directory, "pairing-request.json");
    const grant = path.join(directory, "pairing-grant.json");
    await writeFile(request, JSON.stringify({
      label: "PiHub Desktop (auto-pair)",
      ttlSeconds: AUTO_PAIR_TTL_SECONDS,
      capabilities: AUTO_PAIR_CAPABILITIES,
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const child = spawn(
      process.execPath,
      [path.join(versionRoot, "bin", "pihub-auth-admin.js"), "issue", "--input", request, "--output", grant],
      { cwd: versionRoot, env: sanitizedChildEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const stdout = captureBounded(child.stdout);
    const stderr = captureBounded(child.stderr);
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0) fail(`Server pairing admin tool failed: ${stderr() || stdout()}`.slice(0, 512));
    const text = await readFile(grant, "utf8");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      fail("Server pairing grant is invalid");
    }
    if (!isRecord(value) || typeof value.code !== "string" || !AUTO_PAIR_CODE_PATTERN.test(value.code)) {
      fail("Server pairing grant is invalid");
    }
    return value.code;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installStandaloneRelease(options = {}) {
  const target = options.target ?? detectReleaseTarget(options.targetOptions);
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0 && !options.allowRootForTests) {
    // Root installs are allowed only when the desktop user explicitly confirmed
    // them; the rendered bootstrap then exports PIHUB_ALLOW_ROOT=1.
    if (process.env.PIHUB_ALLOW_ROOT !== "1") {
      fail("PiHub Server must be installed as an unprivileged signed-in user (root requires explicit confirmation in PiHub Desktop)");
    }
  }
  const trust = options.trust ?? createReleaseTrust({
    owner: RELEASE_OWNER,
    repo: RELEASE_REPO,
    channel: RELEASE_CHANNEL,
    publicKey: RELEASE_PUBLIC_KEY,
  });
  const minimumVersion = options.minimumVersion ?? MINIMUM_SERVER_VERSION;
  if (!isReleaseVersion(minimumVersion)) fail("Minimum Server version is invalid");
  const dataRoot = safeAbsolutePath(
    options.dataRoot ?? getServerDataRoot({ platform: target.platform, env: options.env, home: options.home }),
    "Server data root",
  );
  const localAsset = normalizeLocalAssetOption(options.localAsset);
  const paths = await initializeReleasePaths(dataRoot, { ...options, target });
  const currentRaw = await readRegularFileBounded(paths.currentFile, 16 * 1024);
  const current = currentRaw === null ? null : parseCurrentPointer(currentRaw);
  const previousPreferenceRaw = await readRegularFileBounded(paths.defaultExtensionsPreferenceFile, 16 * 1024);
  const previousDefaultExtensions = previousPreferenceRaw === null
    ? null
    : parseDefaultExtensionsPreference(previousPreferenceRaw);
  const selectedPackages = options.selectedExtensions === undefined
    ? (options.withExtensions === true ? extensionPackages() : Object.freeze([]))
    : selectedExtensionPackages(options.selectedExtensions);
  // An update that carries no extension selection must not silently disable
  // the extensions a previous install provisioned: inherit that preference so
  // facades get re-pointed at the new version directory.
  const effectivePackages = selectedPackages.length > 0
    ? selectedPackages
    : previousDefaultExtensions?.enabled
      ? previousDefaultExtensions.selectedExtensions
      : selectedPackages;
  const withExtensions = effectivePackages.length > 0;
  const staging = await makePrivateStaging(paths);
  let asset = null;
  let version;
  if (localAsset) {
    // Local archive mode: the desktop uploaded a prebuilt tarball over SSH;
    // integrity comes from the pinned sha256 instead of the GitHub signature
    // chain. Extraction and structural validation are identical afterwards.
    try {
      const staged = await stageLocalArchive(localAsset.path, staging.archive);
      if (staged.sha256 !== localAsset.sha256) fail("Local release archive integrity verification failed");
      await extractStandaloneArchive(staging.archive, staging.candidate, staged.size);
      version = await readBundledServerVersion(staging.candidate);
    } catch (error) {
      await rm(staging.root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    if (compareReleaseVersions(version, minimumVersion) < 0) fail("Local Server release is older than this PiHub Desktop");
    if (current?.version && compareReleaseVersions(version, current.version) < 0) {
      fail("Local Server release downgrade is blocked");
    }
  } else {
    const manifest = await fetchVerifiedManifest(trust, options);
    version = manifest.version;
    if (compareReleaseVersions(version, minimumVersion) < 0) fail("Signed Server release is older than this PiHub Desktop");
    if (current?.version && compareReleaseVersions(version, current.version) < 0) {
      fail("Signed Server release downgrade is blocked");
    }
    asset = manifest.assets.find((entry) => entry.platform === target.platform && entry.arch === target.arch);
    if (!asset) fail("Signed Server release has no compatible asset");
  }
  let journal = {
    schemaVersion: BOOTSTRAP_JOURNAL_SCHEMA_VERSION,
    phase: localAsset ? "extracting" : "downloading",
    version,
    previousVersion: current?.version ?? null,
    previousPointerExisted: currentRaw !== null,
    defaultExtensionsEnabled: withExtensions,
    selectedExtensions: effectivePackages,
    previousDefaultExtensions,
    stagingId: staging.id,
  };
  let published = false;
  let pointerChanged = false;
  let preferenceChanged = false;
  let serviceAttempted = false;
  let serviceCompleted = false;
  let rollbackExtensionProvisioning = null;
  await atomicWritePrivate(paths.journalFile, canonicalizeReleaseJson(journal));
  try {
    if (asset) {
      await downloadVerifiedAsset(asset, trust, staging.archive, options);
      journal = await writeJournal(paths, journal, "extracting");
      await extractStandaloneArchive(staging.archive, staging.candidate, asset.size);
    }
    await validateBundledRuntime(staging.candidate, version, effectivePackages);
    await verifyPiCli(staging.candidate, { ...options, stagingRoot: staging.root });
    journal = await writeJournal(paths, journal, "candidate-health");
    await runCandidateHealth(staging.candidate, version, { ...options, stagingRoot: staging.root });
    journal = await writeJournal(paths, journal, "publishing");
    const destination = path.join(paths.versionsDirectory, version);
    try {
      const existing = await lstat(destination);
      if (!existing.isDirectory() || existing.isSymbolicLink() || !(await sameRegularTree(staging.candidate, destination))) {
        fail("Installed Server version conflicts with the signed release");
      }
      await rm(staging.candidate, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await rename(staging.candidate, destination);
      await chmod(destination, 0o700);
      await syncDirectory(paths.versionsDirectory);
      published = true;
    }
    await validateBundledRuntime(destination, version, effectivePackages);
    journal = await writeJournal(paths, journal, "switching");
    await atomicWritePrivate(paths.currentFile, currentPointerText(version));
    pointerChanged = true;
    await atomicWritePrivate(paths.defaultExtensionsPreferenceFile, defaultExtensionsPreferenceText(withExtensions, effectivePackages));
    preferenceChanged = true;
    await installPiLauncher(paths, { ...options, platform: target.platform });
    journal = await writeJournal(paths, journal, "service");
    if (withExtensions) rollbackExtensionProvisioning = await provisionBundledExtensions(destination, options, effectivePackages);
    serviceAttempted = true;
    await runServiceInstaller(destination, options);
    serviceCompleted = true;
    journal = await writeJournal(paths, journal, "committing");
    await unlink(paths.journalFile).catch(() => undefined);
    await rm(staging.root, { recursive: true, force: true }).catch(() => undefined);
    return Object.freeze({ version, installed: current?.version !== version || published });
  } catch (error) {
    const rollbackErrors = [];
    if (rollbackExtensionProvisioning) {
      try {
        await rollbackExtensionProvisioning();
      } catch (failure) {
        rollbackErrors.push(failure);
      }
    }
    if (preferenceChanged) {
      await restoreDefaultExtensionsPreference(
        paths.defaultExtensionsPreferenceFile,
        previousDefaultExtensions,
      ).catch((failure) => rollbackErrors.push(failure));
    }
    if (pointerChanged) {
      await restorePointer(paths.currentFile, currentRaw !== null, current?.version ?? null)
        .catch((failure) => rollbackErrors.push(failure));
    }
    if (serviceCompleted) {
      const rollbackRoot = current?.version
        ? path.join(paths.versionsDirectory, current.version)
        : path.join(paths.versionsDirectory, version);
      const rollbackCommand = current?.version ? "install" : "uninstall";
      await runServiceInstaller(rollbackRoot, options, rollbackCommand)
        .catch((failure) => rollbackErrors.push(failure));
    }
    if (published && !serviceAttempted) {
      await rm(path.join(paths.versionsDirectory, version), { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(staging.root, { recursive: true, force: true }).catch(() => undefined);
    await unlink(paths.journalFile).catch(() => undefined);
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "PiHub install failed and rollback was incomplete");
    }
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] !== undefined && args[0] !== "--with-extensions" && !args[0].startsWith("--with-extensions="))) {
    fail("Invalid PiHub standalone bootstrap arguments");
  }
  let selectedExtensions;
  if (args[0] === "--with-extensions") selectedExtensions = extensionPackages();
  else if (args[0]?.startsWith("--with-extensions=")) {
    selectedExtensions = decodeSelectedExtensionArgument(args[0].slice("--with-extensions=".length));
  } else selectedExtensions = Object.freeze([]);
  const localArchive = process.env.PIHUB_LOCAL_ARCHIVE;
  const result = await installStandaloneRelease({
    selectedExtensions,
    localAsset: localArchive === undefined
      ? undefined
      : { path: localArchive, sha256: process.env.PIHUB_LOCAL_ARCHIVE_SHA256 },
  });
  console.log(result.installed ? "PIHUB_SERVER_INSTALLED" : "PIHUB_SERVER_SKIPPED");
  console.log(`PIHUB_SERVER_VERSION=${result.version}`);
  if (process.env.PIHUB_AUTO_PAIR === "1") {
    try {
      const versionRoot = path.join(getServerDataRoot(), "versions", result.version);
      const code = await issueAutoPairingCode(versionRoot);
      console.log(`PIHUB_PAIRING_CODE=${code}`);
    } catch (error) {
      console.error(`[pihub] 自动配对签发失败：${error instanceof Error ? error.message : "unknown error"}（安装已完成，可稍后在目标机手动签发配对码）`);
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "PiHub standalone bootstrap failed");
    process.exitCode = 1;
  });
}
