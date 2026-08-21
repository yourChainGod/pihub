/**
 * Windowing for GET /api/sessions/[id]: either a trailing `limit` window, or
 * an incremental catch-up from a client-held `after` entry-id cursor.
 *
 * The cursor names the last entry the client already has (the session file is
 * append-only, so anything past it is new by construction). A cursor that no
 * longer resolves — compaction, branch navigation, or a rewritten file — must
 * reset the client to a full window instead of silently dropping history.
 */

export interface SessionWindowContext {
  messages: unknown[];
  entryIds: (string | undefined)[];
  truncated?: boolean;
  totalMessages?: number;
}

export interface SessionWindowFlags {
  /** Only entries after the client's cursor are included. */
  incremental?: boolean;
  /** The cursor was lost; the client must replace, not append. */
  reset?: boolean;
}

export function windowSessionContext<T extends SessionWindowContext>(
  fullContext: T,
  options: { limit?: number; after?: string | null; before?: string | null },
): T & SessionWindowFlags {
  const { limit, after, before } = options;
  const capped = limit && limit > 0 ? Math.min(limit, 500) : undefined;
  const trailingWindow = (): T & SessionWindowFlags => {
    const start = capped ? Math.max(0, fullContext.messages.length - capped) : 0;
    return capped
      ? {
        ...fullContext,
        messages: fullContext.messages.slice(start),
        entryIds: fullContext.entryIds.slice(start),
        truncated: start > 0,
        totalMessages: fullContext.messages.length,
      }
      : { ...fullContext };
  };

  // Backward paging: entries ending right before the cursor, so the client can
  // prepend older history. A lost cursor resets to the trailing window.
  if (before) {
    const anchor = fullContext.entryIds.indexOf(before);
    if (anchor < 0) return { ...trailingWindow(), reset: true };
    const windowSize = capped ?? 120;
    const start = Math.max(0, anchor - windowSize);
    return {
      ...fullContext,
      messages: fullContext.messages.slice(start, anchor),
      entryIds: fullContext.entryIds.slice(start, anchor),
      truncated: start > 0,
      totalMessages: fullContext.messages.length,
      incremental: true,
    };
  }

  if (!after) return trailingWindow();

  const anchor = fullContext.entryIds.lastIndexOf(after);
  if (anchor < 0) return { ...trailingWindow(), reset: true };
  return {
    ...fullContext,
    messages: fullContext.messages.slice(anchor + 1),
    entryIds: fullContext.entryIds.slice(anchor + 1),
    truncated: false,
    totalMessages: fullContext.messages.length,
    incremental: true,
  };
}
