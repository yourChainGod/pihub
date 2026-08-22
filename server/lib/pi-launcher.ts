import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import type {
  IpcMessage,
  IpcRequest,
  IpcResponse,
  IpcMessageType,
  PiServerProtocol,
} from "./pi-server-protocol";

export interface SessionConfig {
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: string;
  env?: NodeJS.ProcessEnv;
}

type PendingRequest = {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_IPC_TIMEOUT = 10_000;
const MAX_RETRIES = 3;

/**
 * PiLauncher - Manages out-of-process Pi Agent instances
 *
 * This class spawns Pi Agent as a separate Node.js process and communicates
 * via IPC channel, replacing the old in-process AgentRuntime.create() approach.
 */
export class PiLauncher {
  private process: ChildProcess | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private eventListeners = new Map<string, Array<(data: unknown) => void>>();
  private ready = false;
  private closed = false;

  constructor(private readonly config: SessionConfig) {}

  /**
   * Find Pi executable in the system
   * Priority: 1. PIHUB_PI_EXECUTABLE env, 2. global `pi`, 3. bundled fallback
   */
  private async findPiExecutable(): Promise<string> {
    // 1. Environment variable override
    const envPath = process.env.PIHUB_PI_EXECUTABLE?.trim();
    if (envPath && existsSync(envPath)) {
      return resolve(envPath);
    }

    // 2. Global `pi` command
    const globalPi = platform() === "win32" ? "pi.cmd" : "pi";
    try {
      const { execFileSync } = await import("node:child_process");
      const which = platform() === "win32" ? "where" : "which";
      const output = execFileSync(which, [globalPi], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (output && existsSync(output.split("\n")[0])) {
        return output.split("\n")[0];
      }
    } catch {
      // `which pi` failed, try next method
    }

    // 3. Fallback: error (require explicit installation)
    throw new Error(
      "Pi Agent not found. Please install via: npm install -g @earendil-works/pi-coding-agent",
    );
  }

  /**
   * Launch Pi Agent process with IPC channel
   */
  async launch(): Promise<void> {
    if (this.process) {
      throw new Error("Pi process already launched");
    }
    if (this.closed) {
      throw new Error("Launcher is closed");
    }

    const piPath = await this.findPiExecutable();

    // Spawn Pi in server mode with IPC
    this.process = spawn(piPath, ["--server-mode", "--ipc"], {
      cwd: this.config.cwd,
      env: {
        ...process.env,
        ...this.config.env,
        // Pass session config via env for Pi to pick up
        PIHUB_SESSION_ID: this.config.sessionId,
        PIHUB_SESSION_FILE: this.config.sessionFile ?? "",
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    this.setupIpcHandlers();
    this.setupProcessHandlers();

    // Wait for Pi to signal ready
    await this.waitForReady();
  }

  private setupIpcHandlers(): void {
    if (!this.process) return;

    this.process.on("message", (message: unknown) => {
      try {
        const msg = message as IpcMessage;

        if (msg.type === "response") {
          const response = msg as IpcResponse;
          const pending = this.pendingRequests.get(response.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(new Error(response.error));
            } else {
              pending.resolve(response.payload);
            }
          }
        } else if (msg.type === "event") {
          // Forward events to listeners
          const listeners = this.eventListeners.get(msg.event) ?? [];
          for (const listener of listeners) {
            try {
              listener(msg.data);
            } catch (error) {
              console.error("[pi-launcher] Event listener error:", error);
            }
          }

          // Special: "ready" event
          if (msg.event === "ready") {
            this.ready = true;
          }
        }
      } catch (error) {
        console.error("[pi-launcher] Failed to process IPC message:", error);
      }
    });
  }

  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on("error", (error) => {
      console.error("[pi-launcher] Pi process error:", error);
      this.handleProcessExit(1, "error");
    });

    this.process.on("exit", (code, signal) => {
      this.handleProcessExit(code ?? 0, signal ?? "exit");
    });

    // Forward stdout/stderr for debugging
    this.process.stdout?.on("data", (chunk) => {
      if (process.env.DEBUG?.includes("pihub:pi")) {
        console.log("[pi-stdout]", chunk.toString());
      }
    });

    this.process.stderr?.on("data", (chunk) => {
      if (process.env.DEBUG?.includes("pihub:pi")) {
        console.error("[pi-stderr]", chunk.toString());
      }
    });
  }

  private handleProcessExit(code: number, signal: string): void {
    this.closed = true;
    this.ready = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Pi process exited: code=${code}, signal=${signal}`));
      this.pendingRequests.delete(id);
    }

    // Clear listeners
    this.eventListeners.clear();
  }

  private async waitForReady(timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ready) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error("Pi process did not signal ready within timeout"));
      }, timeoutMs);

      const checkReady = setInterval(() => {
        if (this.ready) {
          clearTimeout(timeout);
          clearInterval(checkReady);
          resolve();
        }
        if (this.closed) {
          clearTimeout(timeout);
          clearInterval(checkReady);
          reject(new Error("Pi process closed before signaling ready"));
        }
      }, 100);
    });
  }

  /**
   * Send IPC request to Pi process
   */
  async sendRequest<T extends IpcMessageType>(
    method: T,
    payload: PiServerProtocol[T]["request"],
    timeoutMs = DEFAULT_IPC_TIMEOUT,
  ): Promise<PiServerProtocol[T]["response"]> {
    if (!this.process || this.closed) {
      throw new Error("Pi process not running");
    }
    if (!this.ready) {
      throw new Error("Pi process not ready");
    }

    const requestId = randomUUID();
    const request: IpcRequest<T> = {
      id: requestId,
      type: "request",
      method,
      payload,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`IPC request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (response: unknown) => void,
        reject,
        timeout,
      });

      try {
        this.process!.send(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  /**
   * Subscribe to Pi events
   */
  on(event: string, listener: (data: unknown) => void): () => void {
    const listeners = this.eventListeners.get(event) ?? [];
    listeners.push(listener);
    this.eventListeners.set(event, listeners);

    return () => {
      const current = this.eventListeners.get(event) ?? [];
      const index = current.indexOf(listener);
      if (index >= 0) current.splice(index, 1);
    };
  }

  /**
   * Gracefully stop Pi process
   */
  async stop(timeoutMs = 5_000): Promise<void> {
    if (!this.process || this.closed) return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if graceful shutdown times out
        this.process?.kill("SIGKILL");
        resolve();
      }, timeoutMs);

      this.process!.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      // Send graceful shutdown signal
      try {
        this.sendRequest("session:stop", {
          sessionId: this.config.sessionId,
        }).catch(() => {
          // Ignore errors during shutdown
        });
      } catch {
        // If IPC fails, force kill
        this.process?.kill("SIGTERM");
      }
    });
  }

  /**
   * Check if Pi process is alive
   */
  isAlive(): boolean {
    return !this.closed && this.ready && this.process !== null;
  }

  /**
   * Get Pi process PID (for debugging)
   */
  getPid(): number | undefined {
    return this.process?.pid;
  }
}

/**
 * Factory function to create and launch a Pi session
 */
export async function launchPiSession(config: SessionConfig): Promise<PiLauncher> {
  const launcher = new PiLauncher(config);
  await launcher.launch();
  return launcher;
}
