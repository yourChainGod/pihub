import { getTrustedPihubRequestContext, type TrustedPihubRequestContext } from "./pihub-auth";
import { pihubNoStoreHeaders } from "./pihub-auth-http";
import type { PihubCapability } from "./pihub-auth-shared";

export type TrustedRouteAccess =
  | { context: TrustedPihubRequestContext }
  | { response: Response };

export function privateRouteJson(body: unknown, init: ResponseInit = {}): Response {
  const headers = pihubNoStoreHeaders(init.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  return Response.json(body, { ...init, headers });
}

export function requirePihubRouteCapability(
  request: Request,
  capability: PihubCapability,
): TrustedRouteAccess {
  const context = getTrustedPihubRequestContext(request);
  if (!context) {
    return {
      response: privateRouteJson(
        { error: "Authentication required" },
        {
          status: 401,
          headers: { "WWW-Authenticate": 'PiHub-HMAC-SHA256 realm="PiHub"' },
        },
      ),
    };
  }
  if (!context.capabilities.includes(capability)) {
    return {
      response: privateRouteJson(
        { error: "Insufficient device capability" },
        { status: 403 },
      ),
    };
  }
  return { context };
}
