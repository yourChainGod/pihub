import {
  SseReplayChannel,
  parseLastEventId,
  type SseReplayConnection,
} from "./event-replay";
import {
  isEventIncludedInSnapshot,
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire";

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  onEvent(listener: (event: AgentEventLike) => void): () => void;
}

export interface AgentEventStreamOptions {
  deviceId: string;
  sessionId: string;
  loadSession(): Promise<AgentEventStreamSession>;
}

export type AgentEventStreamResult =
  | { accepted: true; stream: ReadableStream<Uint8Array> }
  | { accepted: false; status: 204 | 429 | 503 };

const MAX_RETAINED_CHANNELS = 256;
const CHANNEL_RETENTION_MS = 60_000;
const MAX_REPLAY_BYTES_PER_CHANNEL = 512 * 1024;

interface AgentChannelRegistry {
  channels: Map<string, AgentEventChannel>;
}

declare global {
  var __pihubAgentEventChannelsV1: AgentChannelRegistry | undefined;
}

function registry(): AgentChannelRegistry {
  if (!globalThis.__pihubAgentEventChannelsV1) {
    globalThis.__pihubAgentEventChannelsV1 = { channels: new Map() };
  }
  return globalThis.__pihubAgentEventChannelsV1;
}

function channelKey(deviceId: string, sessionId: string): string {
  return `agent:${JSON.stringify([deviceId, sessionId])}`;
}

class AgentEventChannel {
  readonly replay: SseReplayChannel;
  lastUsedAt = Date.now();
  private session: AgentEventStreamSession | null = null;
  private binding: Promise<AgentEventStreamSession> | null = null;
  private unsubscribe: (() => void) | null = null;
  private retentionTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    readonly registryKey: string,
    private readonly sessionId: string,
    private readonly connectionGroup: string,
  ) {
    this.replay = new SseReplayChannel(registryKey, {
      maxReplayBytes: MAX_REPLAY_BYTES_PER_CHANNEL,
    });
  }

  open(request: Request, loadSession: () => Promise<AgentEventStreamSession>): AgentEventStreamResult {
    this.lastUsedAt = Date.now();
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.retentionTimer = null;

    const opened = this.replay.open(request, {
      connectionGroup: this.connectionGroup,
      onClose: () => this.connectionClosed(),
    });
    if (!opened.accepted) {
      this.scheduleRetention();
      return opened;
    }

    void this.initialize(opened.connection, request, loadSession);
    return { accepted: true, stream: opened.stream };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.retentionTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = null;
    this.replay.closeAll();
  }

  private async initialize(
    connection: SseReplayConnection,
    request: Request,
    loadSession: () => Promise<AgentEventStreamSession>,
  ): Promise<void> {
    const hadContinuousSource = this.unsubscribe !== null;
    const baselineEventId = this.replay.latestEventId;
    try {
      const session = await this.bind(loadSession);
      if (connection.closed) return;

      const lastEventId = parseLastEventId(request);
      let needsSnapshot = lastEventId === null;
      if (!connection.send({
        type: "connected",
        sessionId: this.sessionId,
        isStreaming: session.isStreaming,
      })) return;

      if (lastEventId === null) {
        connection.replayAfter(baselineEventId);
      } else if (!hadContinuousSource) {
        needsSnapshot = true;
        if (!connection.send({
          type: "replay_reset",
          sessionId: this.sessionId,
          reason: lastEventId > baselineEventId ? "future" : "gap",
        })) return;
      } else {
        const replayed = connection.replayAfter(lastEventId);
        if (replayed.status !== "complete") {
          needsSnapshot = true;
          if (!connection.send({
            type: "replay_reset",
            sessionId: this.sessionId,
            reason: replayed.status,
          })) return;
        }
      }
      if (connection.closed) return;

      const snapshot = session.streamingMessage;
      if (
        needsSnapshot
        && snapshot !== undefined
        && snapshot !== null
        && !connection.send({ type: "message_start", message: snapshot })
      ) return;

      connection.activate();
    } catch {
      if (connection.closed) return;
      connection.send({
        type: "startup_error",
        errorMessage: "Failed to start agent session",
      });
      connection.close();
    }
  }

  private bind(
    loadSession: () => Promise<AgentEventStreamSession>,
  ): Promise<AgentEventStreamSession> {
    if (this.session && this.unsubscribe) return Promise.resolve(this.session);
    if (this.binding) return this.binding;

    this.binding = (async () => {
      const session = await loadSession();
      if (this.destroyed) return session;
      this.session = session;
      if (this.replay.connectionCount === 0) return session;

      const bufferedEvents: AgentEventLike[] = [];
      let sourceReady = false;
      const handleEvent = (event: AgentEventLike) => {
        if (!sourceReady) {
          bufferedEvents.push(event);
          return;
        }
        this.publishEvent(event, undefined);
      };
      const unsubscribe = session.onEvent(handleEvent);
      if (this.replay.connectionCount === 0) {
        unsubscribe();
        return session;
      }
      this.unsubscribe = unsubscribe;

      const snapshot = session.streamingMessage;
      for (const event of bufferedEvents) this.publishEvent(event, snapshot);
      sourceReady = true;
      return session;
    })().finally(() => {
      this.binding = null;
    });
    return this.binding;
  }

  private publishEvent(event: AgentEventLike, snapshot: unknown): void {
    if (isEventIncludedInSnapshot(event, snapshot)) return;
    const clientEvent = toClientAgentEvent(event);
    if (clientEvent) this.replay.publish(clientEvent);
  }

  private connectionClosed(): void {
    this.lastUsedAt = Date.now();
    if (this.replay.connectionCount > 0) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = null;
    this.scheduleRetention();
  }

  private scheduleRetention(): void {
    if (this.destroyed || this.retentionTimer || this.replay.connectionCount > 0) return;
    this.retentionTimer = setTimeout(() => {
      this.retentionTimer = null;
      if (this.replay.connectionCount > 0) return;
      this.destroy();
      registry().channels.delete(this.registryKey);
    }, CHANNEL_RETENTION_MS);
    this.retentionTimer.unref?.();
  }
}

function getChannel(deviceId: string, sessionId: string): AgentEventChannel | null {
  const channels = registry().channels;
  const key = channelKey(deviceId, sessionId);
  const existing = channels.get(key);
  if (existing) return existing;

  if (channels.size >= MAX_RETAINED_CHANNELS) {
    const idle = [...channels.values()]
      .filter((channel) => channel.replay.connectionCount === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    while (channels.size >= MAX_RETAINED_CHANNELS && idle.length > 0) {
      const channel = idle.shift()!;
      channel.destroy();
      channels.delete(channel.registryKey);
    }
  }
  if (channels.size >= MAX_RETAINED_CHANNELS) return null;

  const channel = new AgentEventChannel(
    key,
    sessionId,
    `device:${JSON.stringify(deviceId)}`,
  );
  channels.set(key, channel);
  return channel;
}

/** Admit and initialize one authenticated, replayable agent event stream. */
export function createAgentEventStream(
  request: Request,
  options: AgentEventStreamOptions,
): AgentEventStreamResult {
  if (request.signal.aborted) return { accepted: false, status: 204 };
  const channel = getChannel(options.deviceId, options.sessionId);
  if (!channel) return { accepted: false, status: 503 };
  return channel.open(request, options.loadSession);
}

export function resetAgentEventChannelsForTests(): void {
  const channels = registry().channels;
  for (const channel of channels.values()) channel.destroy();
  globalThis.__pihubAgentEventChannelsV1 = { channels: new Map() };
}
