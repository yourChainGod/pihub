import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { getActivePihubDevice } from "./pihub-auth-store";
import {
  isPihubCapability,
  PIHUB_CAPABILITIES,
  type PihubCapability,
} from "./pihub-auth-shared";

export const PIHUB_AUTH_SCHEME = "PiHub-HMAC-SHA256";
export const PIHUB_SIGNING_CONTEXT = "pihub-request-v3";
export const PIHUB_AUTH_TIMESTAMP_WINDOW_SECONDS = 120;
export const PIHUB_AUTHENTICATED_DEVICE_HEADER = "x-pihub-authenticated-device";
export const PIHUB_AUTHENTICATED_CAPABILITIES_HEADER = "x-pihub-authenticated-capabilities";
export const PIHUB_AUTHENTICATED_CONTENT_SHA256_HEADER = "x-pihub-authenticated-content-sha256";
export const PIHUB_CONTENT_SHA256_HEADER = "x-pihub-content-sha256";
export const PIHUB_EMPTY_CONTENT_SHA256 = createHash("sha256").update("").digest("hex");
export const PIHUB_MAX_SIGNED_JSON_BYTES = 10 * 1024 * 1024;

const MAX_NONCES_PER_DEVICE = 256;
const MAX_NONCE_DEVICE_BUCKETS = 256;
const PAIRING_CLAIM_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAIRING_CLAIMS_PER_CODE_WINDOW = 8;
const MAX_GLOBAL_PAIRING_CLAIMS_PER_WINDOW = 300;
const MAX_PAIRING_CLAIM_BUCKETS = 256;

const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{22}$/;
const DEVICE_SECRET_PATTERN = /^pihub_key_[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,86}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const AUTH_EPOCH_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CONTENT_SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface ParsedAuthorization {
  deviceId: string;
  timestamp: number;
  nonce: string;
  epoch: string;
  signature: string;
}

interface PihubAuthRuntime {
  epoch: string;
  nonceBuckets: Map<string, Map<string, number>>;
  pairingClaimBuckets: Map<string, number[]>;
  globalPairingClaimAttempts: number[];
}

declare global {
  var __pihubAuthRuntimeV1: PihubAuthRuntime | undefined;
}

function runtime(): PihubAuthRuntime {
  if (!globalThis.__pihubAuthRuntimeV1) {
    globalThis.__pihubAuthRuntimeV1 = {
      epoch: randomBytes(16).toString("base64url"),
      nonceBuckets: new Map(),
      pairingClaimBuckets: new Map(),
      globalPairingClaimAttempts: [],
    };
  }
  return globalThis.__pihubAuthRuntimeV1;
}

function canonicalPathname(pathname: string): string {
  return pathname.split("/").map((segment) => {
    const decoded = decodeURIComponent(segment);
    return encodeURIComponent(decoded).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
  }).join("/");
}

export function canonicalizePihubRequestTarget(input: string | URL): string {
  const url = input instanceof URL
    ? new URL(input.href)
    : new URL(input, "http://pihub.invalid");
  if (url.username || url.password || url.hash) {
    throw new Error("Invalid authenticated request target");
  }

  const pathname = canonicalPathname(url.pathname || "/");
  url.searchParams.sort();
  const query = url.searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function buildPihubSigningPayload(input: {
  method: string;
  url: string | URL;
  deviceId: string;
  timestamp: number;
  nonce: string;
  epoch?: string;
  contentSha256?: string;
}): string {
  if (!DEVICE_ID_PATTERN.test(input.deviceId)) throw new Error("Invalid device identifier");
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new Error("Invalid authentication timestamp");
  }
  if (!NONCE_PATTERN.test(input.nonce)) throw new Error("Invalid authentication nonce");
  const epoch = input.epoch ?? getPihubAuthEpoch();
  if (!AUTH_EPOCH_PATTERN.test(epoch)) throw new Error("Invalid authentication epoch");
  const method = input.method.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new Error("Invalid HTTP method");
  const contentSha256 = input.contentSha256
    ?? PIHUB_EMPTY_CONTENT_SHA256;
  if (!CONTENT_SHA256_PATTERN.test(contentSha256)) {
    throw new Error("Invalid content digest");
  }

  return [
    "pihub-request-v3",
    method,
    canonicalizePihubRequestTarget(input.url),
    contentSha256,
    String(input.timestamp),
    input.nonce,
    epoch,
    input.deviceId,
  ].join("\n");
}

function signatureForPayload(secret: string, payload: string): string {
  if (!DEVICE_SECRET_PATTERN.test(secret)) throw new Error("Invalid device secret");
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function createPihubAuthorization(input: {
  method: string;
  url: string | URL;
  deviceId: string;
  secret: string;
  timestamp?: number;
  nonce?: string;
  epoch?: string;
  contentSha256?: string;
}): string {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomBytes(18).toString("base64url");
  const payload = buildPihubSigningPayload({
    method: input.method,
    url: input.url,
    deviceId: input.deviceId,
    timestamp,
    nonce,
    epoch: input.epoch,
    contentSha256: input.contentSha256,
  });
  const signature = signatureForPayload(input.secret, payload);
  const epoch = input.epoch ?? getPihubAuthEpoch();
  return `${PIHUB_AUTH_SCHEME} ${input.deviceId}:${timestamp}:${nonce}:${epoch}:${signature}`;
}

function parseAuthorization(value: string | null): ParsedAuthorization | null {
  if (!value) return null;
  const match = new RegExp(
    `^${PIHUB_AUTH_SCHEME} (dev_[A-Za-z0-9_-]{22}):([0-9]{1,13}):([A-Za-z0-9_-]{22,86}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{43})$`,
  ).exec(value);
  if (!match) return null;
  const timestamp = Number(match[2]);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || String(timestamp) !== match[2]) return null;
  return {
    deviceId: match[1],
    timestamp,
    nonce: match[3],
    epoch: match[4],
    signature: match[5],
  };
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!SIGNATURE_PATTERN.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

function signaturesEqual(actual: string, expected: string): boolean {
  const actualBytes = decodeCanonicalBase64Url(actual);
  const expectedBytes = decodeCanonicalBase64Url(expected);
  if (!actualBytes || !expectedBytes || actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

export function isPublicPihubApiRequest(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return (normalizedMethod === "GET" && pathname === "/api/health")
    || (normalizedMethod === "POST" && pathname === "/api/pairing/claim");
}

interface ProtectedApiPolicyRule {
  pattern: RegExp;
  methods: Partial<Record<string, PihubCapability>>;
}

const PROTECTED_API_POLICY: readonly ProtectedApiPolicyRule[] = [
  { pattern: /^\/api\/agent(?:\/|$)/, methods: { GET: "agents:use", POST: "agents:use" } },
  {
    pattern: /^\/api\/sessions(?:\/|$)/,
    methods: {
      GET: "sessions:read",
      POST: "sessions:write",
      PATCH: "sessions:write",
      DELETE: "sessions:write",
    },
  },
  { pattern: /^\/api\/files(?:\/|$)/, methods: { GET: "files:read", POST: "files:write" } },
  { pattern: /^\/api\/pihub\/files$/, methods: { POST: "files:write" } },
  { pattern: /^\/api\/file-index$/, methods: { GET: "files:read" } },
  { pattern: /^\/api\/cwd\/browse$/, methods: { GET: "workspaces:read" } },
  { pattern: /^\/api\/cwd\/validate$/, methods: { POST: "workspaces:manage" } },
  { pattern: /^\/api\/default-cwd$/, methods: { POST: "workspaces:manage" } },
  { pattern: /^\/api\/home$/, methods: { GET: "workspaces:read" } },
  { pattern: /^\/api\/git\/(?:diff|status)$/, methods: { GET: "workspaces:read" } },
  {
    pattern: /^\/api\/project-trust$/,
    methods: { GET: "workspaces:read", POST: "workspaces:manage" },
  },
  {
    pattern: /^\/api\/worktrees$/,
    methods: { GET: "workspaces:read", POST: "workspaces:manage", DELETE: "workspaces:manage" },
  },
  { pattern: /^\/api\/models$/, methods: { GET: "models:read" } },
  {
    pattern: /^\/api\/models-config$/,
    methods: { GET: "models:read", PUT: "models:manage" },
  },
  { pattern: /^\/api\/models-config\/catalog$/, methods: { GET: "models:read" } },
  {
    pattern: /^\/api\/models-config\/(?:discover|test)$/,
    methods: { POST: "models:manage" },
  },
  {
    pattern: /^\/api\/pihub\/newapi$/,
    methods: { GET: "models:read", POST: "models:manage" },
  },
  { pattern: /^\/api\/auth(?:\/|$)/, methods: { GET: "providers:manage", POST: "providers:manage", DELETE: "providers:manage" } },
  { pattern: /^\/api\/plugins$/, methods: { GET: "packages:read", POST: "packages:manage" } },
  {
    pattern: /^\/api\/skills$/,
    methods: { GET: "packages:read", PATCH: "packages:manage" },
  },
  { pattern: /^\/api\/skills\/(?:check|search)$/, methods: { POST: "packages:read" } },
  { pattern: /^\/api\/skills\/(?:install|update)$/, methods: { POST: "packages:manage" } },
  { pattern: /^\/api\/pihub\/terminal(?:\/|$)/, methods: { GET: "terminal:use", POST: "terminal:use" } },
  { pattern: /^\/api\/pihub\/setup$/, methods: { GET: "system:manage", POST: "system:manage" } },
  { pattern: /^\/api\/pihub\/updates$/, methods: { GET: "system:update", POST: "system:update" } },
  { pattern: /^\/api\/app-update$/, methods: { GET: "system:update" } },
  {
    pattern: /^\/api\/pairing$/,
    methods: {
      GET: "devices:manage",
      POST: "devices:manage",
      PATCH: "devices:manage",
      DELETE: "devices:manage",
    },
  },
];

export type PihubApiPolicy =
  | { access: "public" }
  | { access: "protected"; capability: PihubCapability };

export function resolvePihubApiPolicy(method: string, pathname: string): PihubApiPolicy | null {
  const normalizedMethod = method.toUpperCase();
  if (isPublicPihubApiRequest(normalizedMethod, pathname)) return { access: "public" };
  const matches = PROTECTED_API_POLICY.flatMap((rule) => {
    const capability = rule.pattern.test(pathname) ? rule.methods[normalizedMethod] : undefined;
    return capability ? [capability] : [];
  });
  return matches.length === 1
    ? { access: "protected", capability: matches[0] }
    : null;
}

function registerNonce(deviceId: string, nonce: string, expiresAt: number, now: number): boolean {
  const authRuntime = runtime();
  let bucket = authRuntime.nonceBuckets.get(deviceId);
  if (!bucket) {
    while (authRuntime.nonceBuckets.size >= MAX_NONCE_DEVICE_BUCKETS) {
      const oldestDeviceId = authRuntime.nonceBuckets.keys().next().value as string | undefined;
      if (!oldestDeviceId) break;
      authRuntime.nonceBuckets.delete(oldestDeviceId);
    }
    bucket = new Map();
    authRuntime.nonceBuckets.set(deviceId, bucket);
  } else {
    authRuntime.nonceBuckets.delete(deviceId);
    authRuntime.nonceBuckets.set(deviceId, bucket);
  }

  for (const [storedNonce, storedExpiry] of bucket) {
    if (storedExpiry < now) bucket.delete(storedNonce);
  }
  if (bucket.has(nonce)) return false;
  while (bucket.size >= MAX_NONCES_PER_DEVICE) {
    const oldestNonce = bucket.keys().next().value as string | undefined;
    if (!oldestNonce) break;
    bucket.delete(oldestNonce);
  }
  bucket.set(nonce, expiresAt);
  return true;
}

export type PihubApiAuthenticationResult =
  | { status: "public" }
  | {
    status: "authenticated";
    deviceId: string;
    capabilities: PihubCapability[];
    expectedContentSha256: string;
  }
  | { status: "unauthorized" }
  | { status: "forbidden" }
  | { status: "payload_too_large" }
  | { status: "unavailable" };

export interface TrustedPihubRequestContext {
  deviceId: string;
  capabilities: PihubCapability[];
  expectedContentSha256?: string;
}

export function getPihubAuthEpoch(): string {
  return runtime().epoch;
}

export function getPihubAuthenticationMetadata(now = Date.now()) {
  return {
    scheme: PIHUB_AUTH_SCHEME,
    signingContext: PIHUB_SIGNING_CONTEXT,
    epoch: getPihubAuthEpoch(),
    serverTimeUnixSeconds: Math.floor(now / 1000),
    timestampWindowSeconds: PIHUB_AUTH_TIMESTAMP_WINDOW_SECONDS,
  } as const;
}

/**
 * Read identity metadata inserted by proxy.ts after HMAC verification. Route
 * handlers must use this helper instead of authenticating again because the
 * proxy has already consumed the request nonce.
 */
export function getTrustedPihubRequestContext(
  request: Request,
): TrustedPihubRequestContext | null {
  const deviceId = request.headers.get(PIHUB_AUTHENTICATED_DEVICE_HEADER);
  const rawCapabilities = request.headers.get(PIHUB_AUTHENTICATED_CAPABILITIES_HEADER);
  const expectedContentSha256 = request.headers.get(PIHUB_AUTHENTICATED_CONTENT_SHA256_HEADER);
  if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId) || !rawCapabilities) return null;
  if (expectedContentSha256 !== null && !CONTENT_SHA256_PATTERN.test(expectedContentSha256)) {
    return null;
  }

  const capabilities = rawCapabilities.split(",");
  if (
    capabilities.length === 0
    || capabilities.length > PIHUB_CAPABILITIES.length
    || new Set(capabilities).size !== capabilities.length
    || !capabilities.every(isPihubCapability)
  ) {
    return null;
  }
  return {
    deviceId,
    capabilities,
    ...(expectedContentSha256 ? { expectedContentSha256 } : {}),
  };
}

function contentDigestForSignature(request: Request, method: string): string | null {
  if (method === "GET" || method === "HEAD") return PIHUB_EMPTY_CONTENT_SHA256;
  const supplied = request.headers.get(PIHUB_CONTENT_SHA256_HEADER);
  if (supplied === null) return null;
  return CONTENT_SHA256_PATTERN.test(supplied) ? supplied : null;
}

export function isStreamingPihubMultipartUpload(
  request: Request,
  url = new URL(request.url),
): boolean {
  if (request.method.toUpperCase() !== "POST" || !url.pathname.startsWith("/api/files/")) {
    return false;
  }
  const uploadTypes = url.searchParams.getAll("type");
  if (uploadTypes.length !== 1 || uploadTypes[0] !== "upload") return false;
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "multipart/form-data";
}

async function hashRequestBodyWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<{ digest: string } | { tooLarge: true }> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return { tooLarge: true };
  }

  const reader = request.clone().body?.getReader();
  if (!reader) return { digest: PIHUB_EMPTY_CONTENT_SHA256 };
  const hash = createHash("sha256");
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { digest: hash.digest("hex") };
}

function contentDigestsEqual(actual: string, expected: string): boolean {
  if (!CONTENT_SHA256_PATTERN.test(actual) || !CONTENT_SHA256_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function sha256PihubContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function authenticatePihubApiRequest(
  request: Request,
  options: { statePath?: string; now?: number } = {},
): Promise<PihubApiAuthenticationResult> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { status: "unauthorized" };
  }
  const method = request.method.toUpperCase();
  if (isPublicPihubApiRequest(method, url.pathname)) return { status: "public" };

  const authorization = parseAuthorization(request.headers.get("authorization"));
  if (!authorization) return { status: "unauthorized" };
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - authorization.timestamp) > PIHUB_AUTH_TIMESTAMP_WINDOW_SECONDS) {
    return { status: "unauthorized" };
  }
  if (authorization.epoch !== getPihubAuthEpoch()) return { status: "unauthorized" };
  const contentSha256 = contentDigestForSignature(request, method);
  if (!contentSha256) return { status: "unauthorized" };

  try {
    const device = getActivePihubDevice(authorization.deviceId, { statePath: options.statePath });
    if (!device) return { status: "unauthorized" };
    const payload = buildPihubSigningPayload({
      method,
      url,
      deviceId: authorization.deviceId,
      timestamp: authorization.timestamp,
      nonce: authorization.nonce,
      epoch: authorization.epoch,
      contentSha256,
    });
    const expected = signatureForPayload(device.secret, payload);
    if (!signaturesEqual(authorization.signature, expected)) return { status: "unauthorized" };

    const policy = resolvePihubApiPolicy(method, url.pathname);
    if (!policy || policy.access !== "protected" || !device.capabilities.includes(policy.capability)) {
      return { status: "forbidden" };
    }
    if (!isStreamingPihubMultipartUpload(request, url)) {
      const hashed = await hashRequestBodyWithinLimit(request, PIHUB_MAX_SIGNED_JSON_BYTES);
      if ("tooLarge" in hashed) return { status: "payload_too_large" };
      if (!contentDigestsEqual(hashed.digest, contentSha256)) return { status: "unauthorized" };
    }

    const replayExpiresAt = authorization.timestamp + PIHUB_AUTH_TIMESTAMP_WINDOW_SECONDS + 1;
    if (!registerNonce(authorization.deviceId, authorization.nonce, replayExpiresAt, now)) {
      return { status: "unauthorized" };
    }
    return {
      status: "authenticated",
      deviceId: device.id,
      capabilities: [...device.capabilities],
      expectedContentSha256: contentSha256,
    };
  } catch {
    return { status: "unavailable" };
  }
}

export function consumePihubPairingClaimAttempt(
  claim: unknown,
  now = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const authRuntime = runtime();
  authRuntime.globalPairingClaimAttempts = authRuntime.globalPairingClaimAttempts
    .filter((attempt) => attempt > now - PAIRING_CLAIM_WINDOW_MS);
  if (authRuntime.globalPairingClaimAttempts.length >= MAX_GLOBAL_PAIRING_CLAIMS_PER_WINDOW) {
    const oldest = authRuntime.globalPairingClaimAttempts[0] ?? now;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + PAIRING_CLAIM_WINDOW_MS - now) / 1000)),
    };
  }

  const bucketId = sha256PihubContent(typeof claim === "string" ? claim : "invalid-claim");
  let bucket = authRuntime.pairingClaimBuckets.get(bucketId) ?? [];
  bucket = bucket.filter((attempt) => attempt > now - PAIRING_CLAIM_WINDOW_MS);
  if (bucket.length >= MAX_PAIRING_CLAIMS_PER_CODE_WINDOW) {
    const oldest = bucket[0] ?? now;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + PAIRING_CLAIM_WINDOW_MS - now) / 1000)),
    };
  }

  authRuntime.pairingClaimBuckets.delete(bucketId);
  while (authRuntime.pairingClaimBuckets.size >= MAX_PAIRING_CLAIM_BUCKETS) {
    const oldestBucketId = authRuntime.pairingClaimBuckets.keys().next().value as string | undefined;
    if (!oldestBucketId) break;
    authRuntime.pairingClaimBuckets.delete(oldestBucketId);
  }
  bucket.push(now);
  authRuntime.pairingClaimBuckets.set(bucketId, bucket);
  authRuntime.globalPairingClaimAttempts.push(now);
  return { allowed: true };
}

export function resetPihubAuthRuntimeForTests(): void {
  globalThis.__pihubAuthRuntimeV1 = undefined;
}
