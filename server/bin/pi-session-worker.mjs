/**
 * Pi Session Worker — runs one AgentSession per child process.
 *
 * Why a separate process per session:
 *   @cortexkit/pi-magic-context guards initialization with a process-level
 *   latch (globalThis[Symbol.for("magic-context.pi.active")]). Its internal
 *   state (SQLite handle, ctxReduceRegisteredGlobally, dreamer registry) is
 *   module-level, so two sessions in one process either collide or — as the
 *   latch enforces — the second one silently skips extension registration.
 *   One process per session makes the single-instance assumption hold.
 *
 * Protocol (parent <-> worker), all over Node IPC:
 *   parent -> worker: { id, kind: "command", command }        → { id, kind: "result", result }
 *                     { id, kind: "shutdown" }                → { id, kind: "result" }
 *                     { id, kind: "init", config }            → { id, kind: "ready", sessionId, sessionFile, cwd }
 *   worker -> parent: { kind: "event", event }                  (unsolicited, streamed)
 *                     { id, kind: "error", message, code }
 *
 * The worker never writes to stdout/stderr on the happy path; the parent
 * forwards those streams for debugging only.
 */

import { createJiti } from "jiti";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Use this file as jiti's filename anchor so relative imports resolve correctly
const jiti = createJiti(join(here, "pi-session-worker.mjs"), {
  alias: { "@": join(here, "..") },
  interopDefault: true,
});

/** @typedef {{ sessionId: string; sessionFile: string; cwd: string | undefined; ownerId: string; toolNames?: string[]; initialModel?: { provider: string; modelId: string }; thinkingLevel?: string; startupTimeoutMs?: number }} WorkerInitConfig */

/** @type {import("../lib/rpc-manager.ts").AgentSessionWrapper | null} */
let session = null;

function send(message) {
  if (!process.send) return;
  try {
    process.send(message);
  } catch {
    // Parent went away mid-write; the exit handler tears the session down.
  }
}

function serializeError(error) {
  if (error instanceof Error) {
    const code = /** @type {{ code?: unknown }} */ (error).code;
    return {
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { message: String(error) };
}

async function handleInit(id, config) {
  const { startRpcSessionInProcess } = await jiti.import("../lib/rpc-manager.ts");

  const started = await startRpcSessionInProcess(
    config.sessionId,
    config.sessionFile,
    config.cwd,
    {
      ownerId: config.ownerId,
      ...(config.toolNames !== undefined ? { toolNames: config.toolNames } : {}),
      ...(config.initialModel ? { initialModel: config.initialModel } : {}),
      ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
      ...(config.startupTimeoutMs ? { startupTimeoutMs: config.startupTimeoutMs } : {}),
    },
  );

  session = started.session;

  // Stream every agent event to the parent. The parent re-emits these to its
  // own listeners so SSE routes behave exactly as they do in-process.
  session.onEvent((event) => {
    send({ kind: "event", event });
  });

  // A session that dies on its own (idle timeout, extension failure) must tell
  // the parent, otherwise the parent's registry keeps a dead entry.
  session.onDestroy(() => {
    send({ kind: "destroyed" });
  });

  send({
    id,
    kind: "ready",
    sessionId: started.realSessionId,
    sessionFile: session.sessionFile,
    cwd: session.cwd,
  });
}

async function handleCommand(id, command) {
  if (!session) throw new Error("Worker received a command before init");
  const result = await session.send(command);
  send({ id, kind: "result", result: result ?? null });
}

async function handleShutdown(id) {
  if (session) await session.shutdown();
  send({ id, kind: "result", result: null });
  // Give the IPC write a tick to flush before the event loop drains.
  setTimeout(() => process.exit(0), 0);
}

process.on("message", (raw) => {
  const message = /** @type {{ id?: string; kind: string; [key: string]: unknown }} */ (raw);
  const id = typeof message.id === "string" ? message.id : "";

  void (async () => {
    try {
      switch (message.kind) {
        case "init":
          await handleInit(id, /** @type {WorkerInitConfig} */ (message.config));
          break;
        case "command":
          await handleCommand(id, /** @type {Record<string, unknown>} */ (message.command));
          break;
        case "shutdown":
          await handleShutdown(id);
          break;
        default:
          throw new Error(`Unknown worker message kind: ${message.kind}`);
      }
    } catch (error) {
      send({ id, kind: "error", ...serializeError(error) });
    }
  })();
});

// The parent closing the IPC channel means it is gone; do not linger.
process.on("disconnect", () => {
  void (async () => {
    try {
      await session?.shutdown();
    } finally {
      process.exit(0);
    }
  })();
});

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  process.once(signal, () => {
    void (async () => {
      try {
        await session?.shutdown();
      } finally {
        process.exit(0);
      }
    })();
  });
}

// Tell the parent the worker module is loaded and ready to receive init.
send({ kind: "booted" });
