import {
  createPublicKey,
  KeyObject,
  verify as verifySignature,
} from "node:crypto";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const MAX_RELEASE_MANIFEST_BYTES = 256 * 1024;
export const MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 20_000;
const MAX_RELEASE_ASSETS = 32;
const MAX_URL_LENGTH = 2_048;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_FETCH_MAX_REDIRECTS = 3;
const MANIFEST_SIGNATURE_DOMAIN = "PIHUB-RELEASE-MANIFEST-V1\n";
const ASSET_SIGNATURE_DOMAIN = "PIHUB-RELEASE-ASSET-V1\n";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RELEASE_CDN_HOSTS = new Set([
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);
const PLATFORM_VALUES = new Set(["darwin", "linux", "win32"]);
const ARCH_VALUES = new Set(["arm64", "x64"]);
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const CHANNEL_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,31})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64URL_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
]);

export type ReleasePlatform = "darwin" | "linux" | "win32";
export type ReleaseArchitecture = "arm64" | "x64";

export interface ReleaseAsset {
  version: string;
  platform: ReleasePlatform;
  arch: ReleaseArchitecture;
  url: string;
  sha256: string;
  size: number;
  signature: string;
}

export interface ReleaseManifest {
  schemaVersion: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  owner: string;
  repo: string;
  channel: string;
  version: string;
  assets: ReleaseAsset[];
  signature: string;
}

declare const VERIFIED_RELEASE_MANIFEST: unique symbol;
export type VerifiedReleaseManifest = Readonly<ReleaseManifest> & {
  readonly [VERIFIED_RELEASE_MANIFEST]: true;
};

declare const RELEASE_TRUST: unique symbol;
export interface ReleaseTrust {
  readonly owner: string;
  readonly repo: string;
  readonly channel: string;
  readonly publicKey: KeyObject;
  readonly [RELEASE_TRUST]: true;
}

export type ReleaseManifestErrorCode =
  | "invalid_trust"
  | "manifest_too_large"
  | "invalid_utf8"
  | "invalid_json"
  | "duplicate_key"
  | "non_canonical_json"
  | "invalid_schema"
  | "untrusted_release"
  | "invalid_signature"
  | "invalid_url"
  | "redirect_blocked"
  | "token_rejected"
  | "response_too_large"
  | "timeout"
  | "network_failure";

export class ReleaseManifestError extends Error {
  readonly code: ReleaseManifestErrorCode;

  constructor(code: ReleaseManifestErrorCode, message: string) {
    super(message);
    this.name = "ReleaseManifestError";
    this.code = code;
  }
}

function fail(code: ReleaseManifestErrorCode, message: string): never {
  throw new ReleaseManifestError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasInvalidStringCharacters(value: string): boolean {
  if (CONTROL_CHARACTER_PATTERN.test(value)) return true;
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

function assertSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !hasInvalidStringCharacters(value);
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    fail("invalid_schema", "Release manifest schema is invalid");
  }
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[\t\n\r ]/.test(text[index])) index += 1;
  return index;
}

/** Detect duplicate JSON keys before JSON.parse applies its last-key-wins rule. */
function assertNoDuplicateJsonKeys(text: string): void {
  let index = 0;
  let nodes = 0;

  const parseStringToken = (): string => {
    const start = index;
    if (text[index] !== '"') fail("invalid_json", "Release manifest is not valid JSON");
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          fail("invalid_json", "Release manifest is not valid JSON");
        }
      }
      if (character === "\\") {
        index += 2;
      } else {
        index += 1;
      }
    }
    fail("invalid_json", "Release manifest is not valid JSON");
  };

  const parseValue = (depth: number): void => {
    nodes += 1;
    if (depth > MAX_JSON_DEPTH || nodes > MAX_JSON_NODES) {
      fail("invalid_schema", "Release manifest exceeds structural limits");
    }
    index = skipWhitespace(text, index);
    const character = text[index];
    if (character === "{") {
      index += 1;
      index = skipWhitespace(text, index);
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        const key = parseStringToken();
        if (keys.has(key)) fail("duplicate_key", "Release manifest contains a duplicate JSON key");
        keys.add(key);
        index = skipWhitespace(text, index);
        if (text[index] !== ":") fail("invalid_json", "Release manifest is not valid JSON");
        index += 1;
        parseValue(depth + 1);
        index = skipWhitespace(text, index);
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") fail("invalid_json", "Release manifest is not valid JSON");
        index += 1;
        index = skipWhitespace(text, index);
      }
      fail("invalid_json", "Release manifest is not valid JSON");
    }
    if (character === "[") {
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
        if (text[index] !== ",") fail("invalid_json", "Release manifest is not valid JSON");
        index += 1;
      }
      fail("invalid_json", "Release manifest is not valid JSON");
    }
    if (character === '"') {
      parseStringToken();
      return;
    }

    const start = index;
    while (index < text.length && !/[\t\n\r ,\]}]/.test(text[index])) index += 1;
    if (start === index) fail("invalid_json", "Release manifest is not valid JSON");
    try {
      JSON.parse(text.slice(start, index));
    } catch {
      fail("invalid_json", "Release manifest is not valid JSON");
    }
  };

  parseValue(0);
  if (skipWhitespace(text, index) !== text.length) {
    fail("invalid_json", "Release manifest is not valid JSON");
  }
}

function canonicalizeJsonValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): string {
  if (depth > MAX_JSON_DEPTH) fail("invalid_schema", "JSON value exceeds structural limits");
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (hasInvalidStringCharacters(value)) fail("invalid_schema", "JSON string is invalid");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail("invalid_schema", "JSON number is invalid");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    fail("invalid_schema", "JSON value is invalid");
  }
  if (seen.has(value)) fail("invalid_schema", "JSON value is cyclic");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalizeJsonValue(entry, depth + 1, seen)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      if (hasInvalidStringCharacters(key)) fail("invalid_schema", "JSON key is invalid");
      return `${JSON.stringify(key)}:${canonicalizeJsonValue(record[key], depth + 1, seen)}`;
    }).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Canonical JSON for the deliberately integer-only release protocol. */
export function canonicalizeReleaseJson(value: unknown): string {
  return canonicalizeJsonValue(value, 0, new WeakSet());
}

function isStableOrPrereleaseVersion(value: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return false;
  return !match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"));
}

export function isReleaseVersion(value: unknown): value is string {
  return assertSafeText(value, 96) && isStableOrPrereleaseVersion(value);
}

function normalizePublicKey(input: string | Uint8Array | KeyObject): KeyObject {
  try {
    let key: KeyObject;
    if (input instanceof KeyObject) {
      key = input;
    } else if (input instanceof Uint8Array) {
      if (input.byteLength !== 32) fail("invalid_trust", "Release public key is invalid");
      key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input)]),
        format: "der",
        type: "spki",
      });
    } else if (typeof input === "string" && input.includes("BEGIN PUBLIC KEY")) {
      key = createPublicKey(input);
    } else if (typeof input === "string" && /^[A-Za-z0-9_-]{43}$/.test(input)) {
      const raw = Buffer.from(input, "base64url");
      if (raw.toString("base64url") !== input) fail("invalid_trust", "Release public key is invalid");
      key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
        format: "der",
        type: "spki",
      });
    } else {
      fail("invalid_trust", "Release public key is invalid");
    }
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      fail("invalid_trust", "Release public key is invalid");
    }
    return key;
  } catch (error) {
    if (error instanceof ReleaseManifestError) throw error;
    fail("invalid_trust", "Release public key is invalid");
  }
}

/** Pin repository identity, channel and Ed25519 key once at integration time. */
export function createReleaseTrust(config: {
  owner: string;
  repo: string;
  channel: string;
  publicKey: string | Uint8Array | KeyObject;
}): ReleaseTrust {
  if (
    !assertSafeText(config.owner, 39)
    || !OWNER_PATTERN.test(config.owner)
    || !assertSafeText(config.repo, 100)
    || !REPO_PATTERN.test(config.repo)
    || config.repo === "."
    || config.repo === ".."
    || !assertSafeText(config.channel, 32)
    || !CHANNEL_PATTERN.test(config.channel)
  ) {
    fail("invalid_trust", "Release trust policy is invalid");
  }
  return Object.freeze({
    owner: config.owner,
    repo: config.repo,
    channel: config.channel,
    publicKey: normalizePublicKey(config.publicKey),
  }) as ReleaseTrust;
}

function decodeSignature(value: unknown): Buffer {
  if (typeof value !== "string" || !BASE64URL_SIGNATURE_PATTERN.test(value)) {
    fail("invalid_signature", "Release signature is invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 64 || decoded.toString("base64url") !== value) {
    fail("invalid_signature", "Release signature is invalid");
  }
  return decoded;
}

function unsignedAsset(asset: ReleaseAsset): Omit<ReleaseAsset, "signature"> {
  return {
    version: asset.version,
    platform: asset.platform,
    arch: asset.arch,
    url: asset.url,
    sha256: asset.sha256,
    size: asset.size,
  };
}

function unsignedManifest(manifest: ReleaseManifest): Omit<ReleaseManifest, "signature"> {
  return {
    schemaVersion: manifest.schemaVersion,
    owner: manifest.owner,
    repo: manifest.repo,
    channel: manifest.channel,
    version: manifest.version,
    assets: manifest.assets,
  };
}

export function releaseAssetSigningPayload(
  asset: Omit<ReleaseAsset, "signature"> | ReleaseAsset,
): Buffer {
  return Buffer.from(`${ASSET_SIGNATURE_DOMAIN}${canonicalizeReleaseJson(unsignedAsset(asset as ReleaseAsset))}`, "utf8");
}

export function releaseManifestSigningPayload(
  manifest: Omit<ReleaseManifest, "signature"> | ReleaseManifest,
): Buffer {
  return Buffer.from(`${MANIFEST_SIGNATURE_DOMAIN}${canonicalizeReleaseJson(unsignedManifest(manifest as ReleaseManifest))}`, "utf8");
}

function decodedPathSegments(url: URL): string[] {
  if (/%2f|%5c/i.test(url.pathname) || url.pathname.includes("\\")) {
    fail("invalid_url", "Release URL is not allowed");
  }
  try {
    const segments = url.pathname.split("/").slice(1).map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => hasInvalidStringCharacters(segment) || segment === "." || segment === "..")) {
      fail("invalid_url", "Release URL is not allowed");
    }
    return segments;
  } catch (error) {
    if (error instanceof ReleaseManifestError) throw error;
    fail("invalid_url", "Release URL is not allowed");
  }
}

function parseHttpsUrl(input: string | URL): URL {
  const raw = input instanceof URL ? input.toString() : input;
  if (!raw || raw.length > MAX_URL_LENGTH || CONTROL_CHARACTER_PATTERN.test(raw) || raw.includes("\\")) {
    fail("invalid_url", "Release URL is not allowed");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("invalid_url", "Release URL is not allowed");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.hash
    || (url.port && url.port !== "443")
    || url.hostname.endsWith(".")
  ) {
    fail("invalid_url", "Release URL is not allowed");
  }
  return url;
}

function assertPinnedRepositoryPath(url: URL, trust: ReleaseTrust): void {
  const hostname = url.hostname.toLowerCase();
  const segments = decodedPathSegments(url);
  if (hostname === "github.com") {
    const immutableAssetPath = segments.length === 6
      && segments[0] === trust.owner
      && segments[1] === trust.repo
      && segments[2] === "releases"
      && segments[3] === "download"
      && Boolean(segments[4])
      && Boolean(segments[5]);
    const latestAssetPath = segments.length === 6
      && segments[0] === trust.owner
      && segments[1] === trust.repo
      && segments[2] === "releases"
      && segments[3] === "latest"
      && segments[4] === "download"
      && Boolean(segments[5]);
    if (
      url.search
      || (!immutableAssetPath && !latestAssetPath)
    ) {
      fail("invalid_url", "Release URL is not allowed");
    }
    return;
  }
  if (hostname === "api.github.com") {
    const assetPath = segments.length === 6
      && segments[0] === "repos"
      && segments[1] === trust.owner
      && segments[2] === trust.repo
      && segments[3] === "releases"
      && segments[4] === "assets"
      && /^\d+$/.test(segments[5]);
    const latestPath = segments.length === 5
      && segments[0] === "repos"
      && segments[1] === trust.owner
      && segments[2] === trust.repo
      && segments[3] === "releases"
      && segments[4] === "latest";
    if (url.search || (!assetPath && !latestPath)) fail("invalid_url", "Release URL is not allowed");
    return;
  }
  if (hostname === "raw.githubusercontent.com") {
    if (
      url.search
      || segments.length < 4
      || segments[0] !== trust.owner
      || segments[1] !== trust.repo
      || !segments.slice(2).every(Boolean)
    ) {
      fail("invalid_url", "Release URL is not allowed");
    }
    return;
  }
  fail("invalid_url", "Release URL is not allowed");
}

/** Validate an initial request URL. Opaque GitHub object hosts are redirect-only. */
export function assertPinnedGithubUrl(input: string | URL, trust: ReleaseTrust): URL {
  const url = parseHttpsUrl(input);
  assertPinnedRepositoryPath(url, trust);
  return url;
}

function assertRedirectUrl(input: string | URL, trust: ReleaseTrust, fromTrustedHop: boolean): URL {
  const url = parseHttpsUrl(input);
  const hostname = url.hostname.toLowerCase();
  if (RELEASE_CDN_HOSTS.has(hostname)) {
    if (!fromTrustedHop || !url.pathname || url.pathname === "/") {
      fail("redirect_blocked", "GitHub release redirect is not allowed");
    }
    decodedPathSegments(url);
    return url;
  }
  try {
    assertPinnedRepositoryPath(url, trust);
    return url;
  } catch (error) {
    if (error instanceof ReleaseManifestError) {
      fail("redirect_blocked", "GitHub release redirect is not allowed");
    }
    throw error;
  }
}

function validateAsset(value: unknown, manifestVersion: string, trust: ReleaseTrust): ReleaseAsset {
  if (!isRecord(value)) fail("invalid_schema", "Release asset schema is invalid");
  assertExactKeys(value, ["version", "platform", "arch", "url", "sha256", "size", "signature"]);
  if (
    !isReleaseVersion(value.version)
    || value.version !== manifestVersion
    || typeof value.platform !== "string"
    || !PLATFORM_VALUES.has(value.platform)
    || typeof value.arch !== "string"
    || !ARCH_VALUES.has(value.arch)
    || !assertSafeText(value.url, MAX_URL_LENGTH)
    || typeof value.sha256 !== "string"
    || !SHA256_PATTERN.test(value.sha256)
    || typeof value.size !== "number"
    || !Number.isSafeInteger(value.size)
    || value.size <= 0
    || value.size > MAX_RELEASE_ASSET_BYTES
    || typeof value.signature !== "string"
  ) {
    fail("invalid_schema", "Release asset schema is invalid");
  }

  const url = assertPinnedGithubUrl(value.url, trust);
  if (url.hostname.toLowerCase() === "github.com") {
    const tag = decodedPathSegments(url)[4];
    if (tag !== manifestVersion && tag !== `v${manifestVersion}`) {
      fail("untrusted_release", "Release asset does not match the signed version");
    }
  }

  const asset: ReleaseAsset = {
    version: value.version,
    platform: value.platform as ReleasePlatform,
    arch: value.arch as ReleaseArchitecture,
    url: value.url,
    sha256: value.sha256,
    size: value.size,
    signature: value.signature,
  };
  decodeSignature(asset.signature);
  return asset;
}

export function verifyReleaseAssetSignature(asset: ReleaseAsset, trust: ReleaseTrust): void {
  const signature = decodeSignature(asset.signature);
  let valid = false;
  try {
    valid = verifySignature(null, releaseAssetSigningPayload(asset), trust.publicKey, signature);
  } catch {
    fail("invalid_signature", "Release asset signature is invalid");
  }
  if (!valid) fail("invalid_signature", "Release asset signature is invalid");
}

function decodeManifestInput(input: string | Uint8Array): string {
  const byteLength = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (byteLength === 0 || byteLength > MAX_RELEASE_MANIFEST_BYTES) {
    fail("manifest_too_large", "Release manifest exceeds the size limit");
  }
  if (typeof input === "string") return input;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    fail("invalid_utf8", "Release manifest is not valid UTF-8");
  }
}

export function parseAndVerifyReleaseManifest(
  input: string | Uint8Array,
  trust: ReleaseTrust,
): VerifiedReleaseManifest {
  const text = decodeManifestInput(input);
  assertNoDuplicateJsonKeys(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("invalid_json", "Release manifest is not valid JSON");
  }
  if (canonicalizeReleaseJson(parsed) !== text) {
    fail("non_canonical_json", "Release manifest JSON is not canonical");
  }
  if (!isRecord(parsed)) fail("invalid_schema", "Release manifest schema is invalid");
  assertExactKeys(parsed, ["schemaVersion", "owner", "repo", "channel", "version", "assets", "signature"]);
  if (
    parsed.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION
    || !assertSafeText(parsed.owner, 39)
    || !assertSafeText(parsed.repo, 100)
    || !assertSafeText(parsed.channel, 32)
    || !isReleaseVersion(parsed.version)
    || !Array.isArray(parsed.assets)
    || parsed.assets.length === 0
    || parsed.assets.length > MAX_RELEASE_ASSETS
    || typeof parsed.signature !== "string"
  ) {
    fail("invalid_schema", "Release manifest schema is invalid");
  }
  if (parsed.owner !== trust.owner || parsed.repo !== trust.repo || parsed.channel !== trust.channel) {
    fail("untrusted_release", "Release manifest does not match the configured release source");
  }

  const assets = parsed.assets.map((asset) => validateAsset(asset, parsed.version as string, trust));
  const identities = new Set<string>();
  const urls = new Set<string>();
  for (const asset of assets) {
    const identity = `${asset.platform}/${asset.arch}`;
    if (identities.has(identity) || urls.has(asset.url)) {
      fail("invalid_schema", "Release manifest contains duplicate assets");
    }
    identities.add(identity);
    urls.add(asset.url);
  }

  const manifest: ReleaseManifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    owner: parsed.owner as string,
    repo: parsed.repo as string,
    channel: parsed.channel as string,
    version: parsed.version as string,
    assets,
    signature: parsed.signature,
  };
  const manifestSignature = decodeSignature(manifest.signature);
  let manifestValid = false;
  try {
    manifestValid = verifySignature(
      null,
      releaseManifestSigningPayload(manifest),
      trust.publicKey,
      manifestSignature,
    );
  } catch {
    fail("invalid_signature", "Release manifest signature is invalid");
  }
  if (!manifestValid) fail("invalid_signature", "Release manifest signature is invalid");
  for (const asset of manifest.assets) verifyReleaseAssetSignature(asset, trust);

  for (const asset of manifest.assets) Object.freeze(asset);
  Object.freeze(manifest.assets);
  return Object.freeze(manifest) as VerifiedReleaseManifest;
}

export function selectReleaseAsset(
  manifest: VerifiedReleaseManifest,
  platform: ReleasePlatform,
  arch: ReleaseArchitecture,
): Readonly<ReleaseAsset> {
  const asset = manifest.assets.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  if (!asset) fail("invalid_schema", "Release manifest has no compatible asset");
  return asset;
}

export interface GithubFetchOptions {
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  token?: string;
  allowToken?: boolean;
  accept?: string;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ReleaseManifestError("timeout", "GitHub release request timed out"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ReleaseManifestError("timeout", "GitHub release request timed out"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function boundedResponse(response: Response, maxBodyBytes: number, signal: AbortSignal): Response {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBodyBytes)) {
    void response.body?.cancel();
    fail("response_too_large", "GitHub release response exceeds the size limit");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let received = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await awaitWithAbort(reader.read(), signal);
        if (chunk.done) {
          controller.close();
          return;
        }
        received += chunk.value.byteLength;
        if (received > maxBodyBytes) {
          await reader.cancel();
          controller.error(new ReleaseManifestError("response_too_large", "GitHub release response exceeds the size limit"));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        try { await reader.cancel(); } catch { /* request already failed */ }
        controller.error(error instanceof ReleaseManifestError
          ? error
          : new ReleaseManifestError("network_failure", "GitHub release response failed"));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function validateFetchLimits(options: GithubFetchOptions): {
  timeoutMs: number;
  maxBodyBytes: number;
  maxRedirects: number;
} {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_RELEASE_MANIFEST_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_FETCH_MAX_REDIRECTS;
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || !Number.isSafeInteger(maxBodyBytes)
    || maxBodyBytes <= 0
    || maxBodyBytes > MAX_RELEASE_ASSET_BYTES
    || !Number.isSafeInteger(maxRedirects)
    || maxRedirects < 0
    || maxRedirects > 8
  ) {
    fail("invalid_url", "GitHub release request policy is invalid");
  }
  return { timeoutMs, maxBodyBytes, maxRedirects };
}

/**
 * Fetch a pinned GitHub resource with one total deadline and a bounded stream.
 * Authorization is opt-in and is permanently removed on the first origin change.
 */
export async function fetchPinnedGithubResource(
  input: string | URL,
  trust: ReleaseTrust,
  options: GithubFetchOptions = {},
): Promise<Response> {
  const { timeoutMs, maxBodyBytes, maxRedirects } = validateFetchLimits(options);
  if (options.token !== undefined && options.allowToken !== true) {
    fail("token_rejected", "GitHub token use is disabled by the release policy");
  }
  if (
    options.token !== undefined
    && (!options.token || options.token.length > 4_096 || CONTROL_CHARACTER_PATTERN.test(options.token))
  ) {
    fail("token_rejected", "GitHub token is invalid");
  }

  let url = assertPinnedGithubUrl(input, trust);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let credentialsAllowed = true;
  let trustedHop = true;

  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      const headers = new Headers({
        Accept: options.accept ?? "application/octet-stream",
        "User-Agent": "PiHub-UpdateEngine/1",
      });
      if (
        credentialsAllowed
        && options.allowToken === true
        && options.token
        && url.hostname.toLowerCase() === "api.github.com"
      ) {
        headers.set("Authorization", `Bearer ${options.token}`);
      }
      for (const name of headers.keys()) {
        if (CREDENTIAL_HEADER_NAMES.has(name.toLowerCase()) && name.toLowerCase() !== "authorization") {
          fail("token_rejected", "GitHub request credentials are invalid");
        }
      }

      const response = await awaitWithAbort(fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal,
        credentials: "omit",
        cache: "no-store",
      }), signal);
      if (!REDIRECT_STATUSES.has(response.status)) {
        return boundedResponse(response, maxBodyBytes, signal);
      }
      if (redirectCount >= maxRedirects) {
        await response.body?.cancel();
        fail("redirect_blocked", "GitHub release redirected too many times");
      }
      const location = response.headers.get("location");
      if (!location || CONTROL_CHARACTER_PATTERN.test(location)) {
        await response.body?.cancel();
        fail("redirect_blocked", "GitHub release redirect is invalid");
      }

      let nextUrl: URL;
      try {
        nextUrl = assertRedirectUrl(new URL(location, url), trust, trustedHop);
      } catch (error) {
        await response.body?.cancel();
        if (error instanceof ReleaseManifestError && error.code === "redirect_blocked") throw error;
        fail("redirect_blocked", "GitHub release redirect is not allowed");
      }
      await response.body?.cancel();
      if (nextUrl.origin !== url.origin) credentialsAllowed = false;
      trustedHop = trustedHop || RELEASE_CDN_HOSTS.has(nextUrl.hostname.toLowerCase());
      url = nextUrl;
    }
  } catch (error) {
    if (error instanceof ReleaseManifestError) throw error;
    if (signal.aborted) fail("timeout", "GitHub release request timed out");
    fail("network_failure", "GitHub release request failed");
  }
}

export async function fetchAndVerifyReleaseManifest(
  url: string | URL,
  trust: ReleaseTrust,
  options: Omit<GithubFetchOptions, "maxBodyBytes"> = {},
): Promise<VerifiedReleaseManifest> {
  const response = await fetchPinnedGithubResource(url, trust, {
    ...options,
    accept: "application/json",
    maxBodyBytes: MAX_RELEASE_MANIFEST_BYTES,
  });
  if (!response.ok) {
    await response.body?.cancel();
    fail("network_failure", "GitHub release manifest request failed");
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof ReleaseManifestError) throw error;
    fail("network_failure", "GitHub release manifest response failed");
  }
  return parseAndVerifyReleaseManifest(bytes, trust);
}
