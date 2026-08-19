import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { pihubNoStoreHeaders } from "@/lib/pihub-auth-http";
import { createRunningEventStream } from "@/lib/running-event-stream";
import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

function jsonError(status: 401 | 403 | 429 | 503, message: string): Response {
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

// GET /api/agent/running/events - authenticated running-session snapshots.
export async function GET(req: Request) {
  const trusted = getTrustedPihubRequestContext(req);
  if (!trusted) return jsonError(401, "Authentication required");
  if (!trusted.capabilities.includes("agents:use")) {
    return jsonError(403, "Insufficient device capability");
  }

  const result = createRunningEventStream(req, {
    deviceId: trusted.deviceId,
    getSnapshot: () => getRunningRpcSessionIds(trusted.deviceId),
    subscribe: (listener) => subscribeRunningSessions(listener, trusted.deviceId),
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
