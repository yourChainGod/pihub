import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import * as pty from "@lydell/node-pty";
import { createMinimalProcessEnvironment } from "./process-environment";

export const DEFAULT_TERMINAL_OUTPUT_LIMIT = 200_000;
export const DEFAULT_TERMINAL_IDLE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_TERMINALS_PER_OWNER = 4;
export const DEFAULT_TERMINALS_PER_PROCESS = 32;
export const DEFAULT_SUBSCRIBERS_PER_TERMINAL = 4;

export type TerminalExitReason = "exit" | "close" | "idle" | "shutdown";
export type TerminalEvent =
  | { type: "output"; data: string }
  | { type: "exit"; data: number | null; reason: TerminalExitReason };

export interface TerminalSession {
  readonly id: string;
  readonly ownerId: string;
  readonly cwd: string;
  readonly process: pty.IPty;
  readonly events: EventEmitter;
  readonly createdAt: number;
  lastTouchedAt: number;
  output: string;
  /** Absolute UTF-16 code-unit cursor at the beginning of `output`. */
  dropped: number;
}

export interface TerminalOutputRead {
  readonly chunk: string;
  readonly cursor: number;
  readonly reset: boolean;
}

export interface TerminalShell {
  readonly file: string;
  readonly args: readonly string[];
  readonly kind: "unix" | "pwsh" | "powershell" | "cmd" | "custom-windows";
}

export type ExecutableProbe = (candidate: string) => boolean;

export interface ResolveTerminalShellOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isExecutable?: ExecutableProbe;
}

export interface PtySpawnOptions {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly encoding: string;
  readonly useConpty?: boolean;
}

export type PtySpawner = (file: string, args: string[], options: PtySpawnOptions) => pty.IPty;

export interface TerminalTimerHandle {
  unref?: () => unknown;
}

export interface TerminalScheduler {
  setTimeout(callback: () => void, delayMs: number): TerminalTimerHandle;
  clearTimeout(handle: TerminalTimerHandle): void;
}

export interface TerminalManagerOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly spawn?: PtySpawner;
  readonly resolveShell?: () => TerminalShell;
  readonly isExecutable?: ExecutableProbe;
  readonly randomId?: () => string;
  readonly now?: () => number;
  readonly scheduler?: TerminalScheduler;
  readonly outputLimit?: number;
  readonly idleTtlMs?: number;
  readonly maxTerminalsPerOwner?: number;
  readonly maxTerminalsPerProcess?: number;
  readonly maxSubscribersPerTerminal?: number;
}

interface ManagedTerminal extends TerminalSession {
  closed: boolean;
  subscribers: number;
  idleTimer: TerminalTimerHandle | null;
  dataSubscription: { dispose(): void } | null;
  exitSubscription: { dispose(): void } | null;
}

interface TerminalRuntimeState {
  readonly version: 2;
  readonly manager: TerminalManager;
}

declare global {
  var __pihubTerminalRuntimeV2: TerminalRuntimeState | undefined;
  var __pihubTerminalExitHookV2: boolean | undefined;
  // Kept only so a hot reload can terminate sessions created by the old manager.
  var __pihubTerminals: Map<string, TerminalSession> | undefined;
}

function integerSetting(value: string | undefined, fallback: number, maximum: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function normalizeConfiguredCommand(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted && !unquoted.includes("\0") ? unquoted : null;
  }
  return trimmed;
}

function defaultExecutableProbe(platform: NodeJS.Platform): ExecutableProbe {
  return (candidate) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

function commandExtensions(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (path.win32.extname(command)) return [""];
  const configured = envValue(env, "PATHEXT")
    ?.split(";")
    .map((extension) => extension.trim())
    .filter((extension) => /^\.[A-Za-z0-9]+$/.test(extension));
  return configured?.length ? configured : [".EXE", ".COM"];
}

function windowsCommandCandidates(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const normalized = normalizeConfiguredCommand(command);
  if (!normalized) return [];
  const extensions = commandExtensions(normalized, env);
  const hasPath = path.win32.isAbsolute(normalized) || /[\\/]/.test(normalized);
  if (hasPath) return extensions.map((extension) => `${normalized}${extension}`);

  return (envValue(env, "PATH") ?? "")
    .split(";")
    .map((entry) => normalizeConfiguredCommand(entry))
    // Empty PATH entries mean the current directory on Windows; ignore them to
    // avoid launching a workspace-planted executable.
    .filter((entry): entry is string => Boolean(entry))
    .flatMap((entry) => extensions.map((extension) => path.win32.join(entry, `${normalized}${extension}`)));
}

function firstExecutable(
  candidates: Iterable<string>,
  probe: ExecutableProbe,
  caseInsensitive = false,
): string | null {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = caseInsensitive ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (probe(candidate)) return candidate;
  }
  return null;
}

function windowsShellKind(file: string): TerminalShell["kind"] {
  const name = path.win32.basename(file).toLowerCase().replace(/\.(?:exe|com)$/i, "");
  if (name === "pwsh") return "pwsh";
  if (name === "powershell") return "powershell";
  if (name === "cmd") return "cmd";
  return "custom-windows";
}

function windowsShellArgs(kind: TerminalShell["kind"]): string[] {
  if (kind === "pwsh" || kind === "powershell") return ["-NoLogo"];
  // /D disables registry AutoRun commands and /Q disables command echo.
  if (kind === "cmd") return ["/D", "/Q"];
  return [];
}

function resolveWindowsShell(
  env: Readonly<Record<string, string | undefined>>,
  probe: ExecutableProbe,
): TerminalShell {
  const configured = normalizeConfiguredCommand(envValue(env, "PIHUB_WINDOWS_SHELL"));
  const programFiles = normalizeConfiguredCommand(envValue(env, "ProgramFiles"));
  const systemRoot = normalizeConfiguredCommand(envValue(env, "SystemRoot"));
  const comspec = normalizeConfiguredCommand(envValue(env, "COMSPEC"));
  const safeComspec = comspec && /^(?:cmd|cmd\.exe)$/i.test(path.win32.basename(comspec))
    ? comspec
    : null;
  const groups: string[][] = [];
  if (configured) groups.push(windowsCommandCandidates(configured, env));
  groups.push([
    ...windowsCommandCandidates("pwsh.exe", env),
    ...(programFiles ? [path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe")] : []),
  ]);
  groups.push([
    ...windowsCommandCandidates("powershell.exe", env),
    ...(systemRoot
      ? [path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]
      : []),
  ]);
  groups.push([
    ...(safeComspec ? windowsCommandCandidates(safeComspec, env) : []),
    ...windowsCommandCandidates("cmd.exe", env),
    ...(systemRoot ? [path.win32.join(systemRoot, "System32", "cmd.exe")] : []),
  ]);

  for (const candidates of groups) {
    const file = firstExecutable(candidates, probe, true);
    if (!file) continue;
    const kind = windowsShellKind(file);
    return { file, args: windowsShellArgs(kind), kind };
  }
  throw new Error("No executable Windows terminal shell was found");
}

function unixShellCandidates(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const configured = normalizeConfiguredCommand(envValue(env, "SHELL"));
  const candidates: string[] = [];
  // SHELL conventionally contains an absolute path. Never resolve a bare
  // value through PATH, where a writable workspace entry could shadow it.
  if (configured && path.posix.isAbsolute(configured)) candidates.push(configured);
  if (platform === "darwin") candidates.push("/bin/zsh", "/bin/bash", "/bin/sh");
  else if (platform === "linux") candidates.push("/bin/bash", "/usr/bin/bash", "/bin/sh", "/usr/bin/sh");
  else candidates.push("/bin/sh", "/usr/bin/sh");
  return candidates;
}

export function resolveTerminalShell(options: ResolveTerminalShellOptions = {}): TerminalShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const probe = options.isExecutable ?? defaultExecutableProbe(platform);
  if (platform === "win32") return resolveWindowsShell(env, probe);
  const file = firstExecutable(unixShellCandidates(platform, env), probe);
  if (!file) throw new Error("No executable terminal shell was found");
  return { file, args: ["-l"], kind: "unix" };
}

function utf16SafeTrimStart(value: string, proposedStart: number): number {
  let start = Math.max(0, Math.min(proposedStart, value.length));
  if (
    start > 0
    && start < value.length
    && value.charCodeAt(start) >= 0xDC00
    && value.charCodeAt(start) <= 0xDFFF
    && value.charCodeAt(start - 1) >= 0xD800
    && value.charCodeAt(start - 1) <= 0xDBFF
  ) start += 1;
  return start;
}

/** A bounded string buffer whose absolute cursors are JavaScript UTF-16 offsets. */
export class TerminalOutputBuffer {
  private value = "";
  private baseOffset = 0;
  readonly limit: number;

  constructor(limit = DEFAULT_TERMINAL_OUTPUT_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("Terminal output limit must be a positive safe integer");
    }
    this.limit = limit;
  }

  get output(): string { return this.value; }
  get dropped(): number { return this.baseOffset; }
  get cursor(): number { return this.baseOffset + this.value.length; }

  append(data: string): void {
    if (!data) return;
    const combined = this.value + data;
    if (combined.length <= this.limit) {
      this.value = combined;
      return;
    }
    const trimStart = utf16SafeTrimStart(combined, combined.length - this.limit);
    this.value = combined.slice(trimStart);
    this.baseOffset += trimStart;
  }

  read(offset: number): TerminalOutputRead {
    const cursor = this.cursor;
    if (!Number.isSafeInteger(offset) || offset < this.baseOffset || offset > cursor) {
      return { chunk: this.value, cursor, reset: true };
    }
    return { chunk: this.value.slice(offset - this.baseOffset), cursor, reset: false };
  }
}

export class TerminalCapacityError extends Error {
  readonly code: "OWNER_LIMIT" | "PROCESS_LIMIT" | "SUBSCRIBER_LIMIT";

  constructor(code: "OWNER_LIMIT" | "PROCESS_LIMIT" | "SUBSCRIBER_LIMIT") {
    super(code === "OWNER_LIMIT"
      ? "Terminal limit reached for this device"
      : code === "PROCESS_LIMIT"
        ? "Terminal process limit reached"
        : "Terminal subscriber limit reached");
    this.name = "TerminalCapacityError";
    this.code = code;
  }
}

function defaultScheduler(): TerminalScheduler {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function assertOwnerId(ownerId: string): void {
  if (!ownerId || ownerId.length > 256 || /[\0\r\n]/.test(ownerId)) {
    throw new TypeError("Terminal owner requires a valid ownerId");
  }
}

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

export class TerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private accepting = true;
  private readonly platform: NodeJS.Platform;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly spawn: PtySpawner;
  private readonly shell: () => TerminalShell;
  private readonly randomId: () => string;
  private readonly now: () => number;
  private readonly scheduler: TerminalScheduler;
  private readonly outputLimit: number;
  private readonly idleTtlMs: number;
  private readonly maxPerOwner: number;
  private readonly maxPerProcess: number;
  private readonly maxSubscribersPerTerminal: number;

  constructor(options: TerminalManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.spawn = options.spawn ?? ((file, args, spawnOptions) => pty.spawn(file, args, spawnOptions));
    this.shell = options.resolveShell ?? (() => resolveTerminalShell({
      platform: this.platform,
      env: this.env,
      isExecutable: options.isExecutable,
    }));
    this.randomId = options.randomId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? defaultScheduler();
    this.outputLimit = positiveOption(options.outputLimit, DEFAULT_TERMINAL_OUTPUT_LIMIT, "outputLimit");
    this.idleTtlMs = positiveOption(options.idleTtlMs, DEFAULT_TERMINAL_IDLE_TTL_MS, "idleTtlMs");
    this.maxPerOwner = positiveOption(
      options.maxTerminalsPerOwner,
      integerSetting(envValue(this.env, "PIHUB_TERMINALS_PER_DEVICE"), DEFAULT_TERMINALS_PER_OWNER, 64),
      "maxTerminalsPerOwner",
    );
    this.maxPerProcess = positiveOption(
      options.maxTerminalsPerProcess,
      integerSetting(envValue(this.env, "PIHUB_TERMINALS_PER_PROCESS"), DEFAULT_TERMINALS_PER_PROCESS, 256),
      "maxTerminalsPerProcess",
    );
    this.maxSubscribersPerTerminal = positiveOption(
      options.maxSubscribersPerTerminal,
      integerSetting(
        envValue(this.env, "PIHUB_TERMINAL_SUBSCRIBERS"),
        DEFAULT_SUBSCRIBERS_PER_TERMINAL,
        32,
      ),
      "maxSubscribersPerTerminal",
    );
  }

  create(cwd: string, ownerId: string): TerminalSession {
    assertOwnerId(ownerId);
    if (!this.accepting) throw new Error("Terminal manager is shut down");
    if (this.sessions.size >= this.maxPerProcess) throw new TerminalCapacityError("PROCESS_LIMIT");
    if (this.count(ownerId) >= this.maxPerOwner) throw new TerminalCapacityError("OWNER_LIMIT");
    const shell = this.shell();
    const id = this.uniqueId();
    const child = this.spawn(shell.file, [...shell.args], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd,
      env: createMinimalProcessEnvironment(this.env, {
        platform: this.platform,
        additionalAllowedKeys: ["TERM_PROGRAM"],
        overrides: {
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          TERM_PROGRAM: "PiHub",
          ...(this.platform === "win32" ? {} : { SHELL: shell.file }),
        },
      }),
      encoding: "utf8",
      ...(this.platform === "win32" ? { useConpty: true } : {}),
    });
    const output = new TerminalOutputBuffer(this.outputLimit);
    const now = this.now();
    const session: ManagedTerminal = {
      id,
      ownerId,
      cwd,
      process: child,
      events: new EventEmitter(),
      createdAt: now,
      lastTouchedAt: now,
      output: "",
      dropped: 0,
      closed: false,
      subscribers: 0,
      idleTimer: null,
      dataSubscription: null,
      exitSubscription: null,
    };
    session.events.setMaxListeners(32);
    session.dataSubscription = child.onData((data) => {
      if (session.closed) return;
      output.append(data);
      session.output = output.output;
      session.dropped = output.dropped;
      session.events.emit("event", { type: "output", data } satisfies TerminalEvent);
    });
    session.exitSubscription = child.onExit(({ exitCode }) => {
      this.finalize(session, "exit", exitCode, false);
    });
    this.sessions.set(id, session);
    this.armIdleTimer(session);
    return session;
  }

  get(id: string, ownerId: string): TerminalSession | undefined {
    assertOwnerId(ownerId);
    const session = this.sessions.get(id);
    if (!session || session.ownerId !== ownerId || session.closed) return undefined;
    this.touchManaged(session);
    return session;
  }

  read(id: string, ownerId: string, offset: number): TerminalOutputRead | undefined {
    const session = this.get(id, ownerId);
    if (!session) return undefined;
    const cursor = session.dropped + session.output.length;
    if (!Number.isSafeInteger(offset) || offset < session.dropped || offset > cursor) {
      return { chunk: session.output, cursor, reset: true };
    }
    return { chunk: session.output.slice(offset - session.dropped), cursor, reset: false };
  }

  write(id: string, ownerId: string, data: string): boolean {
    const session = this.get(id, ownerId);
    if (!session) return false;
    session.process.write(data);
    return true;
  }

  resize(id: string, ownerId: string, columns: number, rows: number): boolean {
    const session = this.get(id, ownerId);
    if (!session) return false;
    session.process.resize(columns, rows);
    return true;
  }

  subscribe(
    id: string,
    ownerId: string,
    listener: (event: TerminalEvent) => void,
  ): (() => void) | null {
    const session = this.get(id, ownerId) as ManagedTerminal | undefined;
    if (!session) return null;
    if (session.subscribers >= this.maxSubscribersPerTerminal) {
      throw new TerminalCapacityError("SUBSCRIBER_LIMIT");
    }
    let active = true;
    session.subscribers += 1;
    session.events.on("event", listener);
    this.touchManaged(session);
    return () => {
      if (!active) return;
      active = false;
      session.events.off("event", listener);
      session.subscribers = Math.max(0, session.subscribers - 1);
      if (!session.closed) this.touchManaged(session);
    };
  }

  touch(id: string, ownerId: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.ownerId !== ownerId || session.closed) return false;
    this.touchManaged(session);
    return true;
  }

  close(
    id: string,
    ownerId: string,
    reason: Exclude<TerminalExitReason, "exit"> = "close",
  ): boolean {
    assertOwnerId(ownerId);
    const session = this.sessions.get(id);
    if (!session || session.ownerId !== ownerId || session.closed) return false;
    this.finalize(session, reason, null, true);
    return true;
  }

  shutdown(): void {
    this.accepting = false;
    for (const session of [...this.sessions.values()]) {
      this.finalize(session, "shutdown", null, true);
    }
  }

  count(ownerId?: string): number {
    if (ownerId === undefined) return this.sessions.size;
    assertOwnerId(ownerId);
    let count = 0;
    for (const session of this.sessions.values()) {
      if (!session.closed && session.ownerId === ownerId) count += 1;
    }
    return count;
  }

  private uniqueId(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = this.randomId();
      if (id && !this.sessions.has(id)) return id;
    }
    throw new Error("Unable to allocate a unique terminal identifier");
  }

  private touchManaged(session: ManagedTerminal): void {
    session.lastTouchedAt = this.now();
    this.armIdleTimer(session);
  }

  private armIdleTimer(session: ManagedTerminal, delayMs = this.idleTtlMs): void {
    if (session.closed) return;
    if (session.idleTimer) this.scheduler.clearTimeout(session.idleTimer);
    session.idleTimer = this.scheduler.setTimeout(() => {
      session.idleTimer = null;
      if (session.closed || this.sessions.get(session.id) !== session) return;
      const idleFor = Math.max(0, this.now() - session.lastTouchedAt);
      if (session.subscribers > 0) {
        this.armIdleTimer(session);
        return;
      }
      if (idleFor < this.idleTtlMs) {
        this.armIdleTimer(session, Math.max(1, this.idleTtlMs - idleFor));
        return;
      }
      this.finalize(session, "idle", null, true);
    }, delayMs);
    session.idleTimer.unref?.();
  }

  private finalize(
    session: ManagedTerminal,
    reason: TerminalExitReason,
    exitCode: number | null,
    kill: boolean,
  ): void {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.id);
    if (session.idleTimer) {
      this.scheduler.clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    session.dataSubscription?.dispose();
    session.exitSubscription?.dispose();
    session.dataSubscription = null;
    session.exitSubscription = null;
    session.events.emit("event", { type: "exit", data: exitCode, reason } satisfies TerminalEvent);
    session.events.removeAllListeners();
    session.subscribers = 0;
    if (kill) {
      try {
        session.process.kill();
      } catch {
        // The PTY may have exited between the final ownership check and kill.
      }
    }
  }
}

function getDefaultManager(): TerminalManager {
  if (!globalThis.__pihubTerminalRuntimeV2) {
    // Terminate pre-v2 sessions on hot reload instead of leaving detached shells.
    for (const terminal of globalThis.__pihubTerminals?.values() ?? []) {
      try { terminal.process.kill(); } catch { /* Best-effort legacy cleanup. */ }
    }
    globalThis.__pihubTerminals?.clear();
    globalThis.__pihubTerminals = undefined;
    globalThis.__pihubTerminalRuntimeV2 = { version: 2, manager: new TerminalManager() };
  }
  if (!globalThis.__pihubTerminalExitHookV2) {
    globalThis.__pihubTerminalExitHookV2 = true;
    process.once("exit", () => {
      globalThis.__pihubTerminalRuntimeV2?.manager.shutdown();
    });
  }
  return globalThis.__pihubTerminalRuntimeV2.manager;
}

export function createTerminal(cwd: string, ownerId: string): TerminalSession {
  return getDefaultManager().create(cwd, ownerId);
}

export function getTerminal(id: string, ownerId: string): TerminalSession | undefined {
  return getDefaultManager().get(id, ownerId);
}

export function readTerminal(id: string, ownerId: string, offset: number): TerminalOutputRead | undefined {
  return getDefaultManager().read(id, ownerId, offset);
}

export function writeTerminal(id: string, ownerId: string, data: string): boolean {
  return getDefaultManager().write(id, ownerId, data);
}

export function resizeTerminal(
  id: string,
  ownerId: string,
  columns: number,
  rows: number,
): boolean {
  return getDefaultManager().resize(id, ownerId, columns, rows);
}

export function subscribeTerminal(
  id: string,
  ownerId: string,
  listener: (event: TerminalEvent) => void,
): (() => void) | null {
  return getDefaultManager().subscribe(id, ownerId, listener);
}

export function touchTerminal(id: string, ownerId: string): boolean {
  return getDefaultManager().touch(id, ownerId);
}

export function closeTerminal(id: string, ownerId: string): boolean {
  return getDefaultManager().close(id, ownerId);
}

export function shutdownTerminals(): void {
  getDefaultManager().shutdown();
}
