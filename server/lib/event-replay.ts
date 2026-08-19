const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 128;
const DEFAULT_MAX_CONNECTIONS_PER_SCOPE = 4;
const DEFAULT_MAX_CONNECTIONS_PER_GROUP = 16;
const DEFAULT_MAX_QUEUE_BYTES = 512 * 1024;
const DEFAULT_MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REPLAY_FRAMES = 256;

const HEARTBEAT_FRAME = new TextEncoder().encode(": keep-alive\n\n");

interface SseConnectionRuntime {
  total: number;
  byScope: Map<string, number>;
  byGroup: Map<string, number>;
}

declare global {
  var __pihubSseConnectionRuntimeV1: SseConnectionRuntime | undefined;
}

function connectionRuntime(): SseConnectionRuntime {
  if (!globalThis.__pihubSseConnectionRuntimeV1) {
    globalThis.__pihubSseConnectionRuntimeV1 = {
      total: 0,
      byScope: new Map(),
      byGroup: new Map(),
    };
  }
  if (!globalThis.__pihubSseConnectionRuntimeV1.byGroup) {
    globalThis.__pihubSseConnectionRuntimeV1.byGroup = new Map();
  }
  return globalThis.__pihubSseConnectionRuntimeV1;
}

function reserveConnection(
  scope: string,
  group: string | undefined,
  maxConnections: number,
  maxConnectionsPerScope: number,
  maxConnectionsPerGroup: number,
): boolean {
  const runtime = connectionRuntime();
  const scoped = runtime.byScope.get(scope) ?? 0;
  const grouped = group !== undefined ? runtime.byGroup.get(group) ?? 0 : 0;
  if (
    runtime.total >= maxConnections
    || scoped >= maxConnectionsPerScope
    || (group !== undefined && grouped >= maxConnectionsPerGroup)
  ) return false;
  runtime.total += 1;
  runtime.byScope.set(scope, scoped + 1);
  if (group !== undefined) runtime.byGroup.set(group, grouped + 1);
  return true;
}

function releaseConnection(scope: string, group: string | undefined): void {
  const runtime = connectionRuntime();
  runtime.total = Math.max(0, runtime.total - 1);
  const scoped = runtime.byScope.get(scope) ?? 0;
  if (scoped <= 1) runtime.byScope.delete(scope);
  else runtime.byScope.set(scope, scoped - 1);
  if (group !== undefined) {
    const grouped = runtime.byGroup.get(group) ?? 0;
    if (grouped <= 1) runtime.byGroup.delete(group);
    else runtime.byGroup.set(group, grouped - 1);
  }
}

export interface SseReplayChannelOptions {
  maxReplayBytes?: number;
  maxReplayFrames?: number;
}

export interface SseReplayOpenOptions {
  connectionGroup?: string;
  heartbeatIntervalMs?: number;
  maxConnections?: number;
  maxConnectionsPerGroup?: number;
  maxConnectionsPerScope?: number;
  maxQueueBytes?: number;
  onClose?: () => void;
}

export type SseReplayOpenResult =
  | { accepted: true; connection: SseReplayConnection; stream: ReadableStream<Uint8Array> }
  | { accepted: false; status: 204 | 429 };

export type SseReplayResult =
  | { status: "complete"; replayed: number }
  | { status: "gap" | "future"; replayed: 0 };

interface ReplayFrame {
  id: number;
  bytes: Uint8Array;
}

interface ConnectionInternal {
  active: boolean;
  enqueue(frame: Uint8Array): boolean;
  close(): void;
}

export interface SseReplayConnection {
  readonly closed: boolean;
  activate(): void;
  replayAfter(lastEventId: number): SseReplayResult;
  /** Send a connection-local control frame without adding it to replay history. */
  send(data: unknown): boolean;
  close(): void;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
}

export function parseLastEventId(request: Request): number | null {
  const value = request.headers.get("last-event-id")?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** A bounded replay ring shared by one authenticated stream scope. */
export class SseReplayChannel {
  private readonly encoder = new TextEncoder();
  private readonly maxReplayBytes: number;
  private readonly maxReplayFrames: number;
  private readonly connections = new Set<ConnectionInternal>();
  private frames: ReplayFrame[] = [];
  private replayBytes = 0;
  private nextEventId = 1;

  constructor(
    public readonly scope: string,
    options: SseReplayChannelOptions = {},
  ) {
    this.maxReplayBytes = positiveInteger(options.maxReplayBytes, DEFAULT_MAX_REPLAY_BYTES);
    this.maxReplayFrames = positiveInteger(options.maxReplayFrames, DEFAULT_MAX_REPLAY_FRAMES);
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get latestEventId(): number {
    return this.nextEventId - 1;
  }

  open(request: Request, options: SseReplayOpenOptions = {}): SseReplayOpenResult {
    if (request.signal.aborted) return { accepted: false, status: 204 };

    const maxConnections = positiveInteger(options.maxConnections, DEFAULT_MAX_CONNECTIONS);
    const maxConnectionsPerScope = positiveInteger(
      options.maxConnectionsPerScope,
      DEFAULT_MAX_CONNECTIONS_PER_SCOPE,
    );
    const maxConnectionsPerGroup = positiveInteger(
      options.maxConnectionsPerGroup,
      DEFAULT_MAX_CONNECTIONS_PER_GROUP,
    );
    if (!reserveConnection(
      this.scope,
      options.connectionGroup,
      maxConnections,
      maxConnectionsPerScope,
      maxConnectionsPerGroup,
    )) {
      return { accepted: false, status: 429 };
    }

    const heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    const maxQueueBytes = positiveInteger(options.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let abortHandler: (() => void) | null = null;
    let removeFromChannel = () => {};

    const cleanup = (closeController: boolean, error?: Error) => {
      if (closed) return;
      closed = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      if (abortHandler) request.signal.removeEventListener("abort", abortHandler);
      abortHandler = null;
      removeFromChannel();
      releaseConnection(this.scope, options.connectionGroup);
      if (closeController) {
        try {
          if (error) controller.error(error);
          else controller.close();
        } catch {
          // The consumer already closed the stream.
        }
      }
      try {
        options.onClose?.();
      } catch {
        // Cleanup must remain idempotent even when a caller callback fails.
      }
    };

    const enqueue = (frame: Uint8Array): boolean => {
      if (closed) return false;
      const available = controller.desiredSize;
      if (available === null || available < frame.byteLength) {
        cleanup(true, new Error("SSE consumer is too slow"));
        return false;
      }
      try {
        controller.enqueue(frame);
        return true;
      } catch {
        cleanup(false);
        return false;
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
      cancel() {
        cleanup(false);
      },
    }, {
      highWaterMark: maxQueueBytes,
      size: (chunk) => chunk.byteLength,
    });

    const send = (data: unknown): boolean => {
      let json: string | undefined;
      try {
        json = JSON.stringify(data);
      } catch {
        cleanup(true, new Error("Unable to serialize SSE event"));
        return false;
      }
      if (json === undefined) {
        cleanup(true, new Error("Unable to serialize SSE event"));
        return false;
      }
      return enqueue(this.encoder.encode(`data: ${json}\n\n`));
    };

    const internal: ConnectionInternal = {
      active: false,
      enqueue,
      close: () => cleanup(true),
    };
    this.connections.add(internal);
    removeFromChannel = () => { this.connections.delete(internal); };

    const connection: SseReplayConnection = {
      get closed() { return closed; },
      activate: () => { internal.active = true; },
      replayAfter: (lastEventId) => this.replayAfter(internal, lastEventId),
      send,
      close: () => cleanup(true),
    };

    abortHandler = () => cleanup(true);
    request.signal.addEventListener("abort", abortHandler, { once: true });
    heartbeat = setInterval(() => { enqueue(HEARTBEAT_FRAME); }, heartbeatIntervalMs);
    heartbeat.unref?.();
    enqueue(HEARTBEAT_FRAME);

    return { accepted: true, connection, stream };
  }

  publish(data: unknown): number | null {
    const frame = this.append(data);
    if (!frame) return null;
    for (const connection of this.connections) {
      if (connection.active) connection.enqueue(frame.bytes);
    }
    return frame.id;
  }

  closeAll(): void {
    for (const connection of [...this.connections]) {
      connection.close();
    }
  }

  private append(data: unknown): ReplayFrame | null {
    let json: string | undefined;
    try {
      json = JSON.stringify(data);
    } catch {
      return null;
    }
    if (json === undefined) return null;
    if (!Number.isSafeInteger(this.nextEventId)) return null;

    const id = this.nextEventId++;
    const bytes = this.encoder.encode(`id: ${id}\ndata: ${json}\n\n`);
    const frame = { id, bytes };
    if (bytes.byteLength > this.maxReplayBytes) {
      this.frames = [];
      this.replayBytes = 0;
      return frame;
    }

    this.frames.push(frame);
    this.replayBytes += bytes.byteLength;
    while (
      this.frames.length > this.maxReplayFrames
      || this.replayBytes > this.maxReplayBytes
    ) {
      const removed = this.frames.shift();
      if (!removed) break;
      this.replayBytes -= removed.bytes.byteLength;
    }
    return frame;
  }

  private replayAfter(connection: ConnectionInternal, lastEventId: number): SseReplayResult {
    const latest = this.latestEventId;
    if (!Number.isSafeInteger(lastEventId) || lastEventId < 0 || lastEventId > latest) {
      return { status: "future", replayed: 0 };
    }
    if (lastEventId === latest) return { status: "complete", replayed: 0 };

    const oldest = this.frames[0]?.id;
    if (oldest === undefined || lastEventId < oldest - 1) {
      return { status: "gap", replayed: 0 };
    }

    let replayed = 0;
    for (const frame of this.frames) {
      if (frame.id <= lastEventId) continue;
      if (!connection.enqueue(frame.bytes)) break;
      replayed += 1;
    }
    return { status: "complete", replayed };
  }
}

export function getSseConnectionStats(): { total: number; scopes: Map<string, number> } {
  const runtime = connectionRuntime();
  return { total: runtime.total, scopes: new Map(runtime.byScope) };
}

export function resetSseConnectionRuntimeForTests(): void {
  globalThis.__pihubSseConnectionRuntimeV1 = {
    total: 0,
    byScope: new Map(),
    byGroup: new Map(),
  };
}
