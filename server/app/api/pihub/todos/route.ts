/**
 * GET /api/pihub/todos?sessionId=<id>
 *
 * Replays the session transcript and returns the latest pi-todo-rail snapshot.
 * The todo list is owned entirely by the pi-todo-rail extension — changes come
 * from agent tool calls or the user's /todo slash command. This route is
 * read-only.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOwnedSession } from "@/lib/session-access";
import { readSessionTodos } from "@/lib/todo-rail-bridge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("sessionId") ?? "";
  const access = requireOwnedSession(request, sessionId, "sessions:read");
  if ("response" in access) return access.response;

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    return privateJson({ error: "sessionId is required" }, { status: 400 });
  }

  const snapshot = await readSessionTodos(sessionId);
  return privateJson({ snapshot, readAt: new Date().toISOString() });
}
