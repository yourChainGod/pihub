import {
  SessionManager,
  buildContextEntries as piBuildContextEntries,
  buildSessionContext as piBuildSessionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { closeSync, createReadStream, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from "fs";
import { stat } from "fs/promises";
import { join } from "path";
import { normalize as normalizePath } from "path";
import { createInterface } from "readline";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types";
import type { SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { projectIdentityKey } from "./project-identity";
import { sessionPathKey } from "./session-path";
import { resolveProject, type ProjectInfo } from "./worktree";

export { getAgentDir };

export async function attachSessionProjectInfo(sessions: SessionInfo[]): Promise<SessionInfo[]> {
  const uniqueCwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  return sessions.map((session) => {
    const project = session.cwd ? projectByCwd.get(session.cwd) : undefined;
    const projectRoot = project?.projectRoot ?? session.cwd;
    return {
      ...session,
      projectRoot,
      projectKey: projectIdentityKey(projectRoot),
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    };
  });
}

export function mergeSessionLists(
  persistedSessions: SessionInfo[],
  supplementalSessions: SessionInfo[],
): SessionInfo[] {
  const byId = new Map(supplementalSessions.map((session) => [session.id, session]));
  // A disk scan is authoritative once the JSONL exists. In particular, this
  // replaces a transient registry snapshot without briefly rendering two rows.
  for (const session of persistedSessions) byId.set(session.id, session);
  return [...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Reads only the tail of a session JSONL and reports whether the last recorded
 * message leaves the turn unfinished (a user prompt or a tool result with no
 * assistant answer after it) — the signature of a run killed mid-flight, e.g.
 * by a service restart. Best-effort: any read/parse failure reports false.
 */
export function sessionInterrupted(filePath: string): boolean {
  try {
    const descriptor = openSync(filePath, "r");
    try {
      const fileSize = fstatSync(descriptor).size;
      const size = Math.min(fileSize, 64 * 1024);
      const buffer = Buffer.alloc(size);
      readSync(descriptor, buffer, 0, size, fileSize - size);
      const lines = buffer.toString("utf8").split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          const role = entry?.type === "message" ? entry?.message?.role : undefined;
          if (typeof role !== "string") continue;
          return role === "user" || role === "toolResult";
        } catch {
          // Partial trailing line (killed mid-write) — the run was interrupted.
          return true;
        }
      }
      return false;
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

// ============================================================================
// Per-file caches. Session files are append-only, so (size, mtimeMs) is a
// valid staleness key: unchanged files are never re-parsed, appended files
// re-parse once. Without these, every list-cache refresh re-parsed every file
// and every windowed read re-opened the whole session — a 40k-entry session
// (~90MB) wedged the single-threaded server long enough that desktop requests
// died on their total-timeout budget.
// ============================================================================

declare global {
   
  var __piSessionManagerCache: Map<string, { manager: SessionManager; size: number; mtimeMs: number }> | undefined;
   
  var __piSessionFileRecordCache: Map<string, { record: SessionFileRecord | null; size: number; mtimeMs: number }> | undefined;
}

/** Open managers hold every parsed entry in memory; keep the LRU tiny. */
const SESSION_MANAGER_CACHE_MAX = 10;
const SESSION_FILE_RECORD_CACHE_MAX = 500;
const SESSION_PATH_CACHE_MAX = 1000;
const SESSION_INFO_SCAN_CONCURRENCY = 10;

function sessionManagerCache() {
  if (!globalThis.__piSessionManagerCache) globalThis.__piSessionManagerCache = new Map();
  return globalThis.__piSessionManagerCache;
}

function sessionFileRecordCache() {
  if (!globalThis.__piSessionFileRecordCache) globalThis.__piSessionFileRecordCache = new Map();
  return globalThis.__piSessionFileRecordCache;
}

function cachePut<K, V>(cache: Map<K, V>, key: K, value: V, max: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** SessionManager.open parses the whole jsonl; cold sessions are stable on
 * disk, so keying by size+mtime makes repeated window/backfill reads free. */
export function openSessionManagerCached(filePath: string): SessionManager {
  const stats = statSync(filePath);
  const cache = sessionManagerCache();
  const hit = cache.get(filePath);
  if (hit && hit.size === stats.size && hit.mtimeMs === stats.mtimeMs) {
    cache.delete(filePath);
    cache.set(filePath, hit);
    return hit.manager;
  }
  const manager = SessionManager.open(filePath);
  cachePut(cache, filePath, { manager, size: stats.size, mtimeMs: stats.mtimeMs }, SESSION_MANAGER_CACHE_MAX);
  return manager;
}

/** The metadata the session list needs; mirrors pi's buildSessionInfo minus
 * allMessagesText (the server never reads it and it duplicates whole sessions
 * in memory). */
interface SessionFileRecord {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

function parseJsonlLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function messageTextContent(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join(" ");
}

function messageActivityTime(entry: Record<string, unknown>): number | undefined {
  const message = entry.message as { role?: unknown; content?: unknown; timestamp?: unknown } | undefined;
  if (!message || typeof message.role !== "string" || !("content" in message)) return undefined;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  if (typeof message.timestamp === "number") return message.timestamp;
  const parsed = new Date(String(entry.timestamp ?? "")).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function buildSessionFileRecord(filePath: string): Promise<SessionFileRecord | null> {
  try {
    const stats = await stat(filePath);
    let header: Record<string, unknown> | null = null;
    let messageCount = 0;
    let firstMessage = "";
    let name: string | undefined;
    let lastActivityTime: number | undefined;
    const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const entry = parseJsonlLine(line);
      if (!entry) continue;
      if (!header) {
        if (entry.type !== "session") return null;
        header = entry;
        continue;
      }
      if (entry.type === "session_info") {
        const next = typeof entry.name === "string" ? entry.name.trim() : "";
        name = next || undefined;
      }
      if (entry.type !== "message") continue;
      messageCount += 1;
      const activityTime = messageActivityTime(entry);
      if (typeof activityTime === "number") lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
      const message = entry.message as { role?: unknown; content?: unknown } | undefined;
      if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
      const text = messageTextContent(message);
      if (!text) continue;
      if (!firstMessage && message.role === "user") firstMessage = text;
    }
    if (!header) return null;
    const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
    const modified = typeof lastActivityTime === "number" && lastActivityTime > 0
      ? new Date(lastActivityTime)
      : !Number.isNaN(headerTime)
        ? new Date(headerTime)
        : stats.mtime;
    return {
      path: filePath,
      id: String(header.id ?? ""),
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name,
      parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
      created: new Date(String(header.timestamp ?? stats.mtime.toISOString())),
      modified,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
    };
  } catch {
    return null;
  }
}

async function sessionFileRecordCached(filePath: string): Promise<SessionFileRecord | null> {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return null;
  }
  const cache = sessionFileRecordCache();
  const hit = cache.get(filePath);
  if (hit && hit.size === stats.size && hit.mtimeMs === stats.mtimeMs) return hit.record;
  const record = await buildSessionFileRecord(filePath);
  cachePut(cache, filePath, { record, size: stats.size, mtimeMs: stats.mtimeMs }, SESSION_FILE_RECORD_CACHE_MAX);
  return record;
}

/** Same enumeration as pi's SessionManager.listAll, but with per-file
 * (size, mtime) caching so steady-state refreshes only parse changed files. */
export async function scanSessionFileRecords(sessionsDir = join(getAgentDir(), "sessions")): Promise<SessionFileRecord[]> {
  if (!existsSync(sessionsDir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = join(sessionsDir, entry.name);
    try {
      for (const file of readdirSync(dir)) {
        if (file.endsWith(".jsonl")) files.push(join(dir, file));
      }
    } catch { /* unreadable project dir: skip */ }
  }
  const records: SessionFileRecord[] = [];
  for (let index = 0; index < files.length; index += SESSION_INFO_SCAN_CONCURRENCY) {
    const chunk = await Promise.all(files.slice(index, index + SESSION_INFO_SCAN_CONCURRENCY).map(sessionFileRecordCached));
    for (const record of chunk) if (record) records.push(record);
  }
  records.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return records;
}

// Test seam: list-loading tests swap the scanner instead of the SDK's
// SessionManager.listAll (we no longer call it — it re-parsed every file).
export const sessionFileScannerRef = { scan: scanSessionFileRecords };

async function loadAllSessionRecords(): Promise<SessionInfo[]> {
  const piSessions = await sessionFileScannerRef.scan();
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(sessionPathKey(s.path), s.id);

  const sessions = piSessions.map((s) => {
    cacheSessionPath(s.id, s.path);
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: s.parentSessionPath ? pathToId.get(sessionPathKey(s.parentSessionPath)) : undefined,
      transient: false,
      interrupted: sessionInterrupted(s.path),
    };
  });
  return sessions;
}

async function listAllSessionRecords(options: { force?: boolean } = {}): Promise<SessionInfo[]> {
  if (options.force) invalidateSessionListCache();
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return globalThis.__piSessionListCache.data;
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  const loadPromise = loadAllSessionRecords().then((data) => {
    // If a mutation invalidated this scan, make this caller join (or start) a
    // scan for the current generation. Returning the stale result here made a
    // refresh race indistinguishable from a successful refresh.
    if ((globalThis.__piSessionListGeneration ?? 0) !== generation) {
      return listAllSessionRecords();
    }
    globalThis.__piSessionListCache = { data, ts: Date.now() };
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

export async function listAllSessions(
  options: { force?: boolean; includeProjectInfo?: boolean } = {},
): Promise<SessionInfo[]> {
  const sessions = await listAllSessionRecords({ force: options.force });
  return options.includeProjectInfo === false
    ? sessions
    : attachSessionProjectInfo(sessions);
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 30_000;

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached && isCachedSessionPathValid(sessionId, cached)) return cached;
  if (cached) {
    invalidateSessionPathCache(sessionId);
    invalidateSessionListCache();
  }

  // A stale cache entry requires an authoritative scan rather than reusing the
  // equally stale 30-second list cache.
  await listAllSessions({ force: Boolean(cached), includeProjectInfo: false });
  const resolved = getPathCache().get(sessionId);
  if (!resolved || !isCachedSessionPathValid(sessionId, resolved)) {
    if (resolved) invalidateSessionPathCache(sessionId);
    return null;
  }
  return resolved;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached && isCachedSessionPathValid(cached, filePath)) return cached;
  if (cached) {
    invalidateSessionPathCache(cached);
    invalidateSessionListCache();
  }

  await listAllSessions({ force: Boolean(cached), includeProjectInfo: false });
  const resolved = getPathToIdCache().get(pathKey);
  if (!resolved || !isCachedSessionPathValid(resolved, filePath)) return undefined;
  return resolved;
}

function isCachedSessionPathValid(sessionId: string, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    return readSessionHeader(filePath)?.id === sessionId;
  } catch {
    return false;
  }
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousPathKey = previousPath ? sessionPathKey(previousPath) : undefined;
  const previousSessionId = reverseCache.get(pathKey);
  const previousOwnerPath = previousSessionId ? pathCache.get(previousSessionId) : undefined;
  if (previousPathKey && previousPathKey !== pathKey && reverseCache.get(previousPathKey) === sessionId) {
    reverseCache.delete(previousPathKey);
  }
  if (
    previousSessionId &&
    previousSessionId !== sessionId &&
    previousOwnerPath &&
    sessionPathKey(previousOwnerPath) === pathKey
  ) {
    pathCache.delete(previousSessionId);
  }

  // Re-insert (not plain set) so both maps carry recency in iteration order,
  // the same LRU shape as cachePut.
  pathCache.delete(sessionId);
  pathCache.set(sessionId, normalizedPath);
  reverseCache.delete(pathKey);
  reverseCache.set(pathKey, sessionId);

  // Bound the index. The two maps are 1:1, so evicting by forward size bounds
  // both; eviction goes through invalidateSessionPathCache to drop the
  // sessionId and its pathKey row together. Dropping one side would leave
  // resolveSessionIdByPath resolving to an id resolveSessionPath can no
  // longer place, which reads as a missing session rather than a cache miss.
  while (pathCache.size > SESSION_PATH_CACHE_MAX) {
    const oldestSessionId = pathCache.keys().next().value;
    if (oldestSessionId === undefined) break;
    invalidateSessionPathCache(oldestSessionId);
  }
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  const pathKey = filePath ? sessionPathKey(filePath) : undefined;
  if (pathKey && reverseCache.get(pathKey) === sessionId) {
    reverseCache.delete(pathKey);
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const maxHeaderBytes = 64 * 1024;
    let position = 0;
    let foundNewline = false;

    while (position < maxHeaderBytes && !foundNewline) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxHeaderBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const data = buffer.subarray(0, bytesRead);
      const newlineIndex = data.indexOf(0x0a);
      chunks.push(newlineIndex === -1 ? data : data.subarray(0, newlineIndex));
      position += bytesRead;
      foundNewline = newlineIndex !== -1;
    }

    if (!foundNewline && position >= maxHeaderBytes) return null;
    const firstLine = Buffer.concat(chunks).toString("utf8").trimEnd();
    if (!firstLine) return null;
    try {
      const header = JSON.parse(firstLine) as SessionHeader;
      return header.type === "session" ? header : null;
    } catch {
      return null;
    }
  } finally {
    closeSync(fd);
  }
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = openSessionManagerCached(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {},
): SessionContext {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const piEntries = entries as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  const contextEntries = piBuildContextEntries(
    piEntries,
    leafId,
    byId as unknown as Map<string, PiSessionEntry>,
  );

  // Convert the SDK-selected context entries and their IDs together. This keeps
  // fork/navigation targets aligned while preserving pi's compaction ordering.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of contextEntries) {
    const localEntry = entry as unknown as SessionEntry;
    const m = entryToUiMessage(localEntry, options);
    if (m) {
      messages.push(m);
      entryIds.push(localEntry.id);
    }
  }

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function omitToolResultBase64Images(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      const message = options.deferToolResultImages
        ? omitToolResultBase64Images(normalizeToolCalls(entry.message))
        : normalizeToolCalls(entry.message);
      if (!options.deferThinking || message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
