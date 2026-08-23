import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const protocol = await jiti.import("./relay-protocol.ts");
const {
  RELAY_PROTOCOL_TEST_VECTORS: vectors,
  RELAY_XFER_CHUNK,
  encodeRequest, decodeRequest,
  encodeResponse, decodeResponse,
  encodeStreamOpen, decodeStreamOpen,
  encodeStreamClose, decodeStreamClose,
  encodeStreamEnd, decodeStreamEnd,
  encodeXferOpen, decodeXferOpen,
  encodeXferClose, decodeXferClose,
  encodeFrame, decodeFrame,
  requestSubject, streamOpenSubject, streamCloseSubject, eventsSubject, xferSubject,
  desktopEventsPattern, desktopXferPattern,
  newRelayId, validNodeId,
} = protocol;

const encode = (value) => new TextEncoder().encode(value);

test("request vector matches the shared encoding byte-for-byte", () => {
  const encoded = new TextDecoder().decode(encodeRequest(vectors.request.json));
  assert.equal(encoded, vectors.request.encoded);
  const decoded = decodeRequest(encode(vectors.request.encoded));
  assert.deepEqual(decoded, vectors.request.json);
});

test("frame vector matches the shared encoding byte-for-byte", () => {
  const frame = encodeFrame(vectors.frame.sequence, encode(vectors.frame.payload));
  assert.equal(Buffer.from(frame).toString("hex"), vectors.frame.encodedHex);
  const decoded = decodeFrame(frame);
  assert.equal(decoded.sequence, vectors.frame.sequence);
  assert.equal(Buffer.from(decoded.payload).toString(), vectors.frame.payload);
});

test("subject builders match the shared vector", () => {
  const { nodeId, streamId, xferId } = vectors.subjects;
  assert.equal(requestSubject(nodeId), vectors.subjects.request);
  assert.equal(streamOpenSubject(nodeId), vectors.subjects.streamOpen);
  assert.equal(streamCloseSubject(nodeId), vectors.subjects.streamClose);
  assert.equal(eventsSubject(nodeId, streamId), vectors.subjects.events);
  assert.equal(xferSubject(nodeId, xferId), vectors.subjects.xfer);
  assert.equal(desktopEventsPattern(), "node.*.events.>");
  assert.equal(desktopXferPattern(), "node.*.xfer.>");
});

test("request validation rejects malformed envelopes", () => {
  const base = vectors.request.json;
  const bad = (patch) => encode(JSON.stringify({ ...base, ...patch }));
  assert.throws(() => decodeRequest(bad({ v: 2 })), /version/);
  assert.throws(() => decodeRequest(bad({ kind: "res" })), /expected/);
  assert.throws(() => decodeRequest(bad({ id: "with space" })), /id/);
  assert.throws(() => decodeRequest(bad({ method: "CONNECT" })), /method/);
  assert.throws(() => decodeRequest(bad({ path: "/other" })), /path/);
  assert.throws(() => decodeRequest(bad({ path: "/api/x\x00" })), /path/);
  assert.throws(() => decodeRequest(bad({ headers: { "bad header": "x" } })), /headers/);
  assert.throws(() => decodeRequest(bad({ body: "eA==", xfer: "AbCdEfGh1234" })), /exclusive/);
  assert.throws(() => decodeRequest(encode("not json")), /JSON/);
});

test("response validation rejects malformed envelopes", () => {
  const base = { v: 1, kind: "res", id: "AbCdEfGh1234", status: 200, headers: {} };
  const bad = (patch) => encode(JSON.stringify({ ...base, ...patch }));
  assert.throws(() => decodeResponse(bad({ status: 99 })), /status/);
  assert.throws(() => decodeResponse(bad({ status: 600 })), /status/);
  assert.throws(() => decodeResponse(bad({ xfer: "bad id!" })), /xfer/);
  const ok = decodeResponse(encodeResponse(base));
  assert.equal(ok.status, 200);
});

test("stream and xfer control messages round-trip and validate", () => {
  const open = { v: 1, kind: "stream-open", streamId: "stream-A1", path: "/api/agent/s1/events", headers: { "last-event-id": "41" } };
  assert.deepEqual(decodeStreamOpen(encodeStreamOpen(open)), open);
  assert.throws(() => decodeStreamOpen(encode(JSON.stringify({ ...open, path: "/nope" }))), /path/);

  const close = { v: 1, kind: "stream-close", streamId: "stream-A1" };
  assert.deepEqual(decodeStreamClose(encodeStreamClose(close)), close);

  const end = { v: 1, kind: "stream-end", streamId: "stream-A1", error: "boom" };
  assert.deepEqual(decodeStreamEnd(encodeStreamEnd(end)), end);

  const digest = "0".repeat(64);
  const xopen = { v: 1, kind: "xfer-open", xferId: "xfer-B2x4", size: 42, sha256: digest };
  assert.deepEqual(decodeXferOpen(encodeXferOpen(xopen)), xopen);
  assert.throws(() => decodeXferOpen(encode(JSON.stringify({ ...xopen, sha256: "zz" }))), /sha256/);
  assert.throws(() => decodeXferOpen(encode(JSON.stringify({ ...xopen, size: -1 }))), /size/);

  const xclose = { v: 1, kind: "xfer-close", xferId: "xfer-B2x4", ok: true };
  assert.deepEqual(decodeXferClose(encodeXferClose(xclose)), xclose);
  assert.throws(() => decodeXferClose(encode(JSON.stringify({ ...xclose, ok: "yes" }))), /ok/);
});

test("frames enforce order metadata and the chunk bound", () => {
  assert.throws(() => encodeFrame(-1, new Uint8Array(0)), /sequence/);
  assert.throws(() => encodeFrame(0, new Uint8Array(RELAY_XFER_CHUNK + 1)), /exceeds/);
  const frame = encodeFrame(0, encode("x"));
  const truncated = frame.subarray(0, frame.length - 1);
  assert.throws(() => decodeFrame(truncated), /length mismatch/);
  assert.throws(() => decodeFrame(new Uint8Array(4)), /shorter/);
});

test("ids and node ids are strict", () => {
  assert.ok(validNodeId("dgn-01"));
  assert.ok(!validNodeId("Dgn-01"));
  assert.ok(!validNodeId("-bad"));
  assert.ok(!validNodeId("a b"));
  assert.ok(newRelayId() !== newRelayId());
  assert.match(newRelayId(), /^[A-Za-z0-9_-]{8,128}$/);
});
