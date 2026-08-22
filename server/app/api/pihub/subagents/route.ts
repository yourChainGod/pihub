/**
 * GET /api/pihub/subagents?sessionId=<id> — list a session's subagent runs.
 *
 * @gotgenes/pi-subagents keeps its live state on Pi's in-process event bus,
 * which never crosses the RPC boundary; the transcript is what does. Every
 * terminal run is persisted as a `subagents:record` entry and each spawn leaves
 * an `Agent` toolResult, so reads replay the session file — see
 * @/lib/subagents-bridge. Read-only: the extension stays the sole writer.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOwnedSession } from "@/lib/session-access";
import { activeSubagents, readSessionSubagents } from "@/lib/subagents-bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId")?.trim() ?? "";
  const access = requireOwnedSession(request, sessionId, "sessions:read");
  if ("response" in access) return access.response;

  try {
    const records = await readSessionSubagents(sessionId);
    return privateJson({
      subagents: records.map((record) => ({
        id: record.id,
        name: record.type,
        status: record.status,
        description: record.description,
        ...(record.startedAt ? { startedAt: record.startedAt } : {}),
        ...(record.completedAt ? { finishedAt: record.completedAt } : {}),
        ...(record.error ? { error: record.error } : {}),
      })),
      activeCount: activeSubagents(records).length,
      totalCount: records.length,
      readAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[subagents route] GET failed:", err);
    return privateJson({ error: "Failed to read subagents" }, { status: 500 });
  }
}
