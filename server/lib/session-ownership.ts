import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";

const SESSION_OWNERSHIP_VERSION = 1;
const MAX_SESSION_OWNERSHIP_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_OWNERSHIPS = 10_000;

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWNER_ID_PATTERN = /^dev_[A-Za-z0-9_-]{22}$/;

interface SessionOwnershipRecord {
  sessionId: string;
  ownerId: string;
  claimedAt: number;
}

interface SessionOwnershipState {
  version: 1;
  ownerships: Record<string, SessionOwnershipRecord>;
}

export interface SessionOwnershipOptions {
  statePath?: string;
  now?: number;
}

export interface SessionClaimResult {
  claimed: string[];
  alreadyOwned: string[];
}

export class SessionOwnershipConflictError extends Error {
  constructor(message = "Session ownership conflict") {
    super(message);
    this.name = "SessionOwnershipConflictError";
  }
}

export class SessionOwnershipInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionOwnershipInputError";
  }
}

export function isValidSessionOwnershipSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function isValidSessionOwnerId(value: unknown): value is string {
  return typeof value === "string" && OWNER_ID_PATTERN.test(value);
}

function validateSessionId(sessionId: unknown): asserts sessionId is string {
  if (!isValidSessionOwnershipSessionId(sessionId)) {
    throw new SessionOwnershipInputError("Invalid session identifier");
  }
}

function validateOwnerId(ownerId: unknown): asserts ownerId is string {
  if (!isValidSessionOwnerId(ownerId)) {
    throw new SessionOwnershipInputError("Invalid session owner identifier");
  }
}

function validateTimestamp(timestamp: unknown): asserts timestamp is number {
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new SessionOwnershipInputError("Invalid ownership timestamp");
  }
}

function normalizeSessionIds(sessionIds: readonly string[]): string[] {
  if (!Array.isArray(sessionIds) || sessionIds.length > MAX_SESSION_OWNERSHIPS) {
    throw new SessionOwnershipInputError("Invalid session identifier list");
  }
  const unique = new Set<string>();
  for (const sessionId of sessionIds) {
    validateSessionId(sessionId);
    if (unique.has(sessionId)) {
      throw new SessionOwnershipInputError("Duplicate session identifier");
    }
    unique.add(sessionId);
  }
  return [...unique];
}

function normalizeLookupSessionIds(sessionIds: readonly string[]): string[] {
  if (!Array.isArray(sessionIds) || sessionIds.length > MAX_SESSION_OWNERSHIPS) return [];
  return [...new Set(sessionIds.filter(isValidSessionOwnershipSessionId))];
}

function emptyState(): SessionOwnershipState {
  return { version: SESSION_OWNERSHIP_VERSION, ownerships: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(value: unknown): SessionOwnershipState {
  if (
    !isRecord(value)
    || value.version !== SESSION_OWNERSHIP_VERSION
    || !isRecord(value.ownerships)
    || Object.keys(value).some((key) => key !== "version" && key !== "ownerships")
    || Object.keys(value.ownerships).length > MAX_SESSION_OWNERSHIPS
  ) {
    throw new Error("Invalid PiHub session ownership state");
  }

  const state = emptyState();
  for (const [sessionId, value_] of Object.entries(value.ownerships)) {
    if (
      !isValidSessionOwnershipSessionId(sessionId)
      || !isRecord(value_)
      || Object.keys(value_).some((key) => !["sessionId", "ownerId", "claimedAt"].includes(key))
      || value_.sessionId !== sessionId
      || !isValidSessionOwnerId(value_.ownerId)
      || typeof value_.claimedAt !== "number"
      || !Number.isSafeInteger(value_.claimedAt)
      || value_.claimedAt < 0
    ) {
      throw new Error("Invalid PiHub session ownership state");
    }
    state.ownerships[sessionId] = {
      sessionId,
      ownerId: value_.ownerId,
      claimedAt: value_.claimedAt,
    };
  }
  return state;
}

function ensurePrivateParent(statePath: string): void {
  const parent = dirname(statePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Invalid PiHub session ownership directory");
  }
  if (process.platform !== "win32") chmodSync(parent, 0o700);
}

function validateStateFile(statePath: string): void {
  const metadata = lstatSync(statePath);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size > MAX_SESSION_OWNERSHIP_BYTES
  ) {
    throw new Error("Invalid PiHub session ownership state");
  }
  if (process.platform !== "win32") chmodSync(statePath, 0o600);
}

function ensureStateFile(statePath: string): void {
  ensurePrivateParent(statePath);
  try {
    writeFileSync(statePath, `${JSON.stringify(emptyState(), null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  validateStateFile(statePath);
}

function readState(statePath: string): SessionOwnershipState {
  if (!existsSync(statePath)) return emptyState();
  validateStateFile(statePath);
  return parseState(JSON.parse(readFileSync(statePath, "utf8")) as unknown);
}

function writeState(statePath: string, state: SessionOwnershipState): void {
  ensurePrivateParent(statePath);
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_SESSION_OWNERSHIP_BYTES) {
    throw new SessionOwnershipConflictError("Session ownership state is too large");
  }
  writePrivateFileAtomicSync(statePath, contents);
  validateStateFile(statePath);
}

async function mutateState<T>(
  statePath: string,
  update: (state: SessionOwnershipState) => { result: T; changed: boolean },
): Promise<T> {
  ensureStateFile(statePath);
  let lockCompromisedError: Error | undefined;
  const release = await lockfile.lock(statePath, {
    retries: {
      retries: 12,
      factor: 1.5,
      minTimeout: 25,
      maxTimeout: 500,
      randomize: true,
    },
    stale: 30_000,
    update: 10_000,
    onCompromised: (error) => {
      lockCompromisedError = error;
    },
  });
  const throwIfCompromised = () => {
    if (lockCompromisedError) throw lockCompromisedError;
  };

  try {
    throwIfCompromised();
    const state = readState(statePath);
    const { result, changed } = update(state);
    throwIfCompromised();
    if (changed) writeState(statePath, state);
    throwIfCompromised();
    return result;
  } finally {
    try {
      await release();
    } catch {
      // A compromised lock is reported by throwIfCompromised above.
    }
  }
}

export function getSessionOwnershipStatePath(explicitPath?: string): string {
  return resolve(
    explicitPath
      ?? process.env.PIHUB_SESSION_OWNERSHIP_PATH
      ?? join(getAgentDir(), "session-ownership.json"),
  );
}

export function getSessionOwner(
  sessionId: string,
  options: SessionOwnershipOptions = {},
): string | null {
  if (!isValidSessionOwnershipSessionId(sessionId)) return null;
  const record = readState(getSessionOwnershipStatePath(options.statePath)).ownerships[sessionId];
  return record?.ownerId ?? null;
}

export function getSessionOwners(
  sessionIds?: readonly string[],
  options: SessionOwnershipOptions = {},
): Map<string, string> {
  const selectedIds = sessionIds === undefined ? undefined : normalizeLookupSessionIds(sessionIds);
  const state = readState(getSessionOwnershipStatePath(options.statePath));
  const ids = selectedIds ?? Object.keys(state.ownerships).sort();
  const result = new Map<string, string>();
  for (const sessionId of ids) {
    const record = state.ownerships[sessionId];
    if (record) result.set(sessionId, record.ownerId);
  }
  return result;
}

export function isSessionOwnedBy(
  sessionId: string,
  ownerId: string,
  options: SessionOwnershipOptions = {},
): boolean {
  if (!isValidSessionOwnerId(ownerId)) return false;
  return getSessionOwner(sessionId, options) === ownerId;
}

export async function bindSessionOwner(
  sessionId: string,
  ownerId: string,
  options: SessionOwnershipOptions = {},
): Promise<boolean> {
  validateSessionId(sessionId);
  validateOwnerId(ownerId);
  const now = options.now ?? Date.now();
  validateTimestamp(now);
  const statePath = getSessionOwnershipStatePath(options.statePath);

  return mutateState(statePath, (state) => {
    const existing = state.ownerships[sessionId];
    if (existing) {
      if (existing.ownerId !== ownerId) {
        throw new SessionOwnershipConflictError("Session is already owned by another device");
      }
      return { result: false, changed: false };
    }
    if (Object.keys(state.ownerships).length >= MAX_SESSION_OWNERSHIPS) {
      throw new SessionOwnershipConflictError("Session ownership limit reached");
    }
    const record = { sessionId, ownerId, claimedAt: now };
    state.ownerships[sessionId] = record;
    return { result: true, changed: true };
  });
}

export async function claimUnownedSessions(
  sessionIds: readonly string[],
  ownerId: string,
  options: SessionOwnershipOptions = {},
): Promise<SessionClaimResult> {
  const selectedIds = normalizeSessionIds(sessionIds);
  validateOwnerId(ownerId);
  const now = options.now ?? Date.now();
  validateTimestamp(now);
  const statePath = getSessionOwnershipStatePath(options.statePath);

  return mutateState(statePath, (state) => {
    for (const sessionId of selectedIds) {
      const existing = state.ownerships[sessionId];
      if (existing && existing.ownerId !== ownerId) {
        throw new SessionOwnershipConflictError(`Session ${sessionId} is already owned by another device`);
      }
    }

    const unownedCount = selectedIds.filter((sessionId) => !state.ownerships[sessionId]).length;
    if (Object.keys(state.ownerships).length + unownedCount > MAX_SESSION_OWNERSHIPS) {
      throw new SessionOwnershipConflictError("Session ownership limit reached");
    }

    const claimed: string[] = [];
    const alreadyOwned: string[] = [];
    for (const sessionId of selectedIds) {
      const existing = state.ownerships[sessionId];
      if (existing) {
        alreadyOwned.push(sessionId);
        continue;
      }
      const record = { sessionId, ownerId, claimedAt: now };
      state.ownerships[sessionId] = record;
      claimed.push(sessionId);
    }
    return {
      result: { claimed, alreadyOwned },
      changed: claimed.length > 0,
    };
  });
}

export async function removeSessionOwner(
  sessionId: string,
  expectedOwnerId: string,
  options: SessionOwnershipOptions = {},
): Promise<boolean> {
  validateSessionId(sessionId);
  validateOwnerId(expectedOwnerId);
  const statePath = getSessionOwnershipStatePath(options.statePath);

  return mutateState(statePath, (state) => {
    const existing = state.ownerships[sessionId];
    if (!existing) return { result: false, changed: false };
    if (existing.ownerId !== expectedOwnerId) {
      throw new SessionOwnershipConflictError("Session is owned by another device");
    }
    delete state.ownerships[sessionId];
    return { result: true, changed: true };
  });
}
