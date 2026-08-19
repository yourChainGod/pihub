import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import lockfile from "proper-lockfile";
import {
  isPihubCapability,
  normalizePihubCapabilities,
  normalizePihubDeviceLabel,
  PIHUB_CAPABILITIES,
  PihubAuthInputError,
  type PihubCapability,
} from "./pihub-auth-shared";

const AUTH_STATE_VERSION = 1;
const MAX_AUTH_STATE_BYTES = 2 * 1024 * 1024;
const MAX_DEVICES = 256;
const MAX_ACTIVE_PAIRING_CODES = 32;
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const MIN_PAIRING_TTL_MS = 30 * 1000;
const MAX_PAIRING_TTL_MS = 15 * 60 * 1000;

const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{22}$/;
const DEVICE_SECRET_PATTERN = /^pihub_key_[A-Za-z0-9_-]{43}$/;
const PAIRING_CODE_PATTERN = /^pihub-[A-Za-z0-9_-]{43}$/;
const PAIRING_ID_PATTERN = /^pair_[A-Za-z0-9_-]{16}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface StoredDevice {
  id: string;
  label: string;
  capabilities: PihubCapability[];
  createdAt: number;
  rotatedAt?: number;
  revokedAt?: number;
  secret?: string;
}

interface StoredPairingCode {
  id: string;
  label: string;
  capabilities: PihubCapability[];
  createdAt: number;
  expiresAt: number;
  digest: string;
}

interface PihubAuthState {
  version: 1;
  devices: Record<string, StoredDevice>;
  pairingCodes: Record<string, StoredPairingCode>;
}

export interface PihubDeviceSummary {
  id: string;
  label: string;
  capabilities: PihubCapability[];
  createdAt: number;
  rotatedAt?: number;
  revokedAt?: number;
}

export interface PihubPairingCodeSummary {
  id: string;
  label: string;
  capabilities: PihubCapability[];
  createdAt: number;
  expiresAt: number;
}

export interface PihubPairingGrant extends PihubPairingCodeSummary {
  code: string;
}

export interface PihubClaimedDevice extends PihubDeviceSummary {
  secret: string;
}

export interface PihubAuthStateSummary {
  devices: PihubDeviceSummary[];
  pairingCodes: PihubPairingCodeSummary[];
}

export class PihubAuthStateConflictError extends Error {
  constructor(message = "Authentication state conflict") {
    super(message);
    this.name = "PihubAuthStateConflictError";
  }
}

function emptyState(): PihubAuthState {
  return { version: AUTH_STATE_VERSION, devices: {}, pairingCodes: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseCapabilities(value: unknown): PihubCapability[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > PIHUB_CAPABILITIES.length) return null;
  if (!value.every(isPihubCapability) || new Set(value).size !== value.length) return null;
  return PIHUB_CAPABILITIES.filter((capability) => value.includes(capability));
}

function parseDevice(key: string, value: unknown): StoredDevice | null {
  if (!DEVICE_ID_PATTERN.test(key) || !isRecord(value) || value.id !== key) return null;
  const capabilities = parseCapabilities(value.capabilities);
  if (
    typeof value.label !== "string"
    || !value.label
    || value.label.length > 80
    || /[\u0000-\u001f\u007f]/.test(value.label)
    || !capabilities
    || !isSafeTimestamp(value.createdAt)
    || (value.rotatedAt !== undefined && !isSafeTimestamp(value.rotatedAt))
    || (value.revokedAt !== undefined && !isSafeTimestamp(value.revokedAt))
  ) {
    return null;
  }

  if (value.revokedAt === undefined) {
    if (typeof value.secret !== "string" || !DEVICE_SECRET_PATTERN.test(value.secret)) return null;
  } else if (value.secret !== undefined) {
    return null;
  }

  return {
    id: key,
    label: value.label,
    capabilities,
    createdAt: value.createdAt,
    ...(value.rotatedAt === undefined ? {} : { rotatedAt: value.rotatedAt }),
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
    ...(value.secret === undefined ? {} : { secret: value.secret }),
  };
}

function parsePairingCode(key: string, value: unknown): StoredPairingCode | null {
  if (!PAIRING_ID_PATTERN.test(key) || !isRecord(value) || value.id !== key) return null;
  const capabilities = parseCapabilities(value.capabilities);
  if (
    typeof value.label !== "string"
    || !value.label
    || value.label.length > 80
    || /[\u0000-\u001f\u007f]/.test(value.label)
    || !capabilities
    || !isSafeTimestamp(value.createdAt)
    || !isSafeTimestamp(value.expiresAt)
    || value.expiresAt <= value.createdAt
    || typeof value.digest !== "string"
    || !SHA256_PATTERN.test(value.digest)
  ) {
    return null;
  }
  return {
    id: key,
    label: value.label,
    capabilities,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    digest: value.digest,
  };
}

function parseState(value: unknown): PihubAuthState {
  if (
    !isRecord(value)
    || value.version !== AUTH_STATE_VERSION
    || !isRecord(value.devices)
    || !isRecord(value.pairingCodes)
    || Object.keys(value.devices).length > MAX_DEVICES
    || Object.keys(value.pairingCodes).length > MAX_ACTIVE_PAIRING_CODES
  ) {
    throw new Error("Invalid PiHub authentication state");
  }

  const state = emptyState();
  for (const [key, entry] of Object.entries(value.devices)) {
    const device = parseDevice(key, entry);
    if (!device) throw new Error("Invalid PiHub authentication state");
    state.devices[key] = device;
  }
  for (const [key, entry] of Object.entries(value.pairingCodes)) {
    const pairingCode = parsePairingCode(key, entry);
    if (!pairingCode) throw new Error("Invalid PiHub authentication state");
    state.pairingCodes[key] = pairingCode;
  }
  return state;
}

function ensurePrivateParent(statePath: string): void {
  const parent = dirname(statePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(parent, 0o700);
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
  const file = lstatSync(statePath);
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_AUTH_STATE_BYTES) {
    throw new Error("Invalid PiHub authentication state");
  }
  if (process.platform !== "win32") chmodSync(statePath, 0o600);
}

function readState(statePath: string): PihubAuthState {
  if (!existsSync(statePath)) return emptyState();
  const file = lstatSync(statePath);
  if (!file.isFile() || file.isSymbolicLink() || statSync(statePath).size > MAX_AUTH_STATE_BYTES) {
    throw new Error("Invalid PiHub authentication state");
  }
  if (process.platform !== "win32") chmodSync(statePath, 0o600);
  return parseState(JSON.parse(readFileSync(statePath, "utf8")) as unknown);
}

function writeState(statePath: string, state: PihubAuthState): void {
  ensurePrivateParent(statePath);
  writePrivateFileAtomicSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  if (process.platform !== "win32") chmodSync(statePath, 0o600);
}

async function mutateState<T>(
  statePath: string,
  update: (state: PihubAuthState) => { result: T; changed: boolean },
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

function randomToken(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function uniqueId(prefix: "dev_" | "pair_", existing: Record<string, unknown>): string {
  const byteLength = prefix === "dev_" ? 16 : 12;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = `${prefix}${randomToken(byteLength)}`;
    if (!Object.hasOwn(existing, id)) return id;
  }
  throw new Error("Unable to allocate authentication identifier");
}

function pairingDigest(code: string): Buffer {
  return createHash("sha256").update(code, "utf8").digest();
}

function pruneExpiredPairingCodes(state: PihubAuthState, now: number): boolean {
  let changed = false;
  for (const [id, pairingCode] of Object.entries(state.pairingCodes)) {
    if (pairingCode.expiresAt <= now) {
      delete state.pairingCodes[id];
      changed = true;
    }
  }
  return changed;
}

function deviceSummary(device: StoredDevice): PihubDeviceSummary {
  return {
    id: device.id,
    label: device.label,
    capabilities: [...device.capabilities],
    createdAt: device.createdAt,
    ...(device.rotatedAt === undefined ? {} : { rotatedAt: device.rotatedAt }),
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
  };
}

function pairingCodeSummary(pairingCode: StoredPairingCode): PihubPairingCodeSummary {
  return {
    id: pairingCode.id,
    label: pairingCode.label,
    capabilities: [...pairingCode.capabilities],
    createdAt: pairingCode.createdAt,
    expiresAt: pairingCode.expiresAt,
  };
}

export function getPihubAuthStatePath(explicitPath?: string): string {
  return resolve(
    explicitPath
      ?? process.env.PIHUB_AUTH_STATE_PATH
      ?? join(homedir(), ".pihub", "auth.json"),
  );
}

export async function issuePihubPairingCode(
  input: {
    label?: unknown;
    capabilities?: unknown;
    ttlMs?: unknown;
  } = {},
  options: { statePath?: string; now?: number } = {},
): Promise<PihubPairingGrant> {
  const label = normalizePihubDeviceLabel(input.label);
  const capabilities = normalizePihubCapabilities(input.capabilities);
  const ttlMs = input.ttlMs === undefined ? DEFAULT_PAIRING_TTL_MS : input.ttlMs;
  if (
    typeof ttlMs !== "number"
    || !Number.isSafeInteger(ttlMs)
    || ttlMs < MIN_PAIRING_TTL_MS
    || ttlMs > MAX_PAIRING_TTL_MS
  ) {
    throw new PihubAuthInputError("Invalid pairing-code lifetime");
  }

  const statePath = getPihubAuthStatePath(options.statePath);
  const now = options.now ?? Date.now();
  const code = `pihub-${randomToken(32)}`;

  return mutateState(statePath, (state) => {
    pruneExpiredPairingCodes(state, now);
    if (Object.keys(state.pairingCodes).length >= MAX_ACTIVE_PAIRING_CODES) {
      throw new PihubAuthStateConflictError("Too many active pairing codes");
    }
    if (Object.keys(state.devices).length >= MAX_DEVICES) {
      throw new PihubAuthStateConflictError("Device limit reached");
    }

    const id = uniqueId("pair_", state.pairingCodes);
    const pairingCode: StoredPairingCode = {
      id,
      label,
      capabilities,
      createdAt: now,
      expiresAt: now + ttlMs,
      digest: pairingDigest(code).toString("hex"),
    };
    state.pairingCodes[id] = pairingCode;
    return {
      result: { ...pairingCodeSummary(pairingCode), code },
      changed: true,
    };
  });
}

export async function claimPihubPairingCode(
  code: unknown,
  options: { statePath?: string; now?: number } = {},
): Promise<PihubClaimedDevice | null> {
  if (typeof code !== "string" || !PAIRING_CODE_PATTERN.test(code)) return null;

  const statePath = getPihubAuthStatePath(options.statePath);
  const now = options.now ?? Date.now();
  const suppliedDigest = pairingDigest(code);

  return mutateState(statePath, (state) => {
    let changed = pruneExpiredPairingCodes(state, now);
    let matchedId: string | undefined;
    for (const [id, pairingCode] of Object.entries(state.pairingCodes)) {
      const expectedDigest = Buffer.from(pairingCode.digest, "hex");
      if (timingSafeEqual(suppliedDigest, expectedDigest)) matchedId = id;
    }
    if (!matchedId) return { result: null, changed };
    if (Object.keys(state.devices).length >= MAX_DEVICES) {
      throw new PihubAuthStateConflictError("Device limit reached");
    }

    const pairingCode = state.pairingCodes[matchedId];
    delete state.pairingCodes[matchedId];
    changed = true;

    const id = uniqueId("dev_", state.devices);
    const secret = `pihub_key_${randomToken(32)}`;
    const device: StoredDevice = {
      id,
      secret,
      label: pairingCode.label,
      capabilities: [...pairingCode.capabilities],
      createdAt: now,
    };
    state.devices[id] = device;
    return {
      result: { ...deviceSummary(device), secret },
      changed,
    };
  });
}

export function getActivePihubDevice(
  deviceId: string,
  options: { statePath?: string } = {},
): (PihubDeviceSummary & { secret: string }) | null {
  if (!DEVICE_ID_PATTERN.test(deviceId)) return null;
  const state = readState(getPihubAuthStatePath(options.statePath));
  const device = state.devices[deviceId];
  if (!device || device.revokedAt !== undefined || !device.secret) return null;
  return { ...deviceSummary(device), secret: device.secret };
}

export async function listPihubAuthState(
  options: { statePath?: string; now?: number } = {},
): Promise<PihubAuthStateSummary> {
  const statePath = getPihubAuthStatePath(options.statePath);
  const now = options.now ?? Date.now();
  return mutateState(statePath, (state) => ({
    result: {
      devices: Object.values(state.devices)
        .map(deviceSummary)
        .sort((left, right) => left.createdAt - right.createdAt),
      pairingCodes: Object.values(state.pairingCodes)
        .filter((pairingCode) => pairingCode.expiresAt > now)
        .map(pairingCodeSummary)
        .sort((left, right) => left.createdAt - right.createdAt),
    },
    changed: pruneExpiredPairingCodes(state, now),
  }));
}

export async function rotatePihubDeviceSecret(
  deviceId: unknown,
  options: { statePath?: string; now?: number } = {},
): Promise<PihubClaimedDevice> {
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new PihubAuthInputError("Invalid device identifier");
  }
  const statePath = getPihubAuthStatePath(options.statePath);
  const now = options.now ?? Date.now();

  return mutateState(statePath, (state) => {
    const device = state.devices[deviceId];
    if (!device || device.revokedAt !== undefined) {
      throw new PihubAuthStateConflictError("Device not found");
    }
    const secret = `pihub_key_${randomToken(32)}`;
    device.secret = secret;
    device.rotatedAt = now;
    return {
      result: { ...deviceSummary(device), secret },
      changed: true,
    };
  });
}

export async function revokePihubDevice(
  deviceId: unknown,
  options: {
    statePath?: string;
    now?: number;
    allowLastManagerRevocation?: boolean;
  } = {},
): Promise<PihubDeviceSummary> {
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new PihubAuthInputError("Invalid device identifier");
  }
  const statePath = getPihubAuthStatePath(options.statePath);
  const now = options.now ?? Date.now();

  return mutateState(statePath, (state) => {
    const device = state.devices[deviceId];
    if (!device || device.revokedAt !== undefined) {
      throw new PihubAuthStateConflictError("Device not found");
    }
    if (
      !options.allowLastManagerRevocation
      && device.capabilities.includes("devices:manage")
      && Object.values(state.devices).filter((candidate) =>
        candidate.revokedAt === undefined
        && candidate.capabilities.includes("devices:manage")
      ).length <= 1
    ) {
      throw new PihubAuthStateConflictError("Cannot revoke the last device manager");
    }
    delete device.secret;
    device.revokedAt = now;
    return { result: deviceSummary(device), changed: true };
  });
}
