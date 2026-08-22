/**
 * IPC-based RPC Manager Adapter
 *
 * Wraps PiLauncher to provide the same interface as AgentSessionWrapper,
 * enabling out-of-process Pi Agent while the rest of the app stays unchanged.
 *
 * Enable:  PIHUB_USE_IPC=1
 * Disable: PIHUB_LEGACY_MODE=1  (or omit PIHUB_USE_IPC)
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { randomUUID } from "crypto";
import { PiLauncher, launchPiSession, type SessionConfig } from "./pi-launcher";
import type { AgentEvent } from "./rpc-manager";
import {
  bindSessionOwner,
  getSessionOwner,
  SessionOwnershipConflictError,
} from "./session-ownership";
import type { AgentSessionWrapper } from "./rpc-manager";

export interface RpcSessionStartOptions {
  ownerId: string;
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  startupTimeoutMs?: number;
}

export type RpcSessionLifecycleState = "starting" | "ready" | "draining" | "closed" | "failed";

export class RpcSessionLifecycleError extends Error {
  constructor(
    readonly code: "NOT_READY" | "DRAINING" | "CLOSED" | "START_ABORTED" | "START_TIMEOUT" | "SHUTDOWN_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "RpcSessionLifecycleError";
  }
}

type EventListener = (event: AgentEvent) => void;

// ── Minimal stub for session.inner ──────────────────────────────────────────
// Routes that access .inner fall back to this object so they don't crash.
// Fields are populated from IPC state responses where possible.

function makeInnerStub(
  sessionId: string,
  sendCommand: (type: string, payload?: Record<string, unknown>) => Promise<unknown>,
) {
  return {
    sessionId,
    sessionFile: undefined as string | undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    agent: { state: null as unknown },
    sessionManager: {
      getCwd: () => "",
      getBranch: () => [] as unknown[],
    } as unknown,
    extensionRunner: {} as unknown,
    getAllTools: () => [] as unknown[],
    // Auto-name route calls these two
    setSessionName: (name: string) => {
      void sendCommand("set_session_name", { name });
    },
    dispose: () => {},
  };
}

// ── IpcAgentSessionWrapper ──────────────────────────────────────────────────

export class IpcAgentSessionWrapper {
  private launcher: PiLauncher | null = null;
  private listeners: EventListener[] = [];
  private _lifecycleState: RpcSessionLifecycleState;
  private _alive = true;
  private disposed = false;
  private onDestroyCallback: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;

  /** Satisfies callers that do `session.inner.sessionManager` or `session.inner.setSessionName` */
  readonly inner: ReturnType<typeof makeInnerStub>;

  constructor(
    public readonly sessionId: string,
    private readonly _sessionFile: string,
    private readonly _cwd: string,
    public readonly ownerId: string,
    private readonly options: RpcSessionStartOptions,
  ) {
    this._lifecycleState = "starting";
    this.inner = makeInnerStub(sessionId, (type, payload) =>
      this.send({ type, ...payload }),
    );
  }

  get lifecycleState(): RpcSessionLifecycleState {
    return this._lifecycleState;
  }

  get sessionFile(): string {
    return this._sessionFile;
  }

  get cwd(): string {
    return this._cwd;
  }

  /** Satisfies `agent-event-stream.ts` which reads `session.streamingMessage` */
  get streamingMessage(): unknown {
    return null;
  }

  isAlive(): boolean {
    return this._alive && (this._lifecycleState === "starting" || this._lifecycleState === "ready");
  }

  isRunning(): boolean {
    return this.isAlive() && this.launcher?.isAlive() === true;
  }

  // ── Startup ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.launcher) throw new Error("Session already started");

    const config: SessionConfig = {
      sessionId: this.sessionId,
      sessionFile: this._sessionFile || undefined,
      cwd: this._cwd,
      toolNames: this.options.toolNames,
      initialModel: this.options.initialModel,
      thinkingLevel: this.options.thinkingLevel as string | undefined,
    };

    try {
      this.launcher = await launchPiSession(config);

      this.launcher.on("*", (data) => {
        this.emit(data as AgentEvent);
      });

      this._lifecycleState = "ready";
    } catch (error) {
      this._lifecycleState = "failed";
      this._alive = false;
      throw error;
    }
  }

  /** Called by auto-name route as `await session.waitUntilReady?.()` */
  async waitUntilReady(_signal?: AbortSignal): Promise<void> {
    if (this._lifecycleState === "ready") return;
    if (this._lifecycleState !== "starting") {
      throw new RpcSessionLifecycleError("CLOSED", "Session is not starting");
    }
    // IPC sessions are synchronously ready after start(); just wait a tick.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch (err) {
        console.error(`[ipc-rpc] event delivery error for ${event.type}:`, err);
      }
    }
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

  // ── Command dispatch ──────────────────────────────────────────────────────

  /**
   * send() is the single dispatch point for all 25 agent commands.
   *
   * Commands that have a direct IPC mapping (prompt, get_state) are handled
   * locally. Everything else is forwarded to Pi via "session:command".
   */
  async send(command: Record<string, unknown>): Promise<unknown> {
    if (this._lifecycleState === "starting") {
      throw new RpcSessionLifecycleError("NOT_READY", "Session is still starting");
    }
    if (this._lifecycleState !== "ready") {
      throw new RpcSessionLifecycleError("CLOSED", "Session is closed");
    }
    if (!this.launcher) throw new Error("Pi launcher not initialized");

    const type = command.type as string;

    switch (type) {
      // ── Commands with local IPC mapping ──────────────────────────────────

      case "prompt":
      case "steer":
      case "follow_up": {
        return this.launcher.sendRequest("session:message", {
          sessionId: this.sessionId,
          content: (command.message ?? command.content ?? "") as string,
          images: command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined,
        });
      }

      case "abort":
      case "abort_bash":
      case "abort_compaction": {
        return this.launcher.sendRequest("session:stop", { sessionId: this.sessionId });
      }

      case "get_state": {
        const status = await this.launcher.sendRequest("agent:status", {});
        const s = status as Record<string, unknown>;
        return {
          sessionId: this.sessionId,
          sessionFile: this._sessionFile,
          cwd: this._cwd,
          isStreaming: s.isStreaming ?? false,
          isPromptRunning: s.isPromptRunning ?? false,
          isBashRunning: s.isBashRunning ?? false,
          isCompacting: s.isCompacting ?? false,
          autoCompactionEnabled: s.autoCompactionEnabled ?? true,
          autoRetryEnabled: s.autoRetryEnabled ?? true,
          model: s.model ?? null,
          thinkingLevel: s.thinkingLevel ?? null,
        };
      }

      case "get_tools":
      case "get_commands":
      case "get_last_assistant_text":
      case "get_session_stats":
      case "bash":
      case "compact":
      case "clear_queue":
      case "extension_ui_input":
      case "extension_ui_response":
      case "fork":
      case "navigate_tree":
      case "reload":
      case "set_auto_compaction":
      case "set_auto_retry":
      case "set_model":
      case "set_session_name":
      case "set_thinking_level":
      case "set_tools": {
        // Forward to Pi via generic command channel
        return this.launcher.sendRequest("session:command", {
          sessionId: this.sessionId,
          command,
        });
      }

      default: {
        return this.launcher.sendRequest("session:command", {
          sessionId: this.sessionId,
          command,
        });
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  destroy(finalState: "closed" | "failed" = "closed"): void {
    if (this.disposed) return;
    this.disposed = true;
    this._alive = false;
    this._lifecycleState = finalState;

    this.launcher?.stop().catch((err) => {
      console.error("[ipc-rpc] stop error:", err);
    });

    try { this.onDestroyCallback?.(); } catch (err) {
      console.error("[ipc-rpc] destroy callback error:", err);
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.disposed || this._lifecycleState === "closed" || this._lifecycleState === "failed") return;

    this._lifecycleState = "draining";
    this._alive = false;

    this.shutdownPromise = (async () => {
      try { await this.launcher?.stop(); } finally { this.destroy(); }
    })();

    return this.shutdownPromise;
  }
}

// ── Registry: reuses the same __piSessions map as the in-process code ────────
// This means getRpcSession() from rpc-manager.ts finds IPC sessions too.

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

// ── startIpcRpcSession ────────────────────────────────────────────────────────

export async function startIpcRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions,
): Promise<{ session: IpcAgentSessionWrapper; realSessionId: string }> {
  const { ownerId, signal } = options;

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
  const existing = registry.get(sessionId) as IpcAgentSessionWrapper | undefined;
  if (existing?.isAlive()) {
    if (existing.ownerId !== ownerId) throw new SessionOwnershipConflictError("Session ownership mismatch");
    return { session: existing, realSessionId: sessionId };
  }

  if (!cwd) throw new Error("cwd is required for a new session");

  const wrapper = new IpcAgentSessionWrapper(sessionId, sessionFile, cwd, ownerId, options);

  if (!sessionFile) await bindSessionOwner(sessionId, ownerId);

  await wrapper.start();

  wrapper.onDestroy(() => {
    if (registry.get(sessionId) === (wrapper as unknown as AgentSessionWrapper)) {
      registry.delete(sessionId);
    }
  });
  registry.set(sessionId, wrapper as unknown as AgentSessionWrapper);

  return { session: wrapper, realSessionId: sessionId };
}
