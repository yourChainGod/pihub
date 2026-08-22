/**
 * @gotgenes/pi-subagents bridge.
 *
 * The extension broadcasts live lifecycle events on Pi's in-process event bus
 * (`pi.events.emit("subagents:started", …)`), which never reaches this side of
 * the RPC boundary. What does cross is the transcript: every terminal run is
 * persisted with `pi.appendEntry("subagents:record", …)`, and each spawn leaves
 * an `Agent` toolResult behind.
 *
 * Reads therefore replay the transcript the same way the todo rail does — see
 * ./todo-rail-bridge.ts. Records are keyed by subagent id so a resumed run
 * overwrites its earlier terminal state instead of appearing twice.
 */

import { getSessionEntries, resolveSessionPath } from "./session-reader";

// ── types (mirror pi-subagents/lifecycle/subagent-state.ts) ──────────────────

/** Terminal states are what the transcript records; `running` comes from spawns. */
export type SubagentRunStatus = "running" | "completed" | "failed" | "aborted";

export interface SubagentRecord {
  id: string;
  type: string;
  description: string;
  status: SubagentRunStatus;
  result?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// ── record parsing ───────────────────────────────────────────────────────────

/** pi-subagents statuses that mean "no longer running". */
const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "error"]);

function normalizeStatus(raw: unknown): SubagentRunStatus | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "error") return "failed";
  if (raw === "completed" || raw === "failed" || raw === "aborted") return raw;
  if (raw === "running" || raw === "queued") return "running";
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Parses a `subagents:record` payload. Requires the fields the panel renders
 * (id, type, status); a record missing any of them is dropped rather than shown
 * half-filled.
 */
export function parseSubagentRecord(value: unknown): SubagentRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;

  const id = optionalString(raw.id);
  const type = optionalString(raw.type);
  const status = normalizeStatus(raw.status);
  if (!id || !type || !status) return undefined;

  return {
    id,
    type,
    description: optionalString(raw.description) ?? type,
    status,
    ...(optionalString(raw.result) ? { result: optionalString(raw.result) } : {}),
    ...(optionalString(raw.error) ? { error: optionalString(raw.error) } : {}),
    ...(optionalString(raw.startedAt) ? { startedAt: optionalString(raw.startedAt) } : {}),
    ...(optionalString(raw.completedAt) ? { completedAt: optionalString(raw.completedAt) } : {}),
  };
}

/**
 * Derives an in-flight record from an `Agent` toolResult. Background spawns
 * return before the subagent finishes, so the toolResult is the only evidence a
 * run exists until its terminal `subagents:record` lands.
 */
function recordFromAgentToolResult(details: unknown): SubagentRecord | undefined {
  if (!details || typeof details !== "object") return undefined;
  const raw = details as Record<string, unknown>;

  const id = optionalString(raw.agentId) ?? optionalString(raw.id);
  if (!id) return undefined;
  const type = optionalString(raw.agentType) ?? optionalString(raw.type) ?? "agent";

  return {
    id,
    type,
    description: optionalString(raw.description) ?? type,
    status: normalizeStatus(raw.status) ?? "running",
    ...(optionalString(raw.startedAt) ? { startedAt: optionalString(raw.startedAt) } : {}),
  };
}

/** Extracts a record from a single transcript entry, if it carries one. */
function recordFromEntry(entry: unknown): SubagentRecord | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const item = entry as {
    type?: string;
    customType?: string;
    data?: unknown;
    message?: { role?: string; toolName?: string; details?: unknown };
  };

  if (item.type === "custom" && item.customType === "subagents:record") {
    return parseSubagentRecord(item.data);
  }
  if (item.type === "message" && item.message?.role === "toolResult" && item.message.toolName === "Agent") {
    return recordFromAgentToolResult(item.message.details);
  }
  return undefined;
}

/**
 * Replays entries into the current set of subagent runs, newest state per id.
 *
 * A terminal record never regresses to `running`: the `Agent` toolResult for a
 * foreground spawn can be written after the terminal record it describes, so
 * later entries only win when they carry terminal state or the id is new.
 */
export function recordsFromEntries(entries: readonly unknown[]): SubagentRecord[] {
  const byId = new Map<string, SubagentRecord>();
  for (const entry of entries) {
    const record = recordFromEntry(entry);
    if (!record) continue;
    const existing = byId.get(record.id);
    if (existing && existing.status !== "running" && record.status === "running") continue;
    byId.set(record.id, existing ? { ...existing, ...record } : record);
  }
  return Array.from(byId.values());
}

// ── session reads ────────────────────────────────────────────────────────────

/**
 * Reads the subagent runs for a session straight off its transcript. Returns an
 * empty list when the session has no file yet or never spawned a subagent.
 */
export async function readSessionSubagents(sessionId: string): Promise<SubagentRecord[]> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return [];
  try {
    return recordsFromEntries(getSessionEntries(filePath));
  } catch {
    // A truncated or in-flight transcript should read as empty, not throw.
    return [];
  }
}

/** Runs still in flight — what the panel surfaces as active work. */
export function activeSubagents(records: readonly SubagentRecord[]): SubagentRecord[] {
  return records.filter((record) => record.status === "running");
}

/** Runs that have settled, newest first when timestamps are present. */
export function settledSubagents(records: readonly SubagentRecord[]): SubagentRecord[] {
  return records
    .filter((record) => TERMINAL_STATUSES.has(record.status))
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
}
