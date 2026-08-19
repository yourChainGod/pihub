import type { SessionDetail } from "./types";

const memory = new Map<string, SessionDetail>();
const MAX_CACHE_ITEMS = 20;
const LEGACY_DATABASE = "pihub-session-cache";
const LEGACY_PERSISTENCE_SETTING = "pihub-session-cache-enabled";
const LEGACY_PROJECT_STATE_PREFIX = "pihub-collapsed:";
let legacyCleanup: Promise<void> | null = null;

function remember(key: string, detail: SessionDetail): void {
  memory.delete(key);
  memory.set(key, detail);
  while (memory.size > MAX_CACHE_ITEMS) {
    const oldest = memory.keys().next().value as string | undefined;
    if (!oldest) break;
    memory.delete(oldest);
  }
}

function clearLegacyPersistentState(): Promise<void> {
  if (legacyCleanup) return legacyCleanup;
  legacyCleanup = new Promise((resolve) => {
    try {
      localStorage.removeItem(LEGACY_PERSISTENCE_SETTING);
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(LEGACY_PROJECT_STATE_PREFIX)) localStorage.removeItem(key);
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

// Older PiHub builds optionally stored full session bodies in IndexedDB.
// Remove that database after upgrade; remote history remains the source of truth.
void clearLegacyPersistentState();

export function cacheKey(deviceId: string, sessionId: string): string {
  return `${deviceId}:${sessionId}`;
}

export function peekSession(key: string): SessionDetail | undefined {
  return memory.get(key);
}

export async function readCachedSession(key: string): Promise<SessionDetail | null> {
  await clearLegacyPersistentState();
  return memory.get(key) ?? null;
}

export function writeCachedSession(key: string, detail: SessionDetail): void {
  remember(key, detail);
}

export async function deleteCachedSession(key: string): Promise<void> {
  memory.delete(key);
  await clearLegacyPersistentState();
}

export async function clearPersistentSessionCache(): Promise<void> {
  memory.clear();
  await clearLegacyPersistentState();
}
