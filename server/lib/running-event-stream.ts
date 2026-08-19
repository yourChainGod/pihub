import {
  SseReplayChannel,
  parseLastEventId,
  type SseReplayConnection,
} from "./event-replay";

export interface RunningEventStreamOptions {
  deviceId: string;
  getSnapshot(): string[];
  subscribe(listener: (sessionIds: string[]) => void): () => void;
}

export type RunningEventStreamResult =
  | { accepted: true; stream: ReadableStream<Uint8Array> }
  | { accepted: false; status: 204 | 429 | 503 };

const MAX_RETAINED_CHANNELS = 256;
const CHANNEL_RETENTION_MS = 60_000;
const MAX_REPLAY_BYTES_PER_CHANNEL = 64 * 1024;
const MAX_REPLAY_FRAMES_PER_CHANNEL = 64;

interface RunningChannelRegistry {
  channels: Map<string, RunningEventChannel>;
}

declare global {
  var __pihubRunningEventChannelsV1: RunningChannelRegistry | undefined;
}

function registry(): RunningChannelRegistry {
  if (!globalThis.__pihubRunningEventChannelsV1) {
    globalThis.__pihubRunningEventChannelsV1 = { channels: new Map() };
  }
  return globalThis.__pihubRunningEventChannelsV1;
}

function channelKey(deviceId: string): string {
  return `running:${JSON.stringify(deviceId)}`;
}

function runningEvent(sessionIds: string[]) {
  return { type: "running", runningSessionIds: sessionIds };
}

class RunningEventChannel {
  readonly replay: SseReplayChannel;
  lastUsedAt = Date.now();
  private unsubscribe: (() => void) | null = null;
  private retentionTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(readonly registryKey: string) {
    this.replay = new SseReplayChannel(registryKey, {
      maxReplayBytes: MAX_REPLAY_BYTES_PER_CHANNEL,
      maxReplayFrames: MAX_REPLAY_FRAMES_PER_CHANNEL,
    });
  }

  open(request: Request, options: RunningEventStreamOptions): RunningEventStreamResult {
    this.lastUsedAt = Date.now();
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.retentionTimer = null;

    const opened = this.replay.open(request, {
      connectionGroup: `device:${JSON.stringify(options.deviceId)}`,
      onClose: () => this.connectionClosed(),
    });
    if (!opened.accepted) {
      this.scheduleRetention();
      return opened;
    }

    try {
      this.initialize(opened.connection, request, options);
      return { accepted: true, stream: opened.stream };
    } catch {
      opened.connection.close();
      return { accepted: false, status: 503 };
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.retentionTimer) clearTimeout(this.retentionTimer);
    this.retentionTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.replay.closeAll();
  }

  private initialize(
    connection: SseReplayConnection,
    request: Request,
    options: RunningEventStreamOptions,
  ): void {
    const hadContinuousSource = this.unsubscribe !== null;
    const baselineEventId = this.replay.latestEventId;
    const snapshot = this.ensureSubscribed(options);
    if (connection.closed) return;

    const lastEventId = parseLastEventId(request);
    if (lastEventId === null) {
      if (!connection.send(runningEvent(snapshot))) return;
    } else if (!hadContinuousSource && lastEventId > baselineEventId) {
      if (!connection.send({ type: "replay_reset", reason: "future" })) return;
      if (!connection.send(runningEvent(snapshot))) return;
    } else {
      const replayed = connection.replayAfter(lastEventId);
      if (replayed.status !== "complete") {
        if (!connection.send({ type: "replay_reset", reason: replayed.status })) return;
        if (!connection.send(runningEvent(snapshot))) return;
      }
    }

    if (connection.closed) return;
    connection.activate();
  }

  private ensureSubscribed(options: RunningEventStreamOptions): string[] {
    if (this.unsubscribe) return options.getSnapshot();

    const unsubscribe = options.subscribe((sessionIds) => {
      this.replay.publish(runningEvent(sessionIds));
    });
    this.unsubscribe = unsubscribe;

    try {
      const snapshot = options.getSnapshot();
      this.replay.publish(runningEvent(snapshot));
      return snapshot;
    } catch (error) {
      unsubscribe();
      this.unsubscribe = null;
      throw error;
    }
  }

  private connectionClosed(): void {
    this.lastUsedAt = Date.now();
    if (this.replay.connectionCount > 0) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
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

function getChannel(deviceId: string): RunningEventChannel | null {
  const channels = registry().channels;
  const key = channelKey(deviceId);
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

  const channel = new RunningEventChannel(key);
  channels.set(key, channel);
  return channel;
}

/** Admit one authenticated stream of running-session snapshots. */
export function createRunningEventStream(
  request: Request,
  options: RunningEventStreamOptions,
): RunningEventStreamResult {
  if (request.signal.aborted) return { accepted: false, status: 204 };
  const channel = getChannel(options.deviceId);
  if (!channel) return { accepted: false, status: 503 };
  return channel.open(request, options);
}

export function resetRunningEventChannelsForTests(): void {
  const channels = registry().channels;
  for (const channel of channels.values()) channel.destroy();
  globalThis.__pihubRunningEventChannelsV1 = { channels: new Map() };
}
