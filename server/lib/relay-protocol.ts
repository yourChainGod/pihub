/**
 * PiHub relay protocol v1 — the single source of truth shared by the Node
 * connector (server side) and the Rust desktop transport. The Rust side
 * verifies itself against RELAY_PROTOCOL_TEST_VECTORS.
 *
 * Subjects (see scripts/relay/README.zh-CN.md):
 *   node.<id>.request            request/reply envelope
 *   node.<id>.stream.open|close  stream lifecycle
 *   node.<id>.events.<streamId>  binary stream frames + stream-end
 *   node.<id>.xfer.<xferId>      chunked bulk transfer, either direction
 *
 * All control messages are JSON. Bulk data is binary frames with an 8-byte
 * header (uint32BE sequence + uint32BE length). The relay only transports
 * bytes; PiHub HMAC request signing stays end-to-end.
 */

export const RELAY_PROTOCOL_VERSION = 1;
/** Responses up to this size travel inline in the reply envelope. */
export const RELAY_INLINE_LIMIT = 768 * 1024;
/** Bulk frames carry at most this much payload. */
export const RELAY_XFER_CHUNK = 1024 * 1024;
export const RELAY_REQUEST_TIMEOUT_MS = 30_000;
/** An unreferenced inbound transfer is discarded after this long. */
export const RELAY_XFER_IDLE_TIMEOUT_MS = 5 * 60_000;

const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE = 8 * 1024;
const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type RelayHeaders = Record<string, string>;

export interface RelayRequest {
  v: number;
  kind: "req";
  id: string;
  method: string;
  path: string;
  headers: RelayHeaders;
  body?: string;   // base64
  xfer?: string;   // body arrives as chunks on this xfer id instead
}

export interface RelayResponse {
  v: number;
  kind: "res";
  id: string;
  status: number;
  headers: RelayHeaders;
  body?: string;   // base64
  xfer?: string;   // body available as chunks on this xfer id
  error?: string;
}

export interface XferOpen {
  v: number;
  kind: "xfer-open";
  xferId: string;
  size?: number;
  sha256: string;
}

export interface XferClose {
  v: number;
  kind: "xfer-close";
  xferId: string;
  ok: boolean;
  error?: string;
}

export interface StreamOpen {
  v: number;
  kind: "stream-open";
  streamId: string;
  path: string;
  headers: RelayHeaders;
}

export interface StreamClose {
  v: number;
  kind: "stream-close";
  streamId: string;
}

export interface StreamEnd {
  v: number;
  kind: "stream-end";
  streamId: string;
  error?: string;
}

export class RelayProtocolError extends Error {}

function fail(message: string): never {
  throw new RelayProtocolError(message);
}

function decodeMessage<T>(data: Uint8Array, expectedKind: string): T {
  if (data.length > MAX_CONTROL_BYTES) fail(`control message exceeds ${MAX_CONTROL_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    fail("control message is not valid JSON");
  }
  const value = parsed as Record<string, unknown>;
  if (value?.v !== RELAY_PROTOCOL_VERSION) fail("unsupported protocol version");
  if (value.kind !== expectedKind) fail(`expected ${expectedKind}, got ${String(value.kind)}`);
  return value as T;
}

function encodeMessage(value: Record<string, unknown>): Uint8Array {
  const data = new TextEncoder().encode(JSON.stringify(value));
  if (data.length > MAX_CONTROL_BYTES) fail(`control message exceeds ${MAX_CONTROL_BYTES} bytes`);
  return data;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value) && value.length <= MAX_ID_LENGTH;
}

function validHeaders(value: unknown): value is RelayHeaders {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_HEADER_COUNT) return false;
  return entries.every(([name, headerValue]) => (
    /^[A-Za-z0-9-]{1,64}$/.test(name)
    && typeof headerValue === "string"
    && headerValue.length <= MAX_HEADER_VALUE
    && !/[\x00-\x1f]/.test(headerValue)
  ));
}

function validPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 8 * 1024
    && value.startsWith("/api/")
    && !/[\x00-\x1f]/.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function newRelayId(): string {
  // 16 random bytes as base64url; short, URL- and subject-safe.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

// ── request / reply ──────────────────────────────────────────────────────────

export function encodeRequest(request: RelayRequest): Uint8Array {
  return encodeMessage(request as unknown as Record<string, unknown>);
}

export function decodeRequest(data: Uint8Array): RelayRequest {
  const value = decodeMessage<RelayRequest>(data, "req");
  if (!validId(value.id)) fail("invalid request id");
  if (!ALLOWED_METHODS.has(value.method)) fail("invalid method");
  if (!validPath(value.path)) fail("invalid path");
  if (!validHeaders(value.headers)) fail("invalid headers");
  if (value.body !== undefined && typeof value.body !== "string") fail("invalid body");
  if (value.xfer !== undefined && !validId(value.xfer)) fail("invalid xfer id");
  if (value.body !== undefined && value.xfer !== undefined) fail("body and xfer are exclusive");
  return value;
}

export function encodeResponse(response: RelayResponse): Uint8Array {
  return encodeMessage(response as unknown as Record<string, unknown>);
}

export function decodeResponse(data: Uint8Array): RelayResponse {
  const value = decodeMessage<RelayResponse>(data, "res");
  if (!validId(value.id)) fail("invalid response id");
  if (!Number.isSafeInteger(value.status) || value.status < 100 || value.status > 599) fail("invalid status");
  if (!validHeaders(value.headers)) fail("invalid headers");
  if (value.body !== undefined && typeof value.body !== "string") fail("invalid body");
  if (value.xfer !== undefined && !validId(value.xfer)) fail("invalid xfer id");
  if (value.error !== undefined && typeof value.error !== "string") fail("invalid error");
  return value;
}

// ── streams ─────────────────────────────────────────────────────────────────

export function encodeStreamOpen(message: StreamOpen): Uint8Array {
  return encodeMessage(message as unknown as Record<string, unknown>);
}

export function decodeStreamOpen(data: Uint8Array): StreamOpen {
  const value = decodeMessage<StreamOpen>(data, "stream-open");
  if (!validId(value.streamId)) fail("invalid stream id");
  if (!validPath(value.path)) fail("invalid path");
  if (!validHeaders(value.headers)) fail("invalid headers");
  return value;
}

export function encodeStreamClose(message: StreamClose): Uint8Array {
  return encodeMessage(message as unknown as Record<string, unknown>);
}

export function decodeStreamClose(data: Uint8Array): StreamClose {
  const value = decodeMessage<StreamClose>(data, "stream-close");
  if (!validId(value.streamId)) fail("invalid stream id");
  return value;
}

export function encodeStreamEnd(message: StreamEnd): Uint8Array {
  return encodeMessage(message as unknown as Record<string, unknown>);
}

export function decodeStreamEnd(data: Uint8Array): StreamEnd {
  const value = decodeMessage<StreamEnd>(data, "stream-end");
  if (!validId(value.streamId)) fail("invalid stream id");
  return value;
}

// ── bulk transfer ────────────────────────────────────────────────────────────

export function encodeXferOpen(message: XferOpen): Uint8Array {
  return encodeMessage(message as unknown as Record<string, unknown>);
}

export function decodeXferOpen(data: Uint8Array): XferOpen {
  const value = decodeMessage<XferOpen>(data, "xfer-open");
  if (!validId(value.xferId)) fail("invalid xfer id");
  if (!validDigest(value.sha256)) fail("invalid sha256");
  if (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0)) fail("invalid size");
  return value;
}

export function encodeXferClose(message: XferClose): Uint8Array {
  return encodeMessage(message as unknown as Record<string, unknown>);
}

export function decodeXferClose(data: Uint8Array): XferClose {
  const value = decodeMessage<XferClose>(data, "xfer-close");
  if (!validId(value.xferId)) fail("invalid xfer id");
  if (typeof value.ok !== "boolean") fail("invalid ok flag");
  return value;
}

export const FRAME_HEADER_BYTES = 8;

export function encodeFrame(sequence: number, payload: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail("invalid frame sequence");
  if (payload.length > RELAY_XFER_CHUNK) fail(`frame payload exceeds ${RELAY_XFER_CHUNK} bytes`);
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, sequence);
  view.setUint32(4, payload.length);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

export function decodeFrame(data: Uint8Array): { sequence: number; payload: Uint8Array } {
  if (data.length < FRAME_HEADER_BYTES) fail("frame is shorter than its header");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sequence = view.getUint32(0);
  const length = view.getUint32(4);
  if (length !== data.length - FRAME_HEADER_BYTES) fail("frame length mismatch");
  return { sequence, payload: data.subarray(FRAME_HEADER_BYTES) };
}

// ── subjects ─────────────────────────────────────────────────────────────────

const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validNodeId(value: unknown): value is string {
  return typeof value === "string" && NODE_ID_PATTERN.test(value);
}

export function requestSubject(nodeId: string): string {
  return `node.${nodeId}.request`;
}

export function streamOpenSubject(nodeId: string): string {
  return `node.${nodeId}.stream.open`;
}

export function streamCloseSubject(nodeId: string): string {
  return `node.${nodeId}.stream.close`;
}

export function eventsSubject(nodeId: string, streamId: string): string {
  return `node.${nodeId}.events.${streamId}`;
}

export function xferSubject(nodeId: string, xferId: string): string {
  return `node.${nodeId}.xfer.${xferId}`;
}

/** Wildcard subscriptions used by the desktop (frames arrive unsolicited). */
export function desktopEventsPattern(): string {
  return "node.*.events.>";
}

export function desktopXferPattern(): string {
  return "node.*.xfer.>";
}

// ── shared test vectors ──────────────────────────────────────────────────────
// The Rust desktop transport asserts the exact same encodings.

export const RELAY_PROTOCOL_TEST_VECTORS = Object.freeze({
  request: {
    json: { v: 1, kind: "req", id: "AbCdEfGh1234", method: "GET", path: "/api/sessions?limit=40", headers: { authorization: "PiHub-HMAC-SHA256 dev_x" } },
    encoded: "{\"v\":1,\"kind\":\"req\",\"id\":\"AbCdEfGh1234\",\"method\":\"GET\",\"path\":\"/api/sessions?limit=40\",\"headers\":{\"authorization\":\"PiHub-HMAC-SHA256 dev_x\"}}",
  },
  frame: {
    sequence: 7,
    payload: "pihub",
    encodedHex: "00000007000000057069687562",
  },
  subjects: {
    nodeId: "dgn-01",
    streamId: "stream-A1",
    xferId: "xfer-B2x4",
    request: "node.dgn-01.request",
    streamOpen: "node.dgn-01.stream.open",
    streamClose: "node.dgn-01.stream.close",
    events: "node.dgn-01.events.stream-A1",
    xfer: "node.dgn-01.xfer.xfer-B2x4",
  },
});
