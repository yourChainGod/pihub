import { invokeDesktop, isDesktopEnvironment } from "./desktopTransport.ts";

const memory = new Map<string, { data: unknown; timestamp: number }>();
const MAX_CACHE_ITEMS = 50;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const persistTimers = new Map<string, number>();

function remember(key: string, data: unknown): void {
  memory.delete(key);
  memory.set(key, { data, timestamp: Date.now() });
  while (memory.size > MAX_CACHE_ITEMS) {
    const oldest = memory.keys().next().value as string | undefined;
    if (!oldest) break;
    memory.delete(oldest);
  }
  schedulePersist(key, data);
}

function schedulePersist(key: string, data: unknown): void {
  const existing = persistTimers.get(key);
  if (existing !== undefined) window.clearTimeout(existing);
  persistTimers.set(
    key,
    window.setTimeout(() => {
      persistTimers.delete(key);
      void persistNow(key, data);
    }, 800),
  );
}

async function persistNow(key: string, data: unknown): Promise<void> {
  if (!isDesktopEnvironment()) return;
  try {
    await invokeDesktop("write_resource_cache", { key, payload: JSON.stringify(data) });
  } catch {
    /* disk unavailable: memory cache still works */
  }
}

async function readPersisted(key: string): Promise<unknown | null> {
  if (!isDesktopEnvironment()) return null;
  try {
    const raw = await invokeDesktop<string | null>("read_resource_cache", { key });
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function peekResource(key: string): unknown | undefined {
  const cached = memory.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    memory.delete(key);
    return undefined;
  }
  return cached.data;
}

export async function readCachedResource(key: string): Promise<unknown | null> {
  const cached = memory.get(key);
  if (cached && Date.now() - cached.timestamp <= CACHE_TTL_MS) return cached.data;
  const persisted = await readPersisted(key);
  if (persisted) {
    memory.delete(key);
    memory.set(key, { data: persisted, timestamp: Date.now() });
    while (memory.size > MAX_CACHE_ITEMS) {
      const oldest = memory.keys().next().value as string | undefined;
      if (!oldest) break;
      memory.delete(oldest);
    }
  }
  return persisted;
}

export function writeCachedResource(key: string, data: unknown): void {
  remember(key, data);
}

export async function deleteCachedResource(key: string): Promise<void> {
  memory.delete(key);
  const timer = persistTimers.get(key);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    persistTimers.delete(key);
  }
  if (isDesktopEnvironment()) {
    await invokeDesktop("delete_resource_cache", { key }).catch(() => undefined);
  }
}

export async function clearResourceCache(): Promise<void> {
  memory.clear();
  for (const timer of persistTimers.values()) window.clearTimeout(timer);
  persistTimers.clear();
  if (isDesktopEnvironment()) {
    await invokeDesktop("clear_resource_cache").catch(() => undefined);
  }
}
