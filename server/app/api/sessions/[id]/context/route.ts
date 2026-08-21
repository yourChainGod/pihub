import { resolveSessionPath, buildSessionContext, openSessionManagerCached } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { privateSessionJson, requireOwnedSession } from "@/lib/session-access";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = requireOwnedSession(req, id, "sessions:read");
  if ("response" in access) return access.response;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");

  try {
    const rpc = getRpcSession(id, access.context.deviceId);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return privateSessionJson({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManagerCached(filePath!);
    const fullContext = buildSessionContext(sm.getEntries() as never, leafId, {
      deferThinking,
      deferToolResultImages,
    });
    const requestedLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 500) : undefined;
    const start = limit ? Math.max(0, fullContext.messages.length - limit) : 0;
    const context = limit ? {
      ...fullContext,
      messages: fullContext.messages.slice(start),
      entryIds: fullContext.entryIds.slice(start),
      truncated: start > 0,
      totalMessages: fullContext.messages.length,
    } : fullContext;

    return privateSessionJson({ context });
  } catch {
    return privateSessionJson({ error: "Failed to read session context" }, { status: 500 });
  }
}
