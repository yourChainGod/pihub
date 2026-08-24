"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createServerRuntimeEnvironment } = require("./server-runtime-environment");

const SERVER_UPDATE_IPC_PROTOCOL = "pihub-server-update-v1";
const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
const ACTIVE_UPDATE_PHASES = new Set(["recovering", "queued", "applying", "restarting"]);
const CHILD_STOP_TIMEOUT_MS = 5_000;
const CHILD_FORCE_STOP_TIMEOUT_MS = 2_000;
const LOG_CLOSE_TIMEOUT_MS = 2_000;
const STARTUP_HEALTH_TIMEOUT_MS = 30_000;
const MAX_HEALTH_BODY_BYTES = 8 * 1024;
const { INTERNAL_NEXT_SENTINEL } = require("./runtime-entry");

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUpdateRequest(value) {
  return isRecord(value)
    && Object.keys(value).length === 4
    && value.protocol === SERVER_UPDATE_IPC_PROTOCOL
    && value.type === "request"
    && typeof value.requestId === "string"
    && REQUEST_ID_PATTERN.test(value.requestId)
    && (value.command === "status" || value.command === "apply");
}

function safeErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "update_failed";
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "update_failed";
}

function packageVersion(packageRoot) {
  const metadataPath = path.join(packageRoot, "package.json");
  const info = fs.lstatSync(metadataPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) {
    throw new Error("PiHub Server package metadata is invalid");
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  if (metadata?.name !== "@pihub/server" || typeof metadata.version !== "string") {
    throw new Error("PiHub Server package identity is invalid");
  }
  return metadata.version;
}

function resolveNextBin(packageRoot) {
  const candidates = [];
  try {
    candidates.push(require.resolve("next/dist/bin/next", { paths: [packageRoot] }));
  } catch { /* validated below */ }
  try {
    const nextPackage = require.resolve("next/package.json", { paths: [packageRoot] });
    candidates.push(path.join(path.dirname(nextPackage), "dist", "bin", "next"));
  } catch { /* validated below */ }
  candidates.push(path.join(packageRoot, "node_modules", "next", "dist", "bin", "next"));
  for (const candidate of candidates) {
    try {
      const info = fs.lstatSync(candidate);
      if (info.isFile() && !info.isSymbolicLink()) return candidate;
    } catch { /* try the next exact candidate */ }
  }
  throw new Error("PiHub Server release does not contain the Next.js runtime");
}

function resolveRuntimeEntry(packageRoot) {
  const candidate = path.join(packageRoot, "bin", "runtime-entry.js");
  const info = fs.lstatSync(candidate);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("PiHub Server release does not contain the runtime entry");
  }
  resolveNextBin(packageRoot);
  return candidate;
}

function loadDefaultExtensionProvisioner(packageRoot) {
  const entry = path.join(packageRoot, "bin", "default-extensions.js");
  const info = fs.lstatSync(entry);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
    throw new Error("PiHub Server release does not contain a valid default extension provisioner");
  }
  const api = require(entry);
  if (!api || typeof api.provisionDefaultExtensions !== "function") {
    throw new Error("PiHub Server default extension provisioner contract is invalid");
  }
  return api.provisionDefaultExtensions;
}

async function provisionSignedDefaultExtensions(packageRoot, options) {
  const provision = loadDefaultExtensionProvisioner(packageRoot);
  return provision(packageRoot, {
    environment: options.environment,
    expectedPackages: options.expectedPackages,
    selectedPackages: options.selectedPackages,
    home: options.home,
  });
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("Could not reserve a candidate health port");
  return port;
}

async function readBoundedResponseBody(response, maxBytes = MAX_HEALTH_BODY_BYTES) {
  if (!response.body) throw new Error("Health response has no body");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body.cancel();
    throw new Error("Health response is too large");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new Error("Health response is too large");
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Operation aborted"));
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Operation aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function closeWritable(stream) {
  if (!stream || stream.destroyed || stream.writableEnded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener?.("finish", onFinish);
      stream.removeListener?.("close", onFinish);
      stream.removeListener?.("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onFinish = () => finish();
    const onError = (error) => finish(error);
    const timer = setTimeout(() => {
      stream.destroy?.();
      finish(new Error("PiHub Server log stream did not close in time"));
    }, LOG_CLOSE_TIMEOUT_MS);
    stream.once?.("finish", onFinish);
    stream.once?.("close", onFinish);
    stream.once?.("error", onError);
    try {
      stream.end(onFinish);
    } catch (error) {
      finish(error);
    }
  });
}

class StableServerSupervisor {
  constructor(options) {
    if (!options || typeof options.runtimeFactory !== "function") {
      throw new Error("Stable supervisor requires an update runtime factory");
    }
    this.bootstrapPackageRoot = path.resolve(options.bootstrapPackageRoot);
    this.bootstrapVersion = options.bootstrapVersion;
    this.hostname = options.hostname;
    this.port = Number(options.port);
    this.openBrowserRequested = options.openBrowser === true;
    this.tailnetHostname = options.tailnetHostname || "";
    this.baseRuntimeEnvironment = createServerRuntimeEnvironment(options.baseRuntimeEnvironment ?? process.env);
    this.runtimeFactory = options.runtimeFactory;
    this.defaultExtensionsEnabled = options.defaultExtensionsEnabled === true;
    this.selectedDefaultExtensions = Array.isArray(options.selectedDefaultExtensions)
      ? options.selectedDefaultExtensions
      : undefined;
    this.extensionProvisioner = options.extensionProvisioner || provisionSignedDefaultExtensions;
    this.spawnImpl = options.spawnImpl || spawn;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    // Optional: when this probe returns true, the relay connector is spawned
    // alongside every (non-candidate) server child from the same package root.
    this.connectorConfigured = options.connectorConfigured || (() => false);
    this.connectorDataRoot = options.connectorDataRoot || "";
    this.parentProcess = options.parentProcess || process;
    this.logger = options.logger || console;
    this.stdoutLogSink = options.stdoutLogSink || null;
    this.stderrLogSink = options.stderrLogSink || null;
    this.now = options.now || Date.now;
    this.randomId = options.randomId || (() => randomBytes(16).toString("hex"));
    this.currentChild = null;
    this.currentChildVersion = null;
    this.connectorChild = null;
    this.connectorRestartTimer = null;
    this.plannedConnectorStops = new WeakSet();
    this.candidateChildren = new Set();
    this.candidateWarnings = new WeakSet();
    this.plannedStops = new WeakSet();
    this.restartTimer = null;
    this.restartAttempts = 0;
    this.updatePromise = null;
    this.runtime = null;
    this.browserOpened = false;
    this.started = false;
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.signalHandlers = new Map();
    this.updateState = this.createUpdateState("idle");
  }

  createUpdateState(phase, details = {}) {
    return {
      phase,
      ...details,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  async start() {
    if (this.started) throw new Error("Stable supervisor has already started");
    this.started = true;
    this.installSignalHandlers();
    this.runtime = await this.runtimeFactory({
      health: { check: (input) => this.checkReleaseHealth(input) },
    });
    this.updateState = this.createUpdateState("recovering");
    await this.runtime.initialize();
    await this.runtime.recover();
    await this.ensureCurrentRunning();
    this.updateState = this.createUpdateState("idle");
    return this;
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  async performShutdown() {
    const failures = [];
    try {
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.stopConnector();
      const candidates = [...this.candidateChildren];
      const stopped = await Promise.allSettled(candidates.map((child) => this.stopChild(child)));
      for (const result of stopped) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (this.currentChild) {
        try {
          await this.stopChild(this.currentChild);
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      this.removeSignalHandlers();
      const sinks = [...new Set([this.stdoutLogSink, this.stderrLogSink].filter(Boolean))];
      const closed = await Promise.allSettled(sinks.map((sink) => closeWritable(sink)));
      for (const result of closed) {
        if (result.status === "rejected") failures.push(result.reason);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "PiHub Server supervisor did not shut down cleanly");
    }
  }

  installSignalHandlers() {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        void this.shutdown()
          .catch(() => this.logger.error("PiHub Server did not shut down cleanly."))
          .finally(() => {
            this.parentProcess.exitCode = signal === "SIGINT" ? 130 : 143;
          });
      };
      this.signalHandlers.set(signal, handler);
      this.parentProcess.on(signal, handler);
    }
  }

  removeSignalHandlers() {
    for (const [signal, handler] of this.signalHandlers) {
      this.parentProcess.removeListener(signal, handler);
    }
    this.signalHandlers.clear();
  }

  childEnvironment(packageRoot, version) {
    return createServerRuntimeEnvironment(this.baseRuntimeEnvironment, {
      overrides: {
        PIHUB_SERVER_HOSTNAME: this.hostname,
        // Older releases only read the legacy variable; keep both in sync.
        PI_WEB_HOSTNAME: this.hostname,
        PIHUB_TAILNET_HOSTNAME: this.tailnetHostname,
        PIHUB_SERVER_VERSION: version,
        PIHUB_SERVER_ROOT: packageRoot,
      },
    });
  }

  async provisionCurrentExtensions(packageRoot) {
    if (!this.defaultExtensionsEnabled) return null;
    const provisionOptions = { environment: this.baseRuntimeEnvironment };
    if (this.selectedDefaultExtensions !== undefined) {
      provisionOptions.selectedPackages = this.selectedDefaultExtensions;
    }
    const result = await this.extensionProvisioner(packageRoot, provisionOptions);
    const selectedNames = this.selectedDefaultExtensions === undefined
      ? null
      : new Set(this.selectedDefaultExtensions.map((entry) => entry.name));
    const statusPackages = Array.isArray(result?.status?.packages) ? result.status.packages : [];
    const selectedInstalled = selectedNames === null
      ? 0
      : statusPackages.filter((entry) => selectedNames.has(entry?.name) && entry?.installed === true).length;
    const unselectedEnabled = selectedNames === null
      ? false
      : statusPackages.some((entry) => !selectedNames.has(entry?.name) && entry?.installed === true);
    const statusValid = selectedNames === null
      ? result?.status?.installed === true && result?.status?.installedCount === result?.status?.total
      : result?.status?.installedCount === this.selectedDefaultExtensions.length
        && selectedInstalled === this.selectedDefaultExtensions.length
        && !unselectedEnabled;
    if (!isRecord(result) || typeof result.rollback !== "function"
        || !isRecord(result.status) || !statusValid
        || !Number.isSafeInteger(result.status.total) || result.status.total <= 0
        || result.status.source !== "signed-release") {
      await result?.rollback?.().catch(() => undefined);
      throw new Error("PiHub Server default extensions did not pass activation verification");
    }
    return result.rollback;
  }

  clearChildReference(child) {
    this.candidateChildren.delete(child);
    if (this.currentChild === child) {
      this.currentChild = null;
      this.currentChildVersion = null;
    }
  }

  spawnServer(packageRoot, version, port, { ipc, candidate = false } = {}) {
    if (this.shuttingDown) throw new Error("PiHub Server supervisor is shutting down");
    if (packageVersion(packageRoot) !== version) {
      throw new Error("PiHub Server release version does not match its package metadata");
    }
    const runtimeEntry = resolveRuntimeEntry(packageRoot);
    const stdio = candidate
      ? ["ignore", "pipe", "pipe"]
      : ["inherit", "pipe", this.stderrLogSink ? "pipe" : "inherit", ...(ipc ? ["ipc"] : [])];
    const child = this.spawnImpl(process.execPath, [
      runtimeEntry,
      INTERNAL_NEXT_SENTINEL,
      "start",
      "-p",
      String(port),
      "-H",
      this.hostname,
    ], {
      cwd: packageRoot,
      stdio,
      env: this.childEnvironment(packageRoot, version),
      windowsHide: true,
    });
    if (!child || typeof child.once !== "function") throw new Error("Could not start PiHub Server release");
    if (candidate) {
      this.candidateChildren.add(child);
      child.once("exit", () => this.candidateChildren.delete(child));
      child.once("close", () => this.candidateChildren.delete(child));
      child.once("error", () => this.candidateChildren.delete(child));
      child.stderr?.on("data", (chunk) => {
        if (chunk?.length && !this.candidateWarnings.has(child)) {
          this.candidateWarnings.add(child);
          this.logger.warn("Candidate PiHub Server emitted startup errors; see the private server error log.");
        }
      });
    } else {
      this.currentChild = child;
      this.currentChildVersion = version;
      child.on("message", (message) => void this.handleChildMessage(child, message));
      child.once("exit", (code, signal) => this.handleCurrentExit(child, code, signal));
      child.once("close", (code, signal) => this.handleCurrentExit(child, code, signal));
      child.once("error", (error) => {
        if (this.currentChild === child && !this.plannedStops.has(child)) {
          this.logger.error(`PiHub Server child failed (${safeErrorCode(error)}).`);
        }
        this.handleCurrentExit(child, child.exitCode, child.signalCode);
      });
      // The relay connector follows the server child's version; its failure
      // must never take the server down with it.
      try {
        this.spawnConnector(packageRoot, version);
      } catch (error) {
        this.logger.warn(`PiHub relay connector did not start (${safeErrorCode(error)}).`);
      }
    }
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      if (!candidate && !this.stdoutLogSink) this.parentProcess.stdout?.write?.(chunk);
      if (!candidate && this.openBrowserRequested && !this.browserOpened && text.includes("Ready")) {
        this.browserOpened = true;
        this.openBrowser();
      }
    });
    if (!candidate && child.stderr && this.stderrLogSink) child.stderr.on("data", () => undefined);
    if (this.stdoutLogSink) child.stdout?.pipe?.(this.stdoutLogSink, { end: false });
    if (this.stderrLogSink) child.stderr?.pipe?.(this.stderrLogSink, { end: false });
    return child;
  }

  spawnConnector(packageRoot, version) {
    this.stopConnector();
    const entry = path.join(packageRoot, "bin", "pihub-connector.js");
    if (!this.connectorConfigured() || !fs.existsSync(entry)) return;
    const env = this.childEnvironment(packageRoot, version);
    if (this.connectorDataRoot) env.PIHUB_CONNECTOR_DATA_ROOT = this.connectorDataRoot;
    const child = this.spawnImpl(process.execPath, [entry], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    if (!child || typeof child.once !== "function") throw new Error("Could not start the PiHub relay connector");
    this.connectorChild = child;
    if (this.stdoutLogSink) child.stdout?.pipe?.(this.stdoutLogSink, { end: false });
    if (this.stderrLogSink) child.stderr?.pipe?.(this.stderrLogSink, { end: false });
    child.once("exit", (code, signal) => {
      if (this.connectorChild !== child) return;
      this.connectorChild = null;
      // Exit code 0 means "not configured / clean stop" — stay down. Crashes
      // retry with a fixed delay; the connector has its own reconnect loop,
      // so a process exit is always a bug or a broken config.
      if (this.shuttingDown || this.plannedConnectorStops.has(child)) return;
      if (code === 0 && !signal) return;
      this.logger.warn("PiHub relay connector exited unexpectedly; restarting in 5s.");
      this.connectorRestartTimer = setTimeout(() => {
        this.connectorRestartTimer = null;
        if (this.shuttingDown || !this.currentChild) return;
        try {
          this.spawnConnector(packageRoot, version);
        } catch (error) {
          this.logger.warn(`PiHub relay connector restart failed (${safeErrorCode(error)}).`);
        }
      }, 5_000);
    });
  }

  stopConnector() {
    if (this.connectorRestartTimer) {
      clearTimeout(this.connectorRestartTimer);
      this.connectorRestartTimer = null;
    }
    const child = this.connectorChild;
    if (!child) return;
    this.connectorChild = null;
    this.plannedConnectorStops.add(child);
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
  }

  // Next.js loads each route's server chunk on first hit; on a cold node with
  // a slow disk that first hit can take >10s. Warm the hot routes right after
  // startup with unsigned GETs — they 401 only after the module (and its whole
  // import graph) has loaded, which is the expensive part we pay here instead
  // of on the user's first click. Fire-and-forget by design.
  warmRoutes() {
    const base = `http://${this.hostname}:${this.port}`;
    for (const route of ["/api/sessions", "/api/models", "/api/agent/running", "/api/pihub/setup"]) {
      fetch(`${base}${route}`, { signal: AbortSignal.timeout(60_000) })
        .then((response) => response.arrayBuffer())
        .catch(() => undefined);
    }
  }

  openBrowser() {
    const url = `http://${this.hostname}:${this.port}`;
    let opener;
    if (process.platform === "win32") {
      const entries = Object.entries(this.baseRuntimeEnvironment);
      const comspec = entries.find(([name]) => name.toUpperCase() === "COMSPEC")?.[1];
      const systemRoot = entries.find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1];
      const command = typeof comspec === "string" && path.isAbsolute(comspec) && /(?:^|[\\/])cmd\.exe$/i.test(comspec)
        ? comspec
        : path.join(typeof systemRoot === "string" && path.isAbsolute(systemRoot) ? systemRoot : "C:\\Windows", "System32", "cmd.exe");
      opener = this.spawnImpl(command, ["/c", "start", "", url], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
        env: this.baseRuntimeEnvironment,
      });
    } else if (process.platform === "darwin") {
      opener = this.spawnImpl("open", [url], {
        stdio: "ignore",
        detached: true,
        env: this.baseRuntimeEnvironment,
      });
    } else {
      opener = this.spawnImpl("xdg-open", [url], {
        stdio: "ignore",
        detached: true,
        env: this.baseRuntimeEnvironment,
      });
    }
    opener?.once?.("error", (error) => this.logger.warn(`Could not open browser automatically: ${error.message}`));
    opener?.unref?.();
  }

  async ensureCurrentRunning() {
    if (!this.runtime) throw new Error("Update runtime is unavailable");
    const version = await this.runtime.currentVersion();
    const packageRoot = await this.runtime.storage.resolveVersionRoot(version);
    if (this.currentChild && this.currentChildVersion === version && this.currentChild.exitCode === null) return;
    if (this.currentChild) await this.stopChild(this.currentChild);
    const rollbackExtensions = await this.provisionCurrentExtensions(packageRoot);
    let child;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STARTUP_HEALTH_TIMEOUT_MS);
    try {
      child = this.spawnServer(packageRoot, version, this.port, { ipc: true });
      await this.waitForExactHealth(child, this.port, version, Date.now() + STARTUP_HEALTH_TIMEOUT_MS, controller.signal);
      this.restartAttempts = 0;
      this.warmRoutes();
    } catch (error) {
      if (child) await this.stopChild(child).catch(() => undefined);
      try {
        await rollbackExtensions?.();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "PiHub Server startup and extension rollback both failed");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async checkReleaseHealth(input) {
    if (input.phase === "candidate") {
      const probePort = await reserveLoopbackPort();
      const child = this.spawnServer(input.packageRoot, input.version, probePort, { ipc: false, candidate: true });
      try {
        await this.waitForExactHealth(child, probePort, input.version, input.deadlineAt, input.signal);
        return true;
      } finally {
        await this.stopChild(child);
      }
    }

    this.updateState = this.createUpdateState("restarting", {
      ...(this.updateState.operationId ? { operationId: this.updateState.operationId } : {}),
      targetVersion: input.version,
    });
    if (this.currentChild) await this.stopChild(this.currentChild);
    const rollbackExtensions = await this.provisionCurrentExtensions(input.packageRoot);
    let child;
    try {
      child = this.spawnServer(input.packageRoot, input.version, this.port, { ipc: true });
      await this.waitForExactHealth(child, this.port, input.version, input.deadlineAt, input.signal);
      this.warmRoutes();
      return true;
    } catch (error) {
      if (child) await this.stopChild(child).catch(() => undefined);
      try {
        await rollbackExtensions?.();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "PiHub Server health check and extension rollback both failed");
      }
      throw error;
    }
  }

  async waitForExactHealth(child, port, expectedVersion, deadlineAt, signal) {
    if (this.shuttingDown) throw new Error("PiHub Server supervisor is shutting down");
    let lastError = new Error("Health endpoint did not become ready");
    while (Date.now() < deadlineAt) {
      if (this.shuttingDown) throw new Error("PiHub Server supervisor is shutting down");
      if (signal?.aborted) throw signal.reason ?? new Error("Health check aborted");
      if (child.exitCode !== null || child.signalCode) throw new Error("Candidate server exited before becoming healthy");
      const remaining = Math.max(1, deadlineAt - Date.now());
      const attempt = new AbortController();
      const timeout = setTimeout(() => attempt.abort(), Math.min(1_500, remaining));
      const abort = () => attempt.abort(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await this.fetchImpl(`http://127.0.0.1:${port}/api/health`, {
          cache: "no-store",
          redirect: "error",
          headers: { accept: "application/json", "cache-control": "no-store" },
          signal: attempt.signal,
        });
        if (!response.ok) throw new Error(`Health endpoint returned HTTP ${response.status}`);
        const raw = await readBoundedResponseBody(response);
        const body = JSON.parse(raw);
        if (body?.status === "ok" && body?.version === expectedVersion) return true;
        lastError = new Error("Health endpoint returned a different release version");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
      if (Date.now() < deadlineAt) await delay(Math.min(250, deadlineAt - Date.now()), signal);
    }
    throw new Error(`PiHub Server release did not pass exact health verification: ${lastError.message}`);
  }

  async stopChild(child) {
    if (!child) return;
    if (child.exitCode !== null || child.signalCode) {
      this.clearChildReference(child);
      return;
    }
    this.plannedStops.add(child);
    await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener?.("exit", onExit);
        child.removeListener?.("close", onExit);
        child.removeListener?.("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onExit = () => finish();
      const onError = (error) => finish(error);
      child.once("exit", onExit);
      child.once("close", onExit);
      child.once("error", onError);
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
          timer = setTimeout(() => {
            finish(new Error("PiHub Server child did not exit after it was force-stopped"));
          }, CHILD_FORCE_STOP_TIMEOUT_MS);
        } catch (error) {
          finish(error);
        }
      }, CHILD_STOP_TIMEOUT_MS);
      try {
        if (child.kill("SIGTERM") === false && child.exitCode === null) finish(new Error("Could not stop PiHub Server child"));
      } catch (error) {
        finish(error);
      }
    }).finally(() => {
      this.plannedStops.delete(child);
      this.clearChildReference(child);
    });
  }

  handleCurrentExit(child, code, signal) {
    if (this.currentChild !== child) return;
    this.clearChildReference(child);
    if (
      this.shuttingDown
      || this.plannedStops.has(child)
      || this.updatePromise
      || ACTIVE_UPDATE_PHASES.has(this.updateState.phase)
    ) return;
    this.logger.error(`PiHub Server child exited unexpectedly (${code ?? signal ?? "unknown"}); restarting.`);
    this.scheduleRestart();
  }

  scheduleRestart() {
    if (this.shuttingDown || this.restartTimer) return;
    const delayMs = Math.min(10_000, 250 * (2 ** Math.min(this.restartAttempts, 6)));
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.ensureCurrentRunning().catch((error) => {
        this.logger.error(`PiHub Server restart failed: ${error.message}`);
        this.scheduleRestart();
      });
    }, delayMs);
  }

  snapshotState() {
    return { ...this.updateState };
  }

  async supervisorSnapshot() {
    return {
      currentVersion: await this.runtime.currentVersion(),
      update: this.snapshotState(),
    };
  }

  sendResponse(child, requestId, response, callback) {
    if (!child.connected || typeof child.send !== "function") {
      callback?.(new Error("Update requester disconnected"));
      return;
    }
    try {
      child.send({
        protocol: SERVER_UPDATE_IPC_PROTOCOL,
        type: "response",
        requestId,
        ...response,
      }, callback);
    } catch (error) {
      callback?.(error);
    }
  }

  async handleChildMessage(child, message) {
    if (child !== this.currentChild || !isUpdateRequest(message)) return;
    if (message.command === "status") {
      try {
        this.sendResponse(child, message.requestId, { ok: true, result: await this.supervisorSnapshot() });
      } catch {
        this.sendResponse(child, message.requestId, {
          ok: false,
          error: { code: "update_runtime_failed", message: "Stable update launcher could not read its state" },
        });
      }
      return;
    }

    if (this.updatePromise || ACTIVE_UPDATE_PHASES.has(this.updateState.phase)) {
      this.sendResponse(child, message.requestId, {
        ok: false,
        error: { code: "concurrent_update", message: "Another release update is already running" },
      });
      return;
    }
    const operationId = this.randomId();
    if (!REQUEST_ID_PATTERN.test(operationId)) {
      this.sendResponse(child, message.requestId, {
        ok: false,
        error: { code: "invalid_configuration", message: "Stable update launcher randomness is invalid" },
      });
      return;
    }
    this.updateState = this.createUpdateState("queued", { operationId });
    const acknowledgement = {
      accepted: true,
      operationId,
      update: this.snapshotState(),
    };
    this.sendResponse(child, message.requestId, { ok: true, result: acknowledgement }, (error) => {
      if (error) {
        if (this.updateState.operationId === operationId && this.updateState.phase === "queued") {
          this.updateState = this.createUpdateState("failed", {
            operationId,
            errorCode: "update_request_disconnected",
          });
        }
        return;
      }
      setImmediate(() => this.runAcceptedUpdate(operationId));
    });
  }

  runAcceptedUpdate(operationId) {
    if (this.updatePromise) return;
    this.updateState = this.createUpdateState("applying", { operationId });
    this.updatePromise = this.runtime.apply()
      .then((result) => {
        this.updateState = this.createUpdateState("succeeded", {
          operationId,
          resultVersion: result.version,
        });
      })
      .catch((error) => {
        const code = safeErrorCode(error);
        this.updateState = this.createUpdateState("failed", { operationId, errorCode: code });
        this.logger.error(`PiHub Server update failed (${code}).`);
      })
      .finally(() => {
        this.updatePromise = null;
        if (!this.shuttingDown && !this.currentChild) this.scheduleRestart();
      });
  }
}

module.exports = {
  ACTIVE_UPDATE_PHASES,
  SERVER_UPDATE_IPC_PROTOCOL,
  StableServerSupervisor,
  isUpdateRequest,
  packageVersion,
  closeWritable,
  readBoundedResponseBody,
  reserveLoopbackPort,
  resolveNextBin,
  resolveRuntimeEntry,
  loadDefaultExtensionProvisioner,
  provisionSignedDefaultExtensions,
};
