import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

interface LookupAddress {
  address: string;
  family: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 2_048;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE_LENGTH = 16_384;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "forwarded",
  "host",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
]);
const SENSITIVE_RESPONSE_HEADER_NAMES = new Set([
  ...CREDENTIAL_HEADER_NAMES,
  "set-cookie",
  "set-cookie2",
  "www-authenticate",
]);

export type OutboundErrorCode =
  | "invalid_input"
  | "invalid_url"
  | "forbidden_target"
  | "dynamic_credential"
  | "redirect_blocked"
  | "request_too_large"
  | "response_too_large"
  | "timeout"
  | "upstream_failure"
  | "unsupported_transport"
  | "invalid_json";

export class OutboundRequestError extends Error {
  constructor(
    public readonly code: OutboundErrorCode,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "OutboundRequestError";
  }
}

export interface OutboundPolicy {
  /** Only permits Tailscale CGNAT/ULA addresses. Other private ranges stay blocked. */
  allowTailnet?: boolean;
  /** Explicit development-only exception for localhost and loopback literals. */
  allowLocalhost?: boolean;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Stop the setup deadline after final response headers; body idle/size limits remain active. */
  streamResponse?: boolean;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  maxRedirects?: number;
}

interface OutboundTestDependencies {
  resolver?: (hostname: string) => Promise<LookupAddress[]>;
  transport?: typeof globalThis.fetch;
}

interface InternalOutboundPolicy extends OutboundPolicy {
  /** Test-only dependency injection. Production callers must leave this unset. */
  __test?: OutboundTestDependencies;
}

export interface OutboundJsonResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  data?: unknown;
}

function fail(code: OutboundErrorCode, message: string, httpStatus: number): never {
  throw new OutboundRequestError(code, message, httpStatus);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return hostname.replace(/\.$/, "").toLowerCase();
}

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return parseIpv4(address)?.[0] === 127;
  if (family !== 6) return false;
  const bytes = parseIpv6(address);
  if (!bytes) return false;
  if (bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1) return true;
  return bytes.slice(0, 10).every((value) => value === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff
    && bytes[12] === 127;
}

function isExplicitLocalhost(url: URL): boolean {
  const hostname = normalizedHostname(url);
  return hostname === "localhost" || hostname.endsWith(".localhost") || isLoopbackAddress(hostname);
}

/** Parse and canonicalize an untrusted outbound URL without performing DNS. */
export function canonicalizeOutboundUrl(input: string | URL, policy: OutboundPolicy = {}): URL {
  const raw = input instanceof URL ? input.toString() : input;
  if (!raw || raw.length > MAX_URL_LENGTH || hasControlCharacters(raw)) {
    fail("invalid_url", "Outbound URL is invalid", 400);
  }
  if (raw.includes("#")) fail("invalid_url", "Outbound URL fragments are not allowed", 400);

  const candidate = /^[A-Za-z][A-Za-z\d+.-]*:/.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    fail("invalid_url", "Outbound URL is invalid", 400);
  }

  const localDevelopmentTarget = policy.allowLocalhost === true && isExplicitLocalhost(url);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (
    policy.allowTailnet === true || localDevelopmentTarget
  ))) {
    fail("invalid_url", "Outbound URLs must use HTTPS", 400);
  }
  if (url.username || url.password) fail("invalid_url", "Outbound URL userinfo is not allowed", 400);
  if (!url.hostname) fail("invalid_url", "Outbound URL hostname is required", 400);
  if (url.hostname.endsWith(".")) url.hostname = url.hostname.slice(0, -1);

  const hostname = normalizedHostname(url);
  if ((!localDevelopmentTarget && (hostname === "localhost" || hostname.endsWith(".localhost") || isLoopbackAddress(hostname)))
    || hostname === "metadata.google.internal") {
    fail("forbidden_target", "Outbound target is not allowed", 400);
  }
  return url;
}

function parseIpv4(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((part) => Number(part));
  return bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? bytes
    : undefined;
}

function parseIpv6(address: string): number[] | undefined {
  let value = address.toLowerCase().split("%")[0];
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = parseIpv4(value.slice(lastColon + 1));
    if (!ipv4) return undefined;
    value = `${value.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return undefined;
  return groups.flatMap((group) => {
    const number = Number.parseInt(group, 16);
    return [number >>> 8, number & 0xff];
  });
}

function bytesMatch(bytes: number[], prefix: number[], bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index++) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = 0xff << (8 - remaining);
  return (bytes[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

export type OutboundAddressClass = "public" | "tailnet" | "blocked";

/** Classifies literal and DNS-resolved addresses before a socket is opened. */
export function classifyOutboundAddress(address: string): OutboundAddressClass {
  const family = isIP(address);
  if (family === 4) {
    const bytes = parseIpv4(address)!;
    if (bytesMatch(bytes, [100, 64, 0, 0], 10)) return "tailnet";
    const blocked = [
      [[0, 0, 0, 0], 8],
      [[10, 0, 0, 0], 8],
      [[127, 0, 0, 0], 8],
      [[169, 254, 0, 0], 16],
      [[172, 16, 0, 0], 12],
      [[192, 0, 0, 0], 24],
      [[192, 0, 2, 0], 24],
      [[192, 88, 99, 0], 24],
      [[192, 168, 0, 0], 16],
      [[198, 18, 0, 0], 15],
      [[198, 51, 100, 0], 24],
      [[203, 0, 113, 0], 24],
      [[224, 0, 0, 0], 4],
      [[240, 0, 0, 0], 4],
    ] as const;
    return blocked.some(([prefix, bits]) => bytesMatch(bytes, [...prefix], bits)) ? "blocked" : "public";
  }

  if (family === 6) {
    const bytes = parseIpv6(address)!;
    const ipv4Mapped = bytesMatch(bytes, Array(12).fill(0), 80) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (ipv4Mapped) return classifyOutboundAddress(bytes.slice(12).join("."));
    if (bytesMatch(bytes, [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0], 48)) return "tailnet";

    const globalUnicast = (bytes[0] & 0xe0) === 0x20;
    const blockedGlobal = bytesMatch(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)
      || bytesMatch(bytes, [0x20, 0x01, 0x00, 0x00], 32)
      || bytesMatch(bytes, [0x20, 0x02], 16);
    return globalUnicast && !blockedGlobal ? "public" : "blocked";
  }
  return "blocked";
}

/** Validate a configured API base URL before it is persisted or expanded. */
export function canonicalizeOutboundBaseUrl(input: string | URL, policy: OutboundPolicy = {}): URL {
  const url = canonicalizeOutboundUrl(input, policy);
  if (url.search) fail("invalid_url", "Outbound base URL query parameters are not allowed", 400);
  const hostname = normalizedHostname(url);
  if (isIP(hostname)) {
    const kind = classifyOutboundAddress(hostname);
    const allowedLoopback = policy.allowLocalhost === true && isLoopbackAddress(hostname);
    if ((kind === "blocked" && !allowedLoopback) || (kind === "tailnet" && policy.allowTailnet !== true)) {
      fail("forbidden_target", "Outbound target is not allowed", 400);
    }
  }
  return url;
}

function abortError(): OutboundRequestError {
  return new OutboundRequestError("timeout", "Outbound request timed out", 504);
}

async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function resolveTarget(
  url: URL,
  policy: InternalOutboundPolicy,
  signal: AbortSignal,
): Promise<LookupAddress[]> {
  const hostname = normalizedHostname(url);
  const literalFamily = isIP(hostname);
  let addresses: LookupAddress[];
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await awaitWithSignal(
        (policy.__test?.resolver ?? ((host) => dnsLookup(host, { all: true, verbatim: true })))(hostname),
        signal,
      );
  } catch (error) {
    if (error instanceof OutboundRequestError) throw error;
    fail("upstream_failure", "Outbound hostname could not be resolved", 502);
  }
  if (addresses.length === 0) fail("upstream_failure", "Outbound hostname could not be resolved", 502);

  const classes = addresses.map((entry) => classifyOutboundAddress(entry.address));
  const localDevelopmentTarget = policy.allowLocalhost === true && isExplicitLocalhost(url);
  const allowed = localDevelopmentTarget
    ? addresses.every((entry) => isLoopbackAddress(entry.address))
    : classes.every((kind) => kind === "public" || (kind === "tailnet" && policy.allowTailnet === true));
  if (!allowed) fail("forbidden_target", "Outbound target resolves to a non-public address", 400);
  if (url.protocol === "http:" && !(
    classes.every((kind) => kind === "tailnet")
    || (localDevelopmentTarget && addresses.every((entry) => isLoopbackAddress(entry.address)))
  )) {
    fail("invalid_url", "Plain HTTP is only allowed for an explicitly enabled local target", 400);
  }
  return addresses;
}

export async function assertOutboundUrlAllowed(
  input: string | URL,
  policy: InternalOutboundPolicy = {},
): Promise<URL> {
  const url = canonicalizeOutboundUrl(input, policy);
  const signal = AbortSignal.timeout(policy.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  await resolveTarget(url, policy, signal);
  return url;
}

export function assertLiteralCredential(value: string, label = "credential"): string {
  const credential = value.trim();
  if (!credential || credential.length > MAX_HEADER_VALUE_LENGTH || hasControlCharacters(credential)) {
    fail("invalid_input", `${label} is invalid`, 400);
  }
  if (credential.startsWith("!") || /\$(?:[A-Za-z_][A-Za-z\d_]*|\{[A-Za-z_][A-Za-z\d_]*\})/.test(credential)) {
    fail("dynamic_credential", "Dynamic credential references are not allowed in API requests", 400);
  }
  return credential;
}

export function sanitizeOutboundHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_input", "Provider headers must be an object", 400);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_HEADER_COUNT) fail("invalid_input", "Too many provider headers", 400);

  const headers = new Headers();
  for (const [rawName, rawValue] of entries) {
    if (typeof rawValue !== "string") fail("invalid_input", "Provider header values must be strings", 400);
    const name = rawName.trim().toLowerCase();
    if (!name || FORBIDDEN_REQUEST_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith("x-forwarded-")) {
      fail("invalid_input", "Provider contains a forbidden header", 400);
    }
    if (rawValue.length > MAX_HEADER_VALUE_LENGTH || hasControlCharacters(rawValue)) {
      fail("invalid_input", "Provider contains an invalid header value", 400);
    }
    if (rawValue.startsWith("!") || /\$(?:[A-Za-z_][A-Za-z\d_]*|\{[A-Za-z_][A-Za-z\d_]*\})/.test(rawValue)) {
      fail("dynamic_credential", "Dynamic header references are not allowed in API requests", 400);
    }
    try {
      headers.set(name, rawValue);
    } catch {
      fail("invalid_input", "Provider contains an invalid header", 400);
    }
  }
  return Object.fromEntries(headers.entries());
}

function validatedHeaders(init: HeadersInit | undefined): Headers {
  let headers: Headers;
  try {
    headers = new Headers(init);
  } catch {
    fail("invalid_input", "Outbound request headers are invalid", 400);
  }
  if ([...headers].length > MAX_HEADER_COUNT) fail("invalid_input", "Too many outbound request headers", 400);
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("x-forwarded-")) {
      fail("invalid_input", "Outbound request contains a forbidden header", 400);
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH || hasControlCharacters(value)) {
      fail("invalid_input", "Outbound request contains an invalid header", 400);
    }
  }
  return headers;
}

function knownBodySize(body: BodyInit | null | undefined): number {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString());
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof Blob) return body.size;
  fail("invalid_input", "Streaming outbound request bodies are not supported", 400);
}

function pinnedLookup(addresses: LookupAddress[]) {
  return (hostname: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void) => {
    const requestedFamily = typeof options?.family === "number" && options.family !== 0 ? options.family : undefined;
    const matches = requestedFamily ? addresses.filter((entry) => entry.family === requestedFamily) : addresses;
    if (matches.length === 0) {
      const error = Object.assign(new Error("Pinned DNS family unavailable"), { code: "ENOTFOUND", hostname });
      callback(error);
      return;
    }
    if (options?.all) callback(null, matches.map((entry) => ({ ...entry })));
    else callback(null, matches[0].address, matches[0].family);
  };
}

function sanitizedResponseHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of SENSITIVE_RESPONSE_HEADER_NAMES) headers.delete(name);
  return headers;
}

function sanitizedResponseUrl(value: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function copyResponseMetadata(target: Response, source: Response): Response {
  for (const property of ["url", "redirected", "type"] as const) {
    const value = property === "url" ? sanitizedResponseUrl(source.url) : source[property];
    try { Object.defineProperty(target, property, { value }); } catch { /* optional metadata */ }
  }
  return target;
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(abortError()), idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function wrapBoundedResponse(
  response: Response,
  maxBytes: number,
  idleTimeoutMs: number,
  dispose: () => void,
): Response {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel();
    dispose();
    fail("response_too_large", "Upstream response exceeded the size limit", 502);
  }
  if (!response.body) {
    dispose();
    return copyResponseMetadata(new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizedResponseHeaders(response.headers),
    }), response);
  }

  const reader = response.body.getReader();
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await readWithIdleTimeout(reader, idleTimeoutMs);
        if (chunk.done) {
          controller.close();
          dispose();
          return;
        }
        received += chunk.value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          controller.error(new OutboundRequestError("response_too_large", "Upstream response exceeded the size limit", 502));
          dispose();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        void reader.cancel(error).catch(() => undefined);
        controller.error(error instanceof OutboundRequestError
          ? error
          : new OutboundRequestError("upstream_failure", "Upstream response failed", 502));
        dispose();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        dispose();
      }
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: sanitizedResponseHeaders(response.headers),
  });
  return copyResponseMetadata(wrapped, response);
}

/**
 * Fetch an untrusted destination with DNS pinning and per-hop redirect checks.
 * The returned body always has size and idle limits. Streaming mode releases
 * the setup deadline after final headers so active inference streams can run long.
 */
export async function secureOutboundFetch(
  input: string | URL,
  init: RequestInit = {},
  policy: InternalOutboundPolicy = {},
): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectTimeoutMs = policy.connectTimeoutMs ?? Math.min(timeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
  const headersTimeoutMs = policy.headersTimeoutMs ?? timeoutMs;
  const idleTimeoutMs = policy.idleTimeoutMs ?? timeoutMs;
  const maxResponseBytes = policy.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRequestBytes = policy.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if ([timeoutMs, connectTimeoutMs, headersTimeoutMs, idleTimeoutMs, maxResponseBytes, maxRequestBytes]
    .some((value) => !Number.isFinite(value) || value <= 0)
    || !Number.isSafeInteger(maxRedirects)
    || maxRedirects < 0
    || maxRedirects > 10) {
    fail("invalid_input", "Outbound request policy is invalid", 500);
  }

  let url = canonicalizeOutboundUrl(input, policy);
  let method = (init.method ?? "GET").toUpperCase();
  if (method === "CONNECT" || method === "TRACE") fail("invalid_input", "Outbound request method is not allowed", 400);
  const headers = validatedHeaders(init.headers);
  let body = init.body;
  if (knownBodySize(body) > maxRequestBytes) fail("request_too_large", "Outbound request exceeded the size limit", 413);

  const timeoutController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => timeoutController.abort(), timeoutMs);
  const clearDeadline = () => {
    if (!timeout) return;
    clearTimeout(timeout);
    timeout = undefined;
  };
  const timeoutSignal = timeoutController.signal;
  const signal = init.signal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      const addresses = await resolveTarget(url, policy, signal);
      let dispose = () => undefined;
      let response: Response;

      if (policy.__test?.transport) {
        response = await policy.__test.transport(url, { ...init, method, body, headers, redirect: "manual", signal });
      } else {
        let disposed = false;
        const dispatcher = new Agent({
          connect: { lookup: pinnedLookup(addresses) as never, timeout: connectTimeoutMs },
          maxOrigins: 1,
          connections: 1,
          pipelining: 1,
          maxResponseSize: maxResponseBytes,
          headersTimeout: headersTimeoutMs,
          bodyTimeout: idleTimeoutMs,
        });
        dispose = () => {
          if (disposed) return;
          disposed = true;
          signal.removeEventListener("abort", dispose);
          void dispatcher.close().catch(() => dispatcher.destroy());
        };
        signal.addEventListener("abort", dispose, { once: true });
        try {
          response = await undiciFetch(url, {
            method,
            body: body as never,
            headers,
            redirect: "manual",
            signal,
            dispatcher,
          }) as unknown as Response;
        } catch (error) {
          dispose();
          throw error;
        }
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        if (policy.streamResponse === true) clearDeadline();
        return wrapBoundedResponse(response, maxResponseBytes, idleTimeoutMs, () => {
          clearDeadline();
          dispose();
        });
      }
      if (redirectCount >= maxRedirects) {
        void response.body?.cancel();
        dispose();
        fail("redirect_blocked", "Upstream redirected too many times", 502);
      }
      const location = response.headers.get("location");
      if (!location || hasControlCharacters(location)) {
        void response.body?.cancel();
        dispose();
        fail("redirect_blocked", "Upstream returned an invalid redirect", 502);
      }

      let nextUrl: URL;
      try {
        nextUrl = canonicalizeOutboundUrl(new URL(location, url), policy);
      } catch (error) {
        void response.body?.cancel();
        dispose();
        throw error;
      }
      if (nextUrl.origin !== url.origin) {
        void response.body?.cancel();
        dispose();
        fail("redirect_blocked", "Cross-origin redirects are not allowed", 502);
      }
      if (body !== undefined && body !== null && response.status !== 307 && response.status !== 308) {
        void response.body?.cancel();
        dispose();
        fail("redirect_blocked", "Method-changing redirects are not allowed", 502);
      }

      await response.body?.cancel();
      dispose();
      url = nextUrl;
      if (response.status === 303) {
        method = "GET";
        body = null;
      }
    }
  } catch (error) {
    clearDeadline();
    if (error instanceof OutboundRequestError) throw error;
    if (signal.aborted) throw abortError();
    fail("upstream_failure", "Outbound request failed", 502);
  }
}

export function createSecureOutboundFetch(policy: OutboundPolicy = {}): typeof globalThis.fetch {
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    if (input instanceof Request) {
      if (input.body && !init?.body) {
        return Promise.reject(new OutboundRequestError("invalid_input", "Streaming Request objects are not supported", 400));
      }
      return secureOutboundFetch(input.url, {
        method: init?.method ?? input.method,
        headers: init?.headers ?? input.headers,
        body: init?.body,
        signal: init?.signal ?? input.signal,
      }, policy);
    }
    return secureOutboundFetch(input instanceof URL ? input : String(input), init, policy);
  }) as typeof globalThis.fetch;
}

export async function fetchOutboundJson(
  input: string | URL,
  init: RequestInit = {},
  policy: InternalOutboundPolicy = {},
): Promise<OutboundJsonResponse> {
  const response = await secureOutboundFetch(input, init, policy);
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, status: response.status, headers: response.headers };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (error instanceof OutboundRequestError) throw error;
    fail("upstream_failure", "Upstream response failed", 502);
  }
  try {
    return { ok: true, status: response.status, headers: response.headers, data: JSON.parse(text) };
  } catch {
    fail("invalid_json", "Upstream response was not valid JSON", 502);
  }
}

export async function readBoundedJsonRequest(request: Request, maxBytes = 256 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    fail("request_too_large", "Request body exceeded the size limit", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) fail("invalid_input", "JSON request body is required", 400);
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      fail("request_too_large", "Request body exceeded the size limit", 413);
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("invalid_input", "Request body must be valid JSON", 400);
  }
}

export function outboundErrorResponse(error: unknown): { error: string; status: number } {
  if (error instanceof OutboundRequestError) return { error: error.message, status: error.httpStatus };
  return { error: "Outbound request failed", status: 502 };
}

export function redactSensitiveText(value: string, secrets: Array<string | undefined>): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}
