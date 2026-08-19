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

export function privateSessionJson(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, {
    ...init,
    headers: pihubNoStoreHeaders(init.headers),
  });
}
