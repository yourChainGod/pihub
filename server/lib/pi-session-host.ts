/**
 * Pi Session Host — parent-side manager for process-isolated Pi sessions.
 *
 * Each session runs in a forked child process (bin/pi-session-worker.mjs) so
 * that @cortexkit/pi-magic-context's process-level latch never blocks a second
 * session. This file owns the fork lifecycle, IPC proxy, and registration in
 * the shared __piSessions registry so every existing getRpcSession() caller
 * works without changes.
 *
 * Enabled by default; PIHUB_SESSION_WORKER=0 forces the legacy in-process path.
 */

import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  notifyRunningChange,
  RpcSessionLifecycleError,
  type AgentSessionWrapper,
  type RpcSessionStartOptions,
  type AgentEvent,
} from "./rpc-manager";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import {
  bindSessionOwner,
  getSessionOwner,
  removeSessionOwner,
  SessionOwnershipConflictError,
} from "./session-ownership";

// ── constants ────────────────────────────────────────────────────────────────

// Resolved lazily from PIHUB_SERVER_ROOT (set by the supervisor) rather than
// import.meta.url: Next.js inlines import.meta.url as a compile-time absolute
// path, which the portable-build privacy normalizer must never see.
function resolveWorkerScript(): string {
  const root = process.env.PIHUB_SERVER_ROOT?.trim() || process.cwd();
  const script = resolve(root, "bin", "pi-session-worker.mjs");
  if (!existsSync(script)) throw new Error(`Session worker script not found: ${script}`);
  return script;
}
const BOOT_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

// ── types ────────────────────────────────────────────────────────────────────

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type EventListener = (event: AgentEvent) => void;

// ── ProcessIsolatedSessionWrapper ─────────────────────────────────────────────

export class ProcessIsolatedSessionWrapper {
  private child: ChildProcess | null = null;
  private pendingCalls = new Map<string, PendingCall>();
  private listeners: EventListener[] = [];
  private onDestroyCallback: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private _alive = true;
  private disposed = false;
  private _lifecycleState: "starting" | "ready" | "draining" | "closed" | "failed" = "starting";
  private _isRunning = false;

  // Public fields that match AgentSessionWrapper's signature
  readonly ownerId: string;

  // Resolved by init — real sessionId and file come from the worker
  private _sessionId: string;
  private _sessionFile = "";
  private _cwd = "";

  // Minimal inner stub so routes that do `session.inner.sessionManager` don't crash
  readonly inner: {
    sessionId: string;
    sessionFile: string | undefined;
    isStreaming: boolean;
    isCompacting: boolean;
    isBashRunning: boolean;
    agent: { state: null };
    sessionManager: { getCwd: () => string; getBranch: () => unknown[] };
    extensionRunner: Record<string, unknown>;
    getAllTools: () => unknown[];
    setSessionName: (name: string) => void;
    dispose: () => void;
  };

  constructor(requestedSessionId: string, ownerId: string) {
    this._sessionId = requestedSessionId;
    this.ownerId = ownerId;

    // Build inner stub — properties are filled in after the worker confirms init.
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the stub's own `this` differs from the wrapper.
    const self = this;
    this.inner = {
      get sessionId() { return self._sessionId; },
      get sessionFile() { return self._sessionFile || undefined; },
      isStreaming: false,
      isCompacting: false,
      isBashRunning: false,
      agent: { state: null },
      sessionManager: {
        getCwd: () => self._cwd,
        getBranch: () => [],
      },
      extensionRunner: {},
      getAllTools: () => [],
      setSessionName: (name: string) => { void self.send({ type: "set_session_name", name }); },
      dispose: () => { self.destroy(); },
    };
  }

  // ── public getters ────────────────────────────────────────────────────────

  get sessionId(): string { return this._sessionId; }
  get sessionFile(): string { return this._sessionFile; }
  get cwd(): string { return this._cwd; }
  get lifecycleState() { return this._lifecycleState; }
  get streamingMessage(): unknown { return null; }

  isAlive(): boolean {
    return this._alive && (this._lifecycleState === "starting" || this._lifecycleState === "ready");
  }

  isRunning(): boolean {
    return this.isAlive() && this._isRunning;
  }

  // ── init ──────────────────────────────────────────────────────────────────

  async init(config: {
    sessionFile: string;
    cwd: string | undefined;
    toolNames?: string[];
    initialModel?: { provider: string; modelId: string };
    thinkingLevel?: string;
    startupTimeoutMs?: number;
  }): Promise<{ realSessionId: string }> {
    const child = fork(resolveWorkerScript(), [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        PIHUB_IS_SESSION_WORKER: "1",
        // Prevent the worker from seeing PIHUB_SESSION_WORKER so it uses the
        // in-process path without recursing.
        PIHUB_SESSION_WORKER: "0",
      },
    });

    this.child = child;

    // Forward worker stdout/stderr only in debug mode
    if (process.env.DEBUG?.includes("pihub:worker")) {
      child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[worker ${child.pid}] ${d}`));
      child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[worker ${child.pid}] err ${d}`));
    }

    // Handle unexpected worker exit
    child.on("exit", (code, signal) => {
      this.handleWorkerExit(code ?? undefined, signal ?? undefined);
    });

    // Route IPC messages
    child.on("message", (raw) => this.handleWorkerMessage(raw));

    // Wait for worker to signal it has loaded
    await this.waitForBoot();

    // Send init and wait for ready
    const initId = randomUUID();
    const ready = await this.callWorker(initId, { kind: "init", id: initId, config: {
      sessionId: this._sessionId,
      sessionFile: config.sessionFile,
      cwd: config.cwd,
      ownerId: this.ownerId,
      toolNames: config.toolNames,
      initialModel: config.initialModel,
      thinkingLevel: config.thinkingLevel,
      startupTimeoutMs: config.startupTimeoutMs,
    }}, config.startupTimeoutMs ?? 60_000) as {
      sessionId: string;
      sessionFile: string;
      cwd: string;
    };

    // Adopt real session identity from worker
    this._sessionId = ready.sessionId;
    this._sessionFile = ready.sessionFile ?? "";
    this._cwd = ready.cwd ?? "";
    this._lifecycleState = "ready";

    return { realSessionId: this._sessionId };
  }

  // ── IPC helpers ───────────────────────────────────────────────────────────

  private waitForBoot(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error("Worker not started")); return; }

      const timeout = setTimeout(() => {
        reject(new Error("Worker did not boot within timeout"));
      }, BOOT_TIMEOUT_MS);

      const onMessage = (raw: unknown) => {
        const msg = raw as Record<string, unknown>;
        if (msg.kind === "booted") {
          clearTimeout(timeout);
          this.child!.off("message", onMessage);
          resolve();
        }
      };

      this.child.on("message", onMessage);
    });
  }

  private callWorker(id: string, message: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child?.connected) {
        reject(new Error("Worker not connected"));
        return;
      }

      const timeout = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`Worker call timeout: ${String(message.kind)}`));
      }, timeoutMs);

      this.pendingCalls.set(id, { resolve, reject, timeout });
      this.child.send(message);
    });
  }

  private handleWorkerMessage(raw: unknown): void {
    const msg = raw as Record<string, unknown>;

    // Solicited reply
    if (typeof msg.id === "string" && msg.id) {
      const pending = this.pendingCalls.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingCalls.delete(msg.id);
        if (msg.kind === "error") {
          pending.reject(Object.assign(
            new Error(String(msg.message ?? "Worker error")),
            typeof msg.code === "string" ? { code: msg.code } : {},
          ));
        } else {
          pending.resolve(msg.kind === "ready" ? msg : msg.result);
        }
        return;
      }
    }

    // Unsolicited event stream
    if (msg.kind === "event") {
      const event = msg.event as AgentEvent;
      // Track running state from standard event types
      const RUNNING_START = new Set(["agent_start", "auto_compaction_start", "compaction_start"]);
      const RUNNING_END = new Set(["agent_end", "agent_settled", "auto_compaction_end", "compaction_end"]);
      if (RUNNING_START.has(event.type)) this._isRunning = true;
      if (RUNNING_END.has(event.type)) { this._isRunning = false; }
      if (event.type === "agent_end") invalidateSessionListCache();

      for (const listener of this.listeners) {
        try { listener(event); } catch (err) {
          console.error(`[session-host] event listener error (${event.type}):`, err);
        }
      }
      notifyRunningChange();
      return;
    }

    // Worker signalled it destroyed itself (idle timeout, extension failure)
    if (msg.kind === "destroyed") {
      this.destroy("failed");
    }
  }

  private handleWorkerExit(code?: number, signal?: string): void {
    // Reject all pending calls
    for (const [id, pending] of this.pendingCalls) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Worker exited (code=${code ?? "?"}, signal=${signal ?? "?"})`));
      this.pendingCalls.delete(id);
    }
    if (this._lifecycleState !== "closed" && this._lifecycleState !== "failed") {
      this.destroy(code === 0 ? "closed" : "failed");
    }
  }

  // ── command dispatch ──────────────────────────────────────────────────────

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (this._lifecycleState === "starting") {
      throw new RpcSessionLifecycleError("NOT_READY", "Session is still starting");
    }
    if (this._lifecycleState !== "ready") {
      throw new RpcSessionLifecycleError("CLOSED", "Session is closed");
    }
    if (!this.child?.connected) throw new Error("Worker not connected");

    const id = randomUUID();
    return this.callWorker(id, { kind: "command", id, command }, 120_000);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** waitUntilReady — satisfies auto-name route */
  async waitUntilReady(_signal?: AbortSignal): Promise<void> {
    if (this._lifecycleState === "ready") return;
    if (this._lifecycleState !== "starting") {
      throw new RpcSessionLifecycleError("CLOSED", "Session is not starting");
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onEvent(listener: EventListener): () => void {
    return this.subscribe(listener);
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  destroy(finalState: "closed" | "failed" = "closed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this._alive = false;
    this._lifecycleState = finalState;

    // Kill child
    if (this.child?.connected) {
      try { this.child.send({ kind: "shutdown", id: randomUUID() }); } catch { /* ignore */ }
    }
    setTimeout(() => {
      if (this.child && !this.child.killed) {
        try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
      }
    }, DEFAULT_SHUTDOWN_TIMEOUT_MS);

    try { this.onDestroyCallback?.(); } catch (err) {
      console.error("[session-host] destroy callback error:", err);
    }
    notifyRunningChange();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.disposed || this._lifecycleState === "closed" || this._lifecycleState === "failed") return;

    this._lifecycleState = "draining";
    this._alive = false;

    this.shutdownPromise = new Promise<void>((resolve) => {
      if (!this.child?.connected) { this.destroy(); resolve(); return; }

      const id = randomUUID();
      const timer = setTimeout(() => {
        try { this.child?.kill("SIGTERM"); } catch { /* ignore */ }
        this.destroy();
        resolve();
      }, DEFAULT_SHUTDOWN_TIMEOUT_MS);

      this.pendingCalls.set(id, {
        resolve: () => { clearTimeout(timer); this.destroy(); resolve(); },
        reject:  () => { clearTimeout(timer); this.destroy(); resolve(); },
        timeout: timer,
      });

      try {
        this.child.send({ kind: "shutdown", id });
      } catch {
        clearTimeout(timer);
        this.pendingCalls.delete(id);
        this.destroy();
        resolve();
      }
    });

    return this.shutdownPromise;
  }
}

// ── shared registry (reuses __piSessions) ────────────────────────────────────

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
}

function getSharedRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

// ── startWorkerRpcSession ─────────────────────────────────────────────────────

export async function startWorkerRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions,
): Promise<{ session: ProcessIsolatedSessionWrapper; realSessionId: string }> {
  const { ownerId, signal, startupTimeoutMs } = options;

  if (!ownerId || ownerId.length > 256 || /[\0\r\n]/.test(ownerId)) {
    throw new TypeError("RPC session requires an authenticated owner");
  }
  if (signal?.aborted) {
    throw new RpcSessionLifecycleError("START_ABORTED", "Session startup was cancelled");
  }
  if (sessionFile && getSessionOwner(sessionId) !== ownerId) {
    throw new SessionOwnershipConflictError("Session ownership mismatch");
  }

  const registry = getSharedRegistry();

  // Re-use an existing alive session
  const existing = registry.get(sessionId) as ProcessIsolatedSessionWrapper | AgentSessionWrapper | undefined;
  if (existing?.isAlive()) {
    if (existing.ownerId !== ownerId) throw new SessionOwnershipConflictError("Session ownership mismatch");
    return { session: existing as ProcessIsolatedSessionWrapper, realSessionId: sessionId };
  }

  if (!cwd && !sessionFile) throw new Error("cwd is required for a new session");

  const wrapper = new ProcessIsolatedSessionWrapper(sessionId, ownerId);

  const { realSessionId } = await wrapper.init({
    sessionFile,
    cwd,
    toolNames: options.toolNames,
    initialModel: options.initialModel,
    thinkingLevel: options.thinkingLevel as string | undefined,
    startupTimeoutMs,
  });

  // Ownership must bind the real session id, which the SDK assigns during
  // init — binding the caller's temporary key (e.g. "__new__<uuid>") is both
  // invalid and useless. Bind before the session becomes visible in the
  // registry, and roll back on abort so a retry never hits a stale record.
  if (!sessionFile) {
    try {
      await bindSessionOwner(realSessionId, ownerId);
    } catch (error) {
      wrapper.destroy("failed");
      throw error;
    }
  }

  // Cancel if the caller aborted during startup
  if (signal?.aborted) {
    wrapper.destroy("failed");
    if (!sessionFile) await removeSessionOwner(realSessionId, ownerId).catch(() => {});
    throw new RpcSessionLifecycleError("START_ABORTED", "Session startup was cancelled");
  }

  // Register in shared registry so getRpcSession() finds it
  if (wrapper.sessionFile) cacheSessionPath(realSessionId, wrapper.sessionFile);
  wrapper.onDestroy(() => {
    if (registry.get(realSessionId) === (wrapper as unknown as AgentSessionWrapper)) {
      registry.delete(realSessionId);
    }
  });
  registry.set(realSessionId, wrapper as unknown as AgentSessionWrapper);
  invalidateSessionListCache();
  notifyRunningChange();

  return { session: wrapper, realSessionId };
}
