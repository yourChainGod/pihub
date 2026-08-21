import { gzipSync } from "node:zlib";
import { getTrustedPihubRequestContext, type TrustedPihubRequestContext } from "./pihub-auth";
import { pihubNoStoreHeaders } from "./pihub-auth-http";
import type { PihubCapability } from "./pihub-auth-shared";
import { getSessionOwner } from "./session-ownership";

export type TrustedSessionAccess = {
  context: TrustedPihubRequestContext;
};

export type SessionAccessResult =
  | TrustedSessionAccess
  | { response: Response };

function jsonError(status: 401 | 403 | 404 | 503, message: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: pihubNoStoreHeaders(status === 401
      ? { "WWW-Authenticate": 'PiHub-HMAC-SHA256 realm="PiHub"' }
      : undefined),
  });
}

export function requireTrustedPihubCapability(
  request: Request,
  capability: PihubCapability,
): SessionAccessResult {
  const context = getTrustedPihubRequestContext(request);
  if (!context) return { response: jsonError(401, "Authentication required") };
  if (!context.capabilities.includes(capability)) {
    return { response: jsonError(403, "Insufficient device capability") };
  }
  return { context };
}

/**
 * Ownership failures deliberately share one 404 response. This prevents a
 * device from distinguishing another device's session from an unknown id.
 */
export function requireOwnedSession(
  request: Request,
  sessionId: string,
  capability: PihubCapability,
): SessionAccessResult {
  const access = requireTrustedPihubCapability(request, capability);
  if ("response" in access) return access;
  let ownerId: string | null;
  try {
    ownerId = getSessionOwner(sessionId);
  } catch {
    return { response: jsonError(503, "Session access unavailable") };
  }
  if (ownerId !== access.context.deviceId) {
    return { response: jsonError(404, "Session not found") };
  }
  return access;
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
// Tailscale Serve (Go httputil.ReverseProxy) strips the client's
// Accept-Encoding before forwarding, so Next's own compression never engages
// on the only path desktop clients use. Session payloads run to hundreds of
// KB over slow DERP relays, so encode large bodies ourselves — the proxy
// forwards an already-gzipped body untouched, and reqwest/browsers decode it
// transparently from the content-encoding header.
const GZIP_MIN_BYTES = 1024;

export function privateSessionJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = pihubNoStoreHeaders(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", JSON_CONTENT_TYPE);
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  if (bytes.length < GZIP_MIN_BYTES) {
    return new Response(bytes, { ...init, headers });
  }
  const compressed = gzipSync(bytes);
  headers.set("content-encoding", "gzip");
  return new Response(new Uint8Array(compressed), { ...init, headers });
}
