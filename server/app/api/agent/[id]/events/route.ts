import { createAgentEventStream } from "@/lib/agent-event-stream";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { pihubNoStoreHeaders } from "@/lib/pihub-auth-http";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { getSessionOwner } from "@/lib/session-ownership";

export const dynamic = "force-dynamic";

function jsonError(status: 401 | 403 | 404 | 429 | 503, message: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: pihubNoStoreHeaders(status === 401
      ? { "WWW-Authenticate": 'PiHub-HMAC-SHA256 realm="PiHub"' }
      : undefined),
  });
}

function sseHeaders(): Headers {
  const headers = pihubNoStoreHeaders({
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  headers.set("Cache-Control", "no-store, no-cache, max-age=0, no-transform");
  return headers;
}

// GET /api/agent/[id]/events - authenticated SSE stream of agent events.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const trusted = getTrustedPihubRequestContext(req);
  if (!trusted) return jsonError(401, "Authentication required");
  if (!trusted.capabilities.includes("agents:use")) {
    return jsonError(403, "Insufficient device capability");
  }
  if (req.signal.aborted) {
    return new Response(null, { status: 204, headers: pihubNoStoreHeaders() });
  }

  const { id } = await params;
  let ownerId: string | null;
  try {
    ownerId = getSessionOwner(id);
  } catch {
    return jsonError(503, "Session access unavailable");
  }
  if (ownerId !== trusted.deviceId) {
    return jsonError(404, "Session not found");
  }
  const current = getRpcSession(id, trusted.deviceId);
  let knownFilePath: string | undefined;
  if (!current?.isAlive()) {
    const resolvedFilePath = await resolveSessionPath(id);
    if (!resolvedFilePath) return jsonError(404, "Session not found");
    knownFilePath = resolvedFilePath;
  }

  const result = createAgentEventStream(req, {
    deviceId: trusted.deviceId,
    sessionId: id,
    loadSession: async () => {
      const running = getRpcSession(id, trusted.deviceId);
      if (running?.isAlive()) return running;
      const filePath = knownFilePath ?? await resolveSessionPath(id);
      if (!filePath) throw new Error("Session not found");
      const started = await startRpcSession(id, filePath, undefined, {
        ownerId: trusted.deviceId,
        signal: req.signal,
      });
      return started.session;
    },
  });

  if (!result.accepted) {
    if (result.status === 204) {
      return new Response(null, { status: 204, headers: pihubNoStoreHeaders() });
    }
    return jsonError(
      result.status,
      result.status === 429 ? "Too many event streams" : "Event stream unavailable",
    );
  }
  return new Response(result.stream, { headers: sseHeaders() });
}
