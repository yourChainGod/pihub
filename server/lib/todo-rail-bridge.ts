/**
 * pi-todo-rail bridge.
 *
 * pi-todo-rail keeps its state inside the session transcript, not in a
 * standalone file: every mutation appends either a `custom` entry with
 * customType "todo-state" or a `todo` toolResult carrying a snapshot. The
 * newest snapshot in the branch wins.
 *
 * Reads therefore replay the transcript; writes go through the session's own
 * `todo` tool so the extension stays the single writer and the agent sees the
 * same list the user does.
 */

import { getSessionEntries, resolveSessionPath } from "./session-reader";

// ── types (mirror pi-todo-rail/state.ts) ─────────────────────────────────────

export interface RailTodo {
  id: number;
  text: string;
  done: boolean;
  note?: string;
}

export interface RailSnapshot {
  version: 2;
  todos: RailTodo[];
  nextId: number;
}

// ── snapshot parsing ─────────────────────────────────────────────────────────

function normalizeTodo(raw: unknown, seenIds: Set<number>): RailTodo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const todo = raw as { id?: unknown; text?: unknown; note?: unknown; done?: unknown; status?: unknown };
  if (!Number.isInteger(todo.id) || (todo.id as number) < 1 || seenIds.has(todo.id as number)) return undefined;
  if (typeof todo.text !== "string" || !todo.text.trim()) return undefined;
  if (todo.note !== undefined && typeof todo.note !== "string") return undefined;

  let done: boolean;
  if (typeof todo.done === "boolean") done = todo.done;
  else if (typeof todo.status === "string") done = todo.status === "done";
  else return undefined;

  seenIds.add(todo.id as number);
  const note = typeof todo.note === "string" ? todo.note.trim() : "";
  return { id: todo.id as number, text: (todo.text as string).trim(), done, ...(note ? { note } : {}) };
}

/**
 * Parses a raw snapshot payload. Rejects the whole snapshot when any item is
 * malformed — matching pi-todo-rail, which prefers an empty list over a
 * partially-read one.
 */
export function parseRailSnapshot(value: unknown): RailSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { version?: unknown; todos?: unknown; nextId?: unknown };
  if ((candidate.version !== 1 && candidate.version !== 2) || !Array.isArray(candidate.todos)) return undefined;

  const todos: RailTodo[] = [];
  const seenIds = new Set<number>();
  for (const raw of candidate.todos) {
    const todo = normalizeTodo(raw, seenIds);
    if (!todo) return undefined;
    todos.push(todo);
  }

  const highestId = todos.reduce((max, todo) => Math.max(max, todo.id), 0);
  const nextId =
    Number.isInteger(candidate.nextId) && (candidate.nextId as number) > highestId
      ? (candidate.nextId as number)
      : highestId + 1;
  return { version: 2, todos, nextId };
}

/** Extracts a snapshot from a single transcript entry, if it carries one. */
function snapshotFromEntry(entry: unknown): RailSnapshot | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const item = entry as {
    type?: string;
    customType?: string;
    data?: unknown;
    message?: { role?: string; toolName?: string; details?: unknown };
  };

  if (item.type === "custom" && item.customType === "todo-state") {
    return parseRailSnapshot(item.data);
  }
  if (item.type === "message" && item.message?.role === "toolResult" && item.message.toolName === "todo") {
    const details = item.message.details as { snapshot?: unknown } | undefined;
    return parseRailSnapshot(details?.snapshot);
  }
  return undefined;
}

/** Replays entries and returns the newest snapshot, or an empty list. */
export function snapshotFromEntries(entries: readonly unknown[]): RailSnapshot {
  let latest: RailSnapshot | undefined;
  for (const entry of entries) {
    const snapshot = snapshotFromEntry(entry);
    if (snapshot) latest = snapshot;
  }
  return latest ?? { version: 2, todos: [], nextId: 1 };
}

// ── session reads ────────────────────────────────────────────────────────────

/**
 * Reads the current todo list for a session straight off its transcript.
 * Returns an empty snapshot when the session has no file yet or has never
 * used the todo tool.
 */
export async function readSessionTodos(sessionId: string): Promise<RailSnapshot> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return { version: 2, todos: [], nextId: 1 };
  try {
    return snapshotFromEntries(getSessionEntries(filePath));
  } catch {
    // A truncated or in-flight transcript should read as empty, not throw.
    return { version: 2, todos: [], nextId: 1 };
  }
}

/** The current item is derived: the first unfinished todo. */
export function currentRailTodo(todos: readonly RailTodo[]): RailTodo | undefined {
  return todos.find((todo) => !todo.done);
}
