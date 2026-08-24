/**
 * Node-side relay connector: keeps an outbound WSS connection to the NATS
 * relay and replays relayed requests byte-for-byte to the loopback PiHub
 * server. PiHub HMAC signing stays end-to-end (the desktop signs; the local
 * server verifies), so the connector holds no credentials of its own and never
 * inspects message bodies beyond the envelope.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  decodeRequest,
  decodeStreamClose,
  decodeStreamOpen,
  decodeXferClose,
  decodeXferOpen,
  encodeFrame,
  encodeResponse,
  encodeStreamEnd,
  eventsSubject,
  newRelayId,
  RELAY_INLINE_LIMIT,
  RELAY_PROTOCOL_VERSION,
  RELAY_XFER_CHUNK,
  RELAY_XFER_IDLE_TIMEOUT_MS,
  requestSubject,
  streamCloseSubject,
  streamOpenSubject,
  validNodeId,
  xferSubject,
  type RelayHeaders,
  type RelayRequest,
} from "./relay-protocol";

export interface ConnectorConfig {
  relayUrl: string;
  nodeId: string;
  user: string;
  token: string;
}

/** Minimal NATS surface, injectable for tests. */
export interface NatsLikeSubscription {
  unsubscribe(): void;
}
export interface NatsLikeMessage {
  data: Uint8Array;
  subject: string;
  reply?: string;
}
export interface NatsLikeConnection {
  // nats.js delivers (error, message); error is null on normal delivery.
  subscribe(subject: string, options: { callback(error: Error | null, message: NatsLikeMessage): void }): NatsLikeSubscription;
  publish(subject: string, data: Uint8Array, options?: { reply?: string }): void;
  status(): AsyncIterable<{ type: string }>;
  close(): Promise<void>;
}

export interface ConnectorLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const DEFAULT_LOCAL_BASE = "http://127.0.0.1:30141";
/** Relayed bodies never exceed the desktop file ceiling (512MB downloads). */
const MAX_RELAYED_BODY = 512 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "origin",
  "content-length",
]);
const RESPONSE_DROP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length",
]);

export function loadConnectorConfig(dataRoot: string): ConnectorConfig | null {
  const file = path.join(dataRoot, "state", "connector.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`connector.json 不是有效 JSON：${(error as Error).message}`);
  }
  const value = parsed as Partial<ConnectorConfig>;
  if (typeof value?.relayUrl !== "string" || !value.relayUrl.startsWith("wss://")) {
    throw new Error("connector.json 缺少 wss:// relayUrl");
  }
  if (!validNodeId(value.nodeId)) throw new Error("connector.json 的 nodeId 无效");
  if (value.user !== `node-${value.nodeId}`) throw new Error("connector.json 的 user 与 nodeId 不匹配");
  if (typeof value.token !== "string" || value.token.length < 32) throw new Error("connector.json 的 token 无效");
  return { relayUrl: value.relayUrl, nodeId: value.nodeId, user: value.user, token: value.token };
}

interface InboundTransfer {
  queue: Uint8Array[];
  waiting: (() => void) | null;
  nextSequence: number;
  hasher: crypto.Hash | null;
  expectedSha256: string | null;
  received: number;
  done: boolean;
  error: string | null;
  timer: NodeJS.Timeout;
}

interface ActiveStream {
  controller: AbortController;
  sequence: number;
}

export interface ConnectorOptions {
  config: ConnectorConfig;
  localBase?: string;
  connect: (config: ConnectorConfig) => Promise<NatsLikeConnection>;
  fetchImpl?: typeof fetch;
  logger?: ConnectorLogger;
}

export interface RunningConnector {
  close(): Promise<void>;
  connection: NatsLikeConnection;
}

export async function createConnector(options: ConnectorOptions): Promise<RunningConnector> {
  const { config } = options;
  const localBase = options.localBase ?? DEFAULT_LOCAL_BASE;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? console;
  const streams = new Map<string, ActiveStream>();
  const inbound = new Map<string, InboundTransfer>();
  let closed = false;

  const connection = await options.connect(config);

  function localHeaders(headers: RelayHeaders, streamingBody: boolean): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      if (lower.startsWith("sec-")) continue;
      result[lower] = value;
    }
    // Host is set by the HTTP client from the loopback URL authority; the
    // desktop-sent Host (a relay/tailnet name) must never leak through.
    if (streamingBody) delete result["content-length"];
    return result;
  }

  function stopStream(streamId: string, reason?: string): void {
    const active = streams.get(streamId);
    if (!active) return;
    streams.delete(streamId);
    active.controller.abort();
    void reason;
  }

  function stopEverything(): void {
    for (const streamId of [...streams.keys()]) stopStream(streamId);
    for (const transfer of inbound.values()) {
      clearTimeout(transfer.timer);
      transfer.error = "connector shutting down";
      transfer.waiting?.();
    }
    inbound.clear();
  }

  function transferEntry(xferId: string): InboundTransfer {
    let entry = inbound.get(xferId);
    if (entry) return entry;
    const timer = setTimeout(() => {
      const stale = inbound.get(xferId);
      if (stale && !stale.done) {
        stale.error = "transfer timed out";
        stale.waiting?.();
      }
      inbound.delete(xferId);
    }, RELAY_XFER_IDLE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    entry = {
      queue: [], waiting: null, nextSequence: 0, hasher: null,
      expectedSha256: null, received: 0, done: false, error: null, timer,
    };
    inbound.set(xferId, entry);
    return entry;
  }

  function handleXferMessage(message: NatsLikeMessage): void {
    const xferId = message.subject.split(".").pop() ?? "";
    const text = message.data.length > 0 && message.data[0] === 0x7b // '{'
      ? (() => { try { return new TextDecoder().decode(message.data); } catch { return null; } })()
      : null;
    try {
      if (text !== null) {
        const kind = (JSON.parse(text) as { kind?: string }).kind;
        if (kind === "xfer-open") {
          const open = decodeXferOpen(message.data);
          const entry = transferEntry(open.xferId);
          entry.expectedSha256 = open.sha256;
          entry.hasher = crypto.createHash("sha256");
          entry.waiting?.();
          return;
        }
        if (kind === "xfer-close") {
          const close = decodeXferClose(message.data);
          const entry = inbound.get(close.xferId);
          if (!entry) return;
          if (!close.ok) entry.error = close.error ?? "transfer aborted";
          entry.done = true;
          entry.waiting?.();
          return;
        }
        return;
      }
      // Binary data frame.
      const entry = inbound.get(xferId);
      if (!entry || entry.done) return;
      const view = new DataView(message.data.buffer, message.data.byteOffset, message.data.byteLength);
      const sequence = view.getUint32(0);
      const length = view.getUint32(4);
      if (length !== message.data.length - 8 || sequence !== entry.nextSequence) {
        entry.error = "transfer frame out of order";
        entry.done = true;
        entry.waiting?.();
        return;
      }
      entry.nextSequence += 1;
      const payload = message.data.subarray(8);
      entry.received += payload.length;
      if (entry.received > MAX_RELAYED_BODY) {
        entry.error = "transfer exceeds the size limit";
        entry.done = true;
        entry.waiting?.();
        return;
      }
      entry.hasher?.update(payload);
      entry.queue.push(payload);
      entry.waiting?.();
    } catch (error) {
      logger.warn(`connector: 丢弃畸形 xfer 消息（${(error as Error).message}）`);
    }
  }

  async function nextChunk(xferId: string): Promise<Uint8Array | null> {
    const entry = transferEntry(xferId);
    for (;;) {
      if (entry.queue.length > 0) return entry.queue.shift() ?? null;
      if (entry.error) throw new Error(entry.error);
      if (entry.done) {
        if (entry.expectedSha256 && entry.hasher) {
          const digest = entry.hasher.digest("hex");
          if (digest !== entry.expectedSha256) throw new Error("transfer digest mismatch");
        }
        return null;
      }
      await new Promise<void>((resolve) => { entry.waiting = resolve; });
      entry.waiting = null;
    }
  }

  async function* inboundBody(xferId: string): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        const chunk = await nextChunk(xferId);
        if (chunk === null) return;
        yield chunk;
      }
    } finally {
      const entry = inbound.get(xferId);
      if (entry) clearTimeout(entry.timer);
      inbound.delete(xferId);
    }
  }

  async function replyWithBody(
    reply: string | undefined,
    request: RelayRequest,
    response: { status: number; headers: RelayHeaders; body: Buffer },
  ): Promise<void> {
    if (!reply) return;
    if (response.body.length <= RELAY_INLINE_LIMIT) {
      connection.publish(reply, encodeResponse({
        v: RELAY_PROTOCOL_VERSION,
        kind: "res",
        id: request.id,
        status: response.status,
        headers: response.headers,
        body: response.body.toString("base64"),
      }));
      return;
    }
    const xferId = newRelayId();
    const subject = xferSubject(config.nodeId, xferId);
    connection.publish(reply, encodeResponse({
      v: RELAY_PROTOCOL_VERSION,
      kind: "res",
      id: request.id,
      status: response.status,
      headers: response.headers,
      xfer: xferId,
    }));
    connection.publish(subject, new TextEncoder().encode(JSON.stringify({
      v: RELAY_PROTOCOL_VERSION,
      kind: "xfer-open",
      xferId,
      size: response.body.length,
      sha256: crypto.createHash("sha256").update(response.body).digest("hex"),
    })));
    let sequence = 0;
    for (let offset = 0; offset < response.body.length; offset += RELAY_XFER_CHUNK) {
      connection.publish(subject, encodeFrame(sequence, response.body.subarray(offset, offset + RELAY_XFER_CHUNK)));
      sequence += 1;
    }
    connection.publish(subject, new TextEncoder().encode(JSON.stringify({
      v: RELAY_PROTOCOL_VERSION, kind: "xfer-close", xferId, ok: true,
    })));
  }

  async function handleRequest(message: NatsLikeMessage): Promise<void> {
    let request: RelayRequest;
    try {
      request = decodeRequest(message.data);
    } catch (error) {
      logger.warn(`connector: 丢弃畸形请求（${(error as Error).message}）`);
      return;
    }
    const failReply = (status: number, errorText: string) => {
      if (!message.reply) return;
      connection.publish(message.reply, encodeResponse({
        v: RELAY_PROTOCOL_VERSION, kind: "res", id: request.id, status,
        headers: {}, error: errorText,
      }));
    };
    try {
      const streaming = request.xfer !== undefined;
      const response = await fetchImpl(`${localBase}${request.path}`, {
        method: request.method,
        headers: localHeaders(request.headers, streaming),
        ...(request.method === "GET" || request.method === "HEAD"
          ? {}
          : streaming
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? { body: ReadableStreamFrom(inboundBody(request.xfer!)), duplex: "half" as any }
            : { body: request.body ? Buffer.from(request.body, "base64") : undefined }),
        redirect: "manual",
      });
      const headers: RelayHeaders = {};
      response.headers.forEach((value, name) => {
        if (!RESPONSE_DROP_HEADERS.has(name)) headers[name] = value.slice(0, 8 * 1024);
      });
      const body = Buffer.from(await response.arrayBuffer());
      await replyWithBody(message.reply, request, { status: response.status, headers, body });
      // Replay visibility without secrets: method + route shape + status only.
      logger.info(`connector: ${request.method} ${request.path.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/g, "<id>")} → ${response.status} (${body.length}B)`);
    } catch (error) {
      failReply(502, `local replay failed: ${(error as Error).message}`.slice(0, 200));
    }
  }

  function ReadableStreamFrom(source: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await source.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await source.return(undefined);
      },
    });
  }

  async function handleStreamOpen(message: NatsLikeMessage): Promise<void> {
    let open;
    try {
      open = decodeStreamOpen(message.data);
    } catch (error) {
      logger.warn(`connector: 丢弃畸形 stream-open（${(error as Error).message}）`);
      return;
    }
    stopStream(open.streamId);
    const controller = new AbortController();
    const active: ActiveStream = { controller, sequence: 0 };
    streams.set(open.streamId, active);
    const subject = eventsSubject(config.nodeId, open.streamId);
    const end = (errorText?: string) => {
      if (!streams.delete(open.streamId)) return;
      connection.publish(subject, encodeStreamEnd({
        v: RELAY_PROTOCOL_VERSION, kind: "stream-end", streamId: open.streamId, ...(errorText ? { error: errorText } : {}),
      }));
    };
    try {
      const response = await fetchImpl(`${localBase}${open.path}`, {
        headers: localHeaders(open.headers, false),
        signal: controller.signal,
        redirect: "manual",
      });
      if (!response.ok || !response.body) {
        end(`local stream failed with status ${response.status}`);
        return;
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!streams.has(open.streamId)) break;
        connection.publish(subject, encodeFrame(active.sequence, value));
        active.sequence += 1;
      }
      end();
    } catch (error) {
      if (controller.signal.aborted) return; // stream-close already ended it
      end((error as Error).message.slice(0, 200));
    }
  }

  function handleStreamClose(message: NatsLikeMessage): void {
    try {
      stopStream(decodeStreamClose(message.data).streamId);
    } catch (error) {
      logger.warn(`connector: 丢弃畸形 stream-close（${(error as Error).message}）`);
    }
  }

  const prefix = `node.${config.nodeId}.`;
  // nats.js subscription callbacks receive (error, message).
  const onlyMessage = (handler: (message: NatsLikeMessage) => void) =>
    (error: Error | null, message: NatsLikeMessage) => {
      if (error) {
        logger.warn(`connector: relay 投递错误（${error.message}）`);
        return;
      }
      handler(message);
    };
  const subscriptions = [
    connection.subscribe(requestSubject(config.nodeId), { callback: onlyMessage((message) => void handleRequest(message)) }),
    connection.subscribe(streamOpenSubject(config.nodeId), { callback: onlyMessage((message) => void handleStreamOpen(message)) }),
    connection.subscribe(streamCloseSubject(config.nodeId), { callback: onlyMessage(handleStreamClose) }),
    connection.subscribe(`${prefix}xfer.>`, { callback: onlyMessage(handleXferMessage) }),
  ];

  // A relay disconnect invalidates every local stream; the desktop reopens
  // them with Last-Event-ID after reconnecting.
  void (async () => {
    for await (const status of connection.status()) {
      if (status.type === "disconnect" || status.type === "reconnect") {
        for (const streamId of [...streams.keys()]) stopStream(streamId);
      }
      if (status.type === "reconnect") logger.info("connector: relay 重连成功");
    }
  })().catch(() => undefined);

  logger.info(`connector: 节点 ${config.nodeId} 已接入 relay`);
  return {
    connection,
    async close() {
      if (closed) return;
      closed = true;
      stopEverything();
      for (const subscription of subscriptions) subscription.unsubscribe();
      await connection.close();
    },
  };
}
