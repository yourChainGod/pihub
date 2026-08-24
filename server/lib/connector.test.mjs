import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { createConnector, loadConnectorConfig } = await jiti.import("./connector.ts");
const protocol = await jiti.import("./relay-protocol.ts");

const enc = (value) => new TextEncoder().encode(JSON.stringify(value));
const dec = (data) => JSON.parse(new TextDecoder().decode(data));

function fakeNats() {
  const subs = [];
  const published = [];
  const match = (pattern, subject) => {
    if (pattern.endsWith(">")) return subject.startsWith(pattern.slice(0, -1));
    return pattern === subject;
  };
  const dispatch = (subject, data, reply) => {
    for (const sub of subs) if (match(sub.subject, subject)) sub.callback(null, { subject, data, reply });
  };
  const connection = {
    subscribe(subject, { callback }) {
      const sub = { subject, callback };
      subs.push(sub);
      return { unsubscribe: () => subs.splice(subs.indexOf(sub), 1) };
    },
    publish(subject, data, options) {
      published.push({ subject, data, reply: options?.reply });
      dispatch(subject, data);
    },
    status: () => (async function* () { /* idle forever */ })(),
    close: async () => undefined,
  };
  return { connection, published, emit: dispatch };
}

function testConfig() {
  return { relayUrl: "wss://relay.example.invalid", nodeId: "test-node", user: "node-test-node", token: "t".repeat(43) };
}

function silentLogger() {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

async function withLocalServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("inline request/reply round-trips through the loopback server", async (t) => {
  let seen = null;
  const localBase = await withLocalServer(t, (req, res) => {
    seen = { host: req.headers.host, origin: req.headers.origin, authorization: req.headers.authorization };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const nats = fakeNats();
  const connector = await createConnector({
    config: testConfig(), localBase, connect: async () => nats.connection, logger: silentLogger(),
  });
  t.after(() => connector.close());

  const request = {
    v: 1, kind: "req", id: "req-0001-abcd", method: "GET",
    path: "/api/sessions?limit=40", headers: { authorization: "PiHub-HMAC-SHA256 sig", origin: "https://evil.example" },
  };
  nats.emit("node.test-node.request", enc(request), "reply.inbox.1");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const reply = nats.published.find((entry) => entry.subject === "reply.inbox.1");
  assert.ok(reply, "reply published");
  const envelope = dec(reply.data);
  assert.equal(envelope.kind, "res");
  assert.equal(envelope.id, "req-0001-abcd");
  assert.equal(envelope.status, 200);
  const body = JSON.parse(Buffer.from(envelope.body, "base64").toString());
  assert.deepEqual(body, { ok: true, path: "/api/sessions?limit=40" });
  assert.deepEqual({ ...seen, host: "x" }, {
    host: "x",
    origin: undefined,
    authorization: "PiHub-HMAC-SHA256 sig",
  });
  // Host comes from the loopback URL authority, never from the relayed envelope.
  assert.match(seen.host, /^127\.0\.0\.1:\d+$/);
});

test("large replies move to the xfer channel with a verifiable digest", async (t) => {
  const big = Buffer.alloc(900 * 1024, 0x61);
  const localBase = await withLocalServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(big);
  });
  const nats = fakeNats();
  const connector = await createConnector({
    config: testConfig(), localBase, connect: async () => nats.connection, logger: silentLogger(),
  });
  t.after(() => connector.close());

  const request = { v: 1, kind: "req", id: "req-big-0001", method: "GET", path: "/api/files/x?type=download&sessionId=s", headers: {} };
  nats.emit("node.test-node.request", enc(request), "reply.inbox.2");
  await new Promise((resolve) => setTimeout(resolve, 100));

  const reply = dec(nats.published.find((entry) => entry.subject === "reply.inbox.2").data);
  assert.ok(reply.xfer, "reply references an xfer id");
  const subject = `node.test-node.xfer.${reply.xfer}`;
  const frames = nats.published.filter((entry) => entry.subject === subject);
  const open = dec(frames[0].data);
  assert.equal(open.kind, "xfer-open");
  assert.equal(open.size, big.length);
  const chunks = frames.slice(1, -1).map((entry) => entry.data.subarray(8));
  const assembled = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  assert.equal(assembled.length, big.length);
  assert.ok(assembled.equals(big));
  const close = dec(frames.at(-1).data);
  assert.equal(close.kind, "xfer-close");
  assert.equal(close.ok, true);
});

test("stream-open relays byte chunks and stream-end", async (t) => {
  const localBase = await withLocalServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    setTimeout(() => { res.write("data: two\n\n"); res.end(); }, 20);
  });
  const nats = fakeNats();
  const connector = await createConnector({
    config: testConfig(), localBase, connect: async () => nats.connection, logger: silentLogger(),
  });
  t.after(() => connector.close());

  nats.emit("node.test-node.stream.open", enc({
    v: 1, kind: "stream-open", streamId: "stream-01", path: "/api/agent/s1/events", headers: {},
  }));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const frames = nats.published.filter((entry) => entry.subject === "node.test-node.events.stream-01");
  const binary = frames.filter((entry) => entry.data[0] !== 0x7b);
  const end = frames.find((entry) => entry.data[0] === 0x7b && dec(entry.data).kind === "stream-end");
  assert.ok(binary.length >= 1);
  const text = Buffer.concat(binary.map((entry) => Buffer.from(entry.data.subarray(8)))).toString();
  assert.ok(text.includes("data: one"));
  assert.ok(text.includes("data: two"));
  assert.ok(end, "stream-end published");
});

test("stream-close aborts the local stream", async (t) => {
  let ended = false;
  const localBase = await withLocalServer(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": open\n\n");
    req.on("close", () => { ended = true; });
  });
  const nats = fakeNats();
  const connector = await createConnector({
    config: testConfig(), localBase, connect: async () => nats.connection, logger: silentLogger(),
  });
  t.after(() => connector.close());

  nats.emit("node.test-node.stream.open", enc({
    v: 1, kind: "stream-open", streamId: "stream-02", path: "/api/pihub/terminal/t1/events", headers: {},
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  nats.emit("node.test-node.stream.close", enc({ v: 1, kind: "stream-close", streamId: "stream-02" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ended, true);
});

test("inbound xfer reassembles the request body in order", async (t) => {
  let received = null;
  const localBase = await withLocalServer(t, (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = Buffer.concat(chunks);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const nats = fakeNats();
  const connector = await createConnector({
    config: testConfig(), localBase, connect: async () => nats.connection, logger: silentLogger(),
  });
  t.after(() => connector.close());

  const payload = Buffer.alloc(2 * 1024 * 1024 + 7, 0x62);
  const sha256 = (await import("node:crypto")).createHash("sha256").update(payload).digest("hex");
  const xferId = "xfer-up-01";
  const request = {
    v: 1, kind: "req", id: "req-upload-1", method: "POST",
    path: "/api/files/x?type=upload&conflict=rename", headers: { "content-type": "multipart/form-data; boundary=x" },
    xfer: xferId,
  };
  nats.emit("node.test-node.request", enc(request), "reply.inbox.3");
  const subject = `node.test-node.xfer.${xferId}`;
  nats.emit(subject, enc({ v: 1, kind: "xfer-open", xferId, size: payload.length, sha256 }));
  let offset = 0;
  let sequence = 0;
  while (offset < payload.length) {
    const chunk = payload.subarray(offset, offset + protocol.RELAY_XFER_CHUNK);
    nats.emit(subject, protocol.encodeFrame(sequence, chunk));
    offset += chunk.length;
    sequence += 1;
  }
  nats.emit(subject, enc({ v: 1, kind: "xfer-close", xferId, ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.ok(received, "local server received a body");
  assert.ok(received.equals(payload));
  const reply = nats.published.find((entry) => entry.subject === "reply.inbox.3");
  assert.equal(dec(reply.data).status, 200);
});

test("digest mismatch on inbound xfer fails the request", async (t) => {
  const localBase = await withLocalServer(t, (_req, res) => { res.writeHead(200); res.end("{}"); });
  const nats = fakeNats();
  const connector = await createConnector({
    config: testConfig(), localBase, connect: async () => nats.connection, logger: silentLogger(),
  });
  t.after(() => connector.close());

  const xferId = "xfer-bad-01";
  nats.emit(`node.test-node.xfer.${xferId}`, enc({ v: 1, kind: "xfer-open", xferId, sha256: "0".repeat(64) }));
  nats.emit("node.test-node.request", enc({
    v: 1, kind: "req", id: "req-bad-1", method: "POST", path: "/api/agent/new", headers: {}, xfer: xferId,
  }), "reply.inbox.4");
  nats.emit(`node.test-node.xfer.${xferId}`, protocol.encodeFrame(0, new TextEncoder().encode("tampered")));
  nats.emit(`node.test-node.xfer.${xferId}`, enc({ v: 1, kind: "xfer-close", xferId, ok: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const reply = nats.published.find((entry) => entry.subject === "reply.inbox.4");
  assert.equal(dec(reply.data).status, 502);
});

test("loadConnectorConfig validates the on-disk shape", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pihub-connector-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(loadConnectorConfig(dir), null);
  const stateDir = path.join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "connector.json"), JSON.stringify({
    relayUrl: "wss://relay.example.invalid", nodeId: "test-node", user: "node-test-node", token: "t".repeat(43),
  }));
  assert.equal(loadConnectorConfig(dir).nodeId, "test-node");
  writeFileSync(path.join(stateDir, "connector.json"), JSON.stringify({ relayUrl: "http://no", nodeId: "x", user: "y", token: "z" }));
  assert.throws(() => loadConnectorConfig(dir), /relayUrl/);
  writeFileSync(path.join(stateDir, "connector.json"), JSON.stringify({
    relayUrl: "wss://relay.example.invalid", nodeId: "test-node", user: "node-other", token: "t".repeat(43),
  }));
  assert.throws(() => loadConnectorConfig(dir), /user/);
});
