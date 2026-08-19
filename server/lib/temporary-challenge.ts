import { randomBytes } from "node:crypto";

const DEFAULT_CHALLENGE_TTL_MS = 5 * 60_000;
const DEFAULT_TOMBSTONE_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_PENDING = 256;
const DEFAULT_MAX_PENDING_PER_DEVICE = 16;
const DEFAULT_MAX_PENDING_PER_SCOPE = 4;
const DEFAULT_MAX_TOMBSTONES = 512;
const DEFAULT_MAX_FLOWS = 64;
const DEFAULT_MAX_FLOWS_PER_DEVICE = 4;
const DEFAULT_MAX_FLOWS_PER_SCOPE = 2;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type TemporaryChallengeConsumeStatus =
  | "consumed"
  | "not_found"
  | "forbidden"
  | "expired"
  | "replayed";

export interface TemporaryChallenge {
  readonly token: string;
  readonly promise: Promise<string>;
  cancel(reason?: Error): void;
}

export interface TemporaryChallengeFlowLease {
  readonly released: boolean;
  release(): void;
}

export interface TemporaryChallengeRegistryOptions {
  challengeTtlMs?: number;
  tombstoneTtlMs?: number;
  maxPending?: number;
  maxPendingPerDevice?: number;
  maxPendingPerScope?: number;
  maxTombstones?: number;
  maxFlows?: number;
  maxFlowsPerDevice?: number;
  maxFlowsPerScope?: number;
  now?: () => number;
  createToken?: () => string;
}

export class TemporaryChallengeCapacityError extends Error {
  constructor() {
    super("Too many pending login requests");
    this.name = "TemporaryChallengeCapacityError";
  }
}

export class TemporaryChallengeError extends Error {
  constructor(
    public readonly code: "cancelled" | "expired" | "reset",
    message: string,
  ) {
    super(message);
    this.name = "TemporaryChallengeError";
  }
}

interface PendingChallenge {
  token: string;
  deviceId: string;
  provider: string;
  scope: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: string): void;
  reject(error: Error): void;
}

interface ChallengeTombstone {
  deviceId: string;
  provider: string;
  status: "consumed" | "expired" | "cancelled";
  expiresAt: number;
}

interface FlowEntry {
  deviceId: string;
  scope: string;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback;
}

function scopeKey(deviceId: string, provider: string): string {
  return JSON.stringify([deviceId, provider]);
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decrement(map: Map<string, number>, key: string): void {
  const value = map.get(key) ?? 0;
  if (value <= 1) map.delete(key);
  else map.set(key, value - 1);
}

/** In-memory, bounded registry for single-use OAuth/manual-input challenges. */
export class TemporaryChallengeRegistry {
  private readonly challengeTtlMs: number;
  private readonly tombstoneTtlMs: number;
  private readonly maxPending: number;
  private readonly maxPendingPerDevice: number;
  private readonly maxPendingPerScope: number;
  private readonly maxTombstones: number;
  private readonly maxFlows: number;
  private readonly maxFlowsPerDevice: number;
  private readonly maxFlowsPerScope: number;
  private readonly now: () => number;
  private readonly createTokenValue: () => string;
  private readonly pending = new Map<string, PendingChallenge>();
  private readonly tombstones = new Map<string, ChallengeTombstone>();
  private readonly pendingByDevice = new Map<string, number>();
  private readonly pendingByScope = new Map<string, number>();
  private readonly flows = new Map<number, FlowEntry>();
  private readonly flowsByDevice = new Map<string, number>();
  private readonly flowsByScope = new Map<string, number>();
  private nextFlowId = 1;

  constructor(options: TemporaryChallengeRegistryOptions = {}) {
    this.challengeTtlMs = positiveInteger(options.challengeTtlMs, DEFAULT_CHALLENGE_TTL_MS);
    this.tombstoneTtlMs = positiveInteger(options.tombstoneTtlMs, DEFAULT_TOMBSTONE_TTL_MS);
    this.maxPending = positiveInteger(options.maxPending, DEFAULT_MAX_PENDING);
    this.maxPendingPerDevice = positiveInteger(
      options.maxPendingPerDevice,
      DEFAULT_MAX_PENDING_PER_DEVICE,
    );
    this.maxPendingPerScope = positiveInteger(
      options.maxPendingPerScope,
      DEFAULT_MAX_PENDING_PER_SCOPE,
    );
    this.maxTombstones = positiveInteger(options.maxTombstones, DEFAULT_MAX_TOMBSTONES);
    this.maxFlows = positiveInteger(options.maxFlows, DEFAULT_MAX_FLOWS);
    this.maxFlowsPerDevice = positiveInteger(
      options.maxFlowsPerDevice,
      DEFAULT_MAX_FLOWS_PER_DEVICE,
    );
    this.maxFlowsPerScope = positiveInteger(
      options.maxFlowsPerScope,
      DEFAULT_MAX_FLOWS_PER_SCOPE,
    );
    this.now = options.now ?? Date.now;
    this.createTokenValue = options.createToken
      ?? (() => randomBytes(32).toString("base64url"));
  }

  create(deviceId: string, provider: string): TemporaryChallenge {
    this.pruneTombstones();
    const scope = scopeKey(deviceId, provider);
    if (
      this.pending.size >= this.maxPending
      || (this.pendingByDevice.get(deviceId) ?? 0) >= this.maxPendingPerDevice
      || (this.pendingByScope.get(scope) ?? 0) >= this.maxPendingPerScope
    ) {
      throw new TemporaryChallengeCapacityError();
    }

    let token = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = this.createTokenValue();
      if (
        TOKEN_PATTERN.test(candidate)
        && !this.pending.has(candidate)
        && !this.tombstones.has(candidate)
      ) {
        token = candidate;
        break;
      }
    }
    if (!token) throw new Error("Unable to allocate a login challenge");

    let resolvePromise!: (value: string) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // A challenge can expire just before the SDK starts awaiting it.
    promise.catch(() => {});

    const expiresAt = this.now() + this.challengeTtlMs;
    const timer = setTimeout(() => this.expire(token), this.challengeTtlMs);
    timer.unref?.();
    const entry: PendingChallenge = {
      token,
      deviceId,
      provider,
      scope,
      expiresAt,
      timer,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    this.pending.set(token, entry);
    increment(this.pendingByDevice, deviceId);
    increment(this.pendingByScope, scope);

    return {
      token,
      promise,
      cancel: (reason = new TemporaryChallengeError("cancelled", "Login cancelled")) => {
        const current = this.pending.get(token);
        if (!current || current !== entry) return;
        this.settle(current, "cancelled", reason);
      },
    };
  }

  consume(
    token: string,
    deviceId: string,
    provider: string,
    value: string,
  ): TemporaryChallengeConsumeStatus {
    this.pruneTombstones();
    if (!TOKEN_PATTERN.test(token)) return "not_found";

    const entry = this.pending.get(token);
    if (entry) {
      if (entry.deviceId !== deviceId || entry.provider !== provider) return "forbidden";
      if (entry.expiresAt <= this.now()) {
        this.settle(
          entry,
          "expired",
          new TemporaryChallengeError("expired", "Login request expired"),
        );
        return "expired";
      }

      // Remove the challenge before resolving user-controlled continuation code.
      this.detach(entry);
      this.addTombstone(entry, "consumed");
      entry.resolve(value);
      return "consumed";
    }

    const tombstone = this.tombstones.get(token);
    if (!tombstone) return "not_found";
    if (tombstone.deviceId !== deviceId || tombstone.provider !== provider) return "forbidden";
    if (tombstone.status === "consumed") return "replayed";
    if (tombstone.status === "expired") return "expired";
    return "not_found";
  }

  acquireFlow(deviceId: string, provider: string): TemporaryChallengeFlowLease | null {
    const scope = scopeKey(deviceId, provider);
    if (
      this.flows.size >= this.maxFlows
      || (this.flowsByDevice.get(deviceId) ?? 0) >= this.maxFlowsPerDevice
      || (this.flowsByScope.get(scope) ?? 0) >= this.maxFlowsPerScope
    ) return null;

    const id = this.nextFlowId++;
    this.flows.set(id, { deviceId, scope });
    increment(this.flowsByDevice, deviceId);
    increment(this.flowsByScope, scope);
    let released = false;
    return {
      get released() { return released; },
      release: () => {
        if (released) return;
        released = true;
        const entry = this.flows.get(id);
        if (!entry) return;
        this.flows.delete(id);
        decrement(this.flowsByDevice, entry.deviceId);
        decrement(this.flowsByScope, entry.scope);
      },
    };
  }

  stats(): { pending: number; tombstones: number; flows: number } {
    this.pruneTombstones();
    return {
      pending: this.pending.size,
      tombstones: this.tombstones.size,
      flows: this.flows.size,
    };
  }

  reset(): void {
    for (const entry of [...this.pending.values()]) {
      this.detach(entry);
      entry.reject(new TemporaryChallengeError("reset", "Login registry reset"));
    }
    this.tombstones.clear();
    this.pendingByDevice.clear();
    this.pendingByScope.clear();
    this.flows.clear();
    this.flowsByDevice.clear();
    this.flowsByScope.clear();
    this.nextFlowId = 1;
  }

  private expire(token: string): void {
    const entry = this.pending.get(token);
    if (!entry) return;
    this.settle(
      entry,
      "expired",
      new TemporaryChallengeError("expired", "Login request expired"),
    );
  }

  private settle(
    entry: PendingChallenge,
    status: "expired" | "cancelled",
    error: Error,
  ): void {
    this.detach(entry);
    this.addTombstone(entry, status);
    entry.reject(error);
  }

  private detach(entry: PendingChallenge): void {
    clearTimeout(entry.timer);
    this.pending.delete(entry.token);
    decrement(this.pendingByDevice, entry.deviceId);
    decrement(this.pendingByScope, entry.scope);
  }

  private addTombstone(
    entry: PendingChallenge,
    status: ChallengeTombstone["status"],
  ): void {
    this.pruneTombstones();
    this.tombstones.set(entry.token, {
      deviceId: entry.deviceId,
      provider: entry.provider,
      status,
      expiresAt: this.now() + this.tombstoneTtlMs,
    });
    while (this.tombstones.size > this.maxTombstones) {
      const oldest = this.tombstones.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tombstones.delete(oldest);
    }
  }

  private pruneTombstones(): void {
    const now = this.now();
    for (const [token, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) this.tombstones.delete(token);
    }
  }
}

interface TemporaryChallengeRuntime {
  registry: TemporaryChallengeRegistry;
}

declare global {
  var __pihubTemporaryChallengeRuntimeV1: TemporaryChallengeRuntime | undefined;
}

function runtimeRegistry(): TemporaryChallengeRegistry {
  if (!globalThis.__pihubTemporaryChallengeRuntimeV1) {
    globalThis.__pihubTemporaryChallengeRuntimeV1 = {
      registry: new TemporaryChallengeRegistry(),
    };
  }
  return globalThis.__pihubTemporaryChallengeRuntimeV1.registry;
}

export function createTemporaryChallenge(
  deviceId: string,
  provider: string,
): TemporaryChallenge {
  return runtimeRegistry().create(deviceId, provider);
}

export function consumeTemporaryChallenge(
  token: string,
  deviceId: string,
  provider: string,
  value: string,
): TemporaryChallengeConsumeStatus {
  return runtimeRegistry().consume(token, deviceId, provider, value);
}

export function acquireTemporaryChallengeFlow(
  deviceId: string,
  provider: string,
): TemporaryChallengeFlowLease | null {
  return runtimeRegistry().acquireFlow(deviceId, provider);
}

export function getTemporaryChallengeStats(): {
  pending: number;
  tombstones: number;
  flows: number;
} {
  return runtimeRegistry().stats();
}

export function resetTemporaryChallengeRuntimeForTests(): void {
  globalThis.__pihubTemporaryChallengeRuntimeV1?.registry.reset();
  globalThis.__pihubTemporaryChallengeRuntimeV1 = {
    registry: new TemporaryChallengeRegistry(),
  };
}
