import { existsSync, statSync } from "fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  openSessionManagerCached,
} from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { privateSessionJson, requireOwnedSession } from "@/lib/session-access";
import { getSessionOwner, removeSessionOwner } from "@/lib/session-ownership";
import { deleteSessionTransaction } from "@/lib/session-repository";
import { windowSessionContext } from "@/lib/session-window";

function compactDesktopMessages<T>(messages: T[]): T[] {
  const clip = (text: string) => text.length <= 600 ? text : `${text.slice(0, 420)}\n\n… 工具结果已折叠 ${text.length - 600} 个字符 …\n\n${text.slice(-180)}`;
  return messages.map((message) => {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "toolResult") return message;
    const item = message as { content?: unknown; [key: string]: unknown };
    if (!Array.isArray(item.content)) return message;
    return {
      ...item,
      content: item.content.map((block) => {
        if (!block || typeof block !== "object") return block;
        const value = block as { type?: unknown; text?: unknown; [key: string]: unknown };
        return value.type === "text" && typeof value.text === "string" ? { ...value, text: clip(value.text) } : value;
      }),
    } as T;
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = requireOwnedSession(req, id, "sessions:read");
  if ("response" in access) return access.response;
  try {
    const rpc = getRpcSession(id, access.context.deviceId);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return privateSessionJson({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManagerCached(resolvedPath!);
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const desktop = searchParams.has("desktop");
    const after = searchParams.get("after");
    const before = searchParams.get("before");
    const fullContext = buildSessionContext(entries as never, leafId, { deferThinking, deferToolResultImages });
    const requestedLimit = Number(searchParams.get("limit"));
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : undefined;
    // `after` catches up forward from the client's last entry; `before` pages
    // backward for history backfill; a lost cursor resets to a full window.
    let context = windowSessionContext(fullContext, { limit, after, before });
    if (desktop) context = { ...context, messages: compactDesktopMessages(context.messages) };
    const totalActiveMs = computeSessionTotalActiveMs(entries);

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sm.getSessionName(),
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      transient: !filePath || !existsSync(filePath),
    } : null;

    return privateSessionJson({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      totalActiveMs,
    });
  } catch {
    return privateSessionJson({ error: "Failed to read session" }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = requireOwnedSession(req, id, "sessions:write");
  if ("response" in access) return access.response;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return privateSessionJson({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return privateSessionJson({ error: "Session not found" }, { status: 404 });
    }
    const sm = SessionManager.open(filePath);
    sm.appendSessionInfo(name.trim());
    invalidateSessionListCache();
    return privateSessionJson({ ok: true });
  } catch {
    return privateSessionJson({ error: "Failed to rename session" }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = requireOwnedSession(req, id, "sessions:write");
  if ("response" in access) return access.response;
  try {
    const ownerId = access.context.deviceId;
    const liveSession = getRpcSession(id, ownerId);
    const liveFilePath = liveSession?.sessionFile;
    const filePath = liveSession?.isAlive() && (!liveFilePath || !existsSync(liveFilePath))
      ? null
      : await resolveSessionPath(id);
    if (!filePath) {
      if (!liveSession?.isAlive()) {
        return privateSessionJson({ error: "Session not found" }, { status: 404 });
      }

      // Empty new sessions may not have a JSONL file yet. Their durable owner
      // still needs to be removed after the runtime is fully closed.
      try {
        await liveSession.shutdown();
      } catch {
        if (liveSession.isAlive()) throw new Error("Session shutdown failed");
      }
      invalidateSessionPathCache(id);
      invalidateSessionListCache();
      await removeSessionOwner(id, ownerId);
      return privateSessionJson({ ok: true });
    }

    await deleteSessionTransaction({
      sessionId: id,
      filePath,
      ownerId,
      resolveOwner: getSessionOwner,
      shutdownSession: async (sessionId) => {
        await getRpcSession(sessionId, ownerId)?.shutdown();
      },
      invalidatePath: invalidateSessionPathCache,
    });
    await removeSessionOwner(id, ownerId);
    invalidateSessionListCache();
    return privateSessionJson({ ok: true });
  } catch {
    return privateSessionJson({ error: "Failed to delete session" }, { status: 500 });
  }
}
