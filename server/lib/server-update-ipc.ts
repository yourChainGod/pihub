import { randomBytes } from "node:crypto";
import { isReleaseVersion } from "./release-manifest";

export const SERVER_UPDATE_IPC_PROTOCOL = "pihub-server-update-v1";
export const SERVER_UPDATE_IPC_REQUEST_TIMEOUT_MS = 10_000;

export type ServerUpdatePhase =
  | "idle"
  | "recovering"
  | "queued"
  | "applying"
  | "restarting"
  | "succeeded"
  | "failed";

export interface ServerUpdateSupervisorState {
  phase: ServerUpdatePhase;
  operationId?: string;
  targetVersion?: string;
  resultVersion?: string;
  errorCode?: string;
  updatedAt: string;
}

export interface ServerUpdateSupervisorSnapshot {
  currentVersion: string;
  update: ServerUpdateSupervisorState;
}

export interface ServerUpdateAccepted {
  accepted: true;
  operationId: string;
  update: ServerUpdateSupervisorState;
}

export type ServerUpdateIpcCommand = "status" | "apply";

interface RequestMessage {
  protocol: typeof SERVER_UPDATE_IPC_PROTOCOL;
  type: "request";
  requestId: string;
  command: ServerUpdateIpcCommand;
}

interface ResponseMessage {
  protocol: typeof SERVER_UPDATE_IPC_PROTOCOL;
  type: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type TestTransport = (command: ServerUpdateIpcCommand) => Promise<unknown>;

const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const pending = new Map<string, PendingRequest>();
let listenerInstalled = false;
let testTransport: TestTransport | undefined;

export class ServerUpdateIpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ServerUpdateIpcError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isResponseEnvelope(value: unknown): value is Record<string, unknown> & { requestId: string } {
  return isRecord(value)
    && value.protocol === SERVER_UPDATE_IPC_PROTOCOL
    && value.type === "response"
    && isRequestId(value.requestId);
}

function isResponseMessage(value: unknown): value is ResponseMessage {
  if (!isResponseEnvelope(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) return hasExactKeys(value, ["protocol", "type", "requestId", "ok", "result"]);
  if (!hasExactKeys(value, ["protocol", "type", "requestId", "ok", "error"]) || !isRecord(value.error)) {
    return false;
  }
  return hasExactKeys(value.error, ["code", "message"])
    && typeof value.error.code === "string"
    && ERROR_CODE_PATTERN.test(value.error.code)
    && typeof value.error.message === "string"
    && value.error.message.length > 0
    && value.error.message.length <= 512
    && !/[\0\r\n]/.test(value.error.message);
}

function rejectAll(code: string, message: string): void {
  for (const [requestId, entry] of pending) {
    pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.reject(new ServerUpdateIpcError(code, message));
  }
}

function installListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  process.on("message", (message: unknown) => {
    if (!isResponseEnvelope(message)) return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    clearTimeout(entry.timer);
    if (!isResponseMessage(message)) {
      entry.reject(new ServerUpdateIpcError("update_runtime_invalid", "Stable update launcher returned an invalid response"));
      return;
    }
    if (message.ok) {
      entry.resolve(message.result);
      return;
    }
    const code = typeof message.error?.code === "string" ? message.error.code : "update_runtime_failed";
    const text = typeof message.error?.message === "string"
      ? message.error.message
      : "Stable update launcher rejected the request";
    entry.reject(new ServerUpdateIpcError(code, text));
  });
  process.on("disconnect", () => {
    rejectAll("update_runtime_unavailable", "Stable update launcher disconnected");
  });
}

export function isServerUpdateSupervisorAvailable(): boolean {
  return testTransport !== undefined || (process.connected === true && typeof process.send === "function");
}

export async function requestServerUpdateSupervisor(
  command: ServerUpdateIpcCommand,
  timeoutMs = SERVER_UPDATE_IPC_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  if (testTransport) return testTransport(command);
  if (!isServerUpdateSupervisorAvailable() || typeof process.send !== "function") {
    throw new ServerUpdateIpcError("update_runtime_unavailable", "Stable update launcher is not installed");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new ServerUpdateIpcError("invalid_configuration", "Update IPC timeout is invalid");
  }
  installListener();
  let requestId = randomBytes(16).toString("hex");
  while (pending.has(requestId)) requestId = randomBytes(16).toString("hex");
  const message: RequestMessage = {
    protocol: SERVER_UPDATE_IPC_PROTOCOL,
    type: "request",
    requestId,
    command,
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new ServerUpdateIpcError("update_runtime_timeout", "Stable update launcher did not respond"));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    process.send?.(message, (error) => {
      if (!error) return;
      const entry = pending.get(requestId);
      if (!entry) return;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(new ServerUpdateIpcError("update_runtime_unavailable", "Stable update launcher could not receive the request"));
    });
  });
}

/** Test seam only; production availability always comes from the Node IPC channel. */
export function setServerUpdateIpcTransportForTests(transport: TestTransport | undefined): void {
  testTransport = transport;
}

export function isServerUpdateSupervisorSnapshot(value: unknown): value is ServerUpdateSupervisorSnapshot {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["currentVersion", "update"])
    || !isReleaseVersion(value.currentVersion)
    || !isRecord(value.update)
  ) return false;
  const update = value.update;
  if (!isIsoTimestamp(update.updatedAt)) return false;
  if (update.phase === "idle" || update.phase === "recovering") {
    return hasExactKeys(update, ["phase", "updatedAt"]);
  }
  if (update.phase === "queued" || update.phase === "applying") {
    return hasExactKeys(update, ["phase", "operationId", "updatedAt"])
      && isRequestId(update.operationId);
  }
  if (update.phase === "restarting") {
    const expected = update.operationId === undefined
      ? ["phase", "targetVersion", "updatedAt"]
      : ["phase", "operationId", "targetVersion", "updatedAt"];
    return hasExactKeys(update, expected)
      && isReleaseVersion(update.targetVersion)
      && (update.operationId === undefined || isRequestId(update.operationId));
  }
  if (update.phase === "succeeded") {
    return hasExactKeys(update, ["phase", "operationId", "resultVersion", "updatedAt"])
      && isRequestId(update.operationId)
      && isReleaseVersion(update.resultVersion);
  }
  if (update.phase === "failed") {
    return hasExactKeys(update, ["phase", "operationId", "errorCode", "updatedAt"])
      && isRequestId(update.operationId)
      && typeof update.errorCode === "string"
      && ERROR_CODE_PATTERN.test(update.errorCode);
  }
  return false;
}

export function isServerUpdateAccepted(value: unknown): value is ServerUpdateAccepted {
  if (!isRecord(value) || !hasExactKeys(value, ["accepted", "operationId", "update"])) return false;
  if (
    value.accepted !== true
    || !isRequestId(value.operationId)
    || !isRecord(value.update)
  ) return false;
  const update = value.update;
  return hasExactKeys(update, ["phase", "operationId", "updatedAt"])
    && update.phase === "queued"
    && update.operationId === value.operationId
    && isIsoTimestamp(update.updatedAt);
}
