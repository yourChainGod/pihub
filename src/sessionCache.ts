import type { SessionDetail, SessionMessage } from "./types";
import { invokeDesktop, isDesktopEnvironment } from "./desktopTransport.ts";

const memory = new Map<string, SessionDetail>();
const MAX_CACHE_ITEMS = 20;
const LEGACY_DATABASE = "pihub-session-cache";
const LEGACY_PERSISTENCE_SETTING = "pihub-session-cache-enabled";
const LEGACY_PROJECT_STATE_PREFIX = "pihub-collapsed:";
const LEGACY_PERSIST_PREFIX = "pihub-session-v2:";
const LEGACY_PERSIST_INDEX_KEY = "pihub-session-v2:index";
const MAX_PERSIST_MESSAGES = 120;
// Persisted tails are written to per-device folders on disk, so the old
// localStorage quota cliff is gone; the per-block bound stays to keep any
// single cached session (and the in-memory copy) at a sane size.
const MAX_PERSIST_BLOCK_CHARS = 8_000;
const persistTimers = new Map<string, number>();
let legacyCleanup: Promise<void> | null = null;

function remember(key: string, detail: SessionDetail): void {
  memory.delete(key);
  memory.set(key, detail);
  while (memory.size > MAX_CACHE_ITEMS) {
    const oldest = memory.keys().next().value as string | undefined;
    if (!oldest) break;
    memory.delete(oldest);
  }
  schedulePersist(key);
}

/**
 * Sessions are append-only JSONL on the server, so a persisted tail plus the
 * `after` cursor turns every reopen into an incremental top-up. Only a bounded
 * tail is stored: no streaming placeholders, no base64 image payloads.
 */
function persistableDetail(detail: SessionDetail): SessionDetail | null {
  const context = detail.context;
  if (!context || !Array.isArray(context.messages) || !Array.isArray(context.entryIds)) return null;
  const pairs: Array<{ message: SessionMessage; entryId: string | undefined }> = [];
  for (let index = 0; index < context.messages.length; index += 1) {
    const message = context.messages[index];
    if (message.pihubStreaming || message.pihubOptimistic) continue;
    pairs.push({ message: boundBlockSizes(stripImagePayloads(message)), entryId: context.entryIds[index] });
  }
  const tail = pairs.slice(-MAX_PERSIST_MESSAGES);
  if (!tail.length) return null;
  return {
    ...detail,
    context: {
      ...context,
      messages: tail.map((pair) => pair.message),
      entryIds: tail.map((pair) => pair.entryId) as string[],
      // The tail is only a partial window when the live context already was
      // one, or when the tail had to drop older messages.
      truncated: (context.truncated ?? false) || tail.length < pairs.length,
      totalMessages: Math.max(context.totalMessages ?? 0, context.messages.length),
    },
  };
}

function stripImagePayloads(message: SessionMessage): SessionMessage {
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const content = (message.content as Array<Record<string, unknown>>).map((block) => {
    if (!block || block.type !== "image") return block;
    changed = true;
    const next = { ...block };
    delete next.data;
    if (next.source && typeof next.source === "object") {
      const source = { ...(next.source as Record<string, unknown>) };
      delete source.data;
      next.source = source;
    }
    return next;
  });
  return changed ? { ...message, content } : message;
}

function boundString(value: unknown): unknown {
  return typeof value === "string" && value.length > MAX_PERSIST_BLOCK_CHARS
    ? `${value.slice(0, MAX_PERSIST_BLOCK_CHARS)}…`
    : value;
}

function boundBlockSizes(message: SessionMessage): SessionMessage {
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const content = (message.content as Array<Record<string, unknown>>).map((block) => {
    if (!block || typeof block !== "object") return block;
    let next: Record<string, unknown> | null = null;
    for (const field of ["text", "thinking", "output"] as const) {
      const source: Record<string, unknown> = next ?? block;
      const bounded = boundString(source[field]);
      if (bounded !== source[field]) {
        next = { ...source, [field]: bounded };
        changed = true;
      }
    }
    for (const field of ["input", "arguments"] as const) {
      const source: Record<string, unknown> = next ?? block;
      const raw = source[field];
      if (raw !== undefined && typeof raw !== "string") {
        const serialized = JSON.stringify(raw) ?? "";
        if (serialized.length > MAX_PERSIST_BLOCK_CHARS) {
          next = { ...source, [field]: { pihubPersistTruncated: true, preview: serialized.slice(0, MAX_PERSIST_BLOCK_CHARS) } };
          changed = true;
        }
      }
    }
    return next ?? block;
  });
  return changed ? { ...message, content } : message;
}

function splitCacheKey(key: string): { deviceId: string; sessionId: string } | null {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  return { deviceId: key.slice(0, separator), sessionId: key.slice(separator + 1) };
}

function schedulePersist(key: string): void {
  const existing = persistTimers.get(key);
  if (existing !== undefined) window.clearTimeout(existing);
  persistTimers.set(key, window.setTimeout(() => {
    persistTimers.delete(key);
    void persistNow(key);
  }, 800));
}

async function persistNow(key: string): Promise<void> {
  const detail = memory.get(key);
  if (!detail || !isDesktopEnvironment()) return;
  const parts = splitCacheKey(key);
  if (!parts) return;
  try {
    const persistable = persistableDetail(detail);
    if (!persistable) return;
    await invokeDesktop("write_session_cache", { ...parts, payload: JSON.stringify(persistable) });
  } catch { /* disk unavailable: memory cache still works */ }
}

async function readPersisted(key: string): Promise<SessionDetail | null> {
  if (!isDesktopEnvironment()) return null;
  const parts = splitCacheKey(key);
  if (!parts) return null;
  try {
    const raw = await invokeDesktop<string | null>("read_session_cache", parts);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionDetail | null;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.context?.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearLegacyPersistentState(): Promise<void> {
  if (legacyCleanup) return legacyCleanup;
  legacyCleanup = new Promise((resolve) => {
    try {
      localStorage.removeItem(LEGACY_PERSISTENCE_SETTING);
      localStorage.removeItem(LEGACY_PERSIST_INDEX_KEY);
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(LEGACY_PROJECT_STATE_PREFIX) || key?.startsWith(LEGACY_PERSIST_PREFIX)) localStorage.removeItem(key);
      }
    } catch { /* storage disabled */ }
    if (!("indexedDB" in window)) { resolve(); return; }
    const request = indexedDB.deleteDatabase(LEGACY_DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
  return legacyCleanup;
}

// Older PiHub builds stored session bodies in IndexedDB, then in localStorage;
// both are removed on first run. The cache now lives in per-device folders on
// disk (session-cache/<deviceId>/<sessionId>.json); the remote session file
// remains the source of truth.
void clearLegacyPersistentState();

export function cacheKey(deviceId: string, sessionId: string): string {
  return `${deviceId}:${sessionId}`;
}

export function peekSession(key: string): SessionDetail | undefined {
  return memory.get(key);
}

export async function readCachedSession(key: string): Promise<SessionDetail | null> {
  await clearLegacyPersistentState();
  const hit = memory.get(key);
  if (hit) return hit;
  const persisted = await readPersisted(key);
  if (persisted) {
    // Hydrate the in-memory layer too: incremental catch-up reads its anchor
    // from peekSession, which is memory-only.
    memory.delete(key);
    memory.set(key, persisted);
    while (memory.size > MAX_CACHE_ITEMS) {
      const oldest = memory.keys().next().value as string | undefined;
      if (!oldest) break;
      memory.delete(oldest);
    }
  }
  return persisted;
}

export function writeCachedSession(key: string, detail: SessionDetail): void {
  remember(key, detail);
}

export async function deleteCachedSession(key: string): Promise<void> {
  memory.delete(key);
  const timer = persistTimers.get(key);
  if (timer !== undefined) { window.clearTimeout(timer); persistTimers.delete(key); }
  const parts = splitCacheKey(key);
  if (parts && isDesktopEnvironment()) {
    await invokeDesktop("delete_session_cache", parts).catch(() => undefined);
  }
  await clearLegacyPersistentState();
}

export async function clearPersistentSessionCache(): Promise<void> {
  memory.clear();
  for (const timer of persistTimers.values()) window.clearTimeout(timer);
  persistTimers.clear();
  if (isDesktopEnvironment()) {
    await invokeDesktop("clear_session_cache").catch(() => undefined);
  }
  await clearLegacyPersistentState();
}
