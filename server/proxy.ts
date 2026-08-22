import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidBasicAuthorization,
  isWebPasswordEnabled,
} from "@/lib/web-auth";
import {
  authenticatePihubApiRequest,
  PIHUB_AUTHENTICATED_CAPABILITIES_HEADER,
  PIHUB_AUTHENTICATED_CONTENT_SHA256_HEADER,
  PIHUB_AUTHENTICATED_DEVICE_HEADER,
} from "@/lib/pihub-auth";

function apiError(status: 401 | 403 | 413 | 503) {
  const messages = {
    401: "Authentication required",
    403: "Insufficient device capability",
    413: "Authenticated request payload is too large",
    503: "Authentication service unavailable",
  } as const;
  return NextResponse.json({ error: messages[status] }, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      ...(status === 401
        ? { "WWW-Authenticate": 'PiHub-HMAC-SHA256 realm="PiHub"' }
        : {}),
    },
  });
}

export async function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  if (isApiRequest) {
    const authentication = await authenticatePihubApiRequest(request);
    if (authentication.status === "unauthorized") return apiError(401);
    if (authentication.status === "forbidden") return apiError(403);
    if (authentication.status === "payload_too_large") return apiError(413);
    if (authentication.status === "unavailable") return apiError(503);

    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete(PIHUB_AUTHENTICATED_DEVICE_HEADER);
    requestHeaders.delete(PIHUB_AUTHENTICATED_CAPABILITIES_HEADER);
    requestHeaders.delete(PIHUB_AUTHENTICATED_CONTENT_SHA256_HEADER);
    if (authentication.status === "authenticated") {
      requestHeaders.set(PIHUB_AUTHENTICATED_DEVICE_HEADER, authentication.deviceId);
      requestHeaders.set(
        PIHUB_AUTHENTICATED_CAPABILITIES_HEADER,
        authentication.capabilities.join(","),
      );
      requestHeaders.set(
        PIHUB_AUTHENTICATED_CONTENT_SHA256_HEADER,
        authentication.expectedContentSha256,
      );
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const password = process.env.PIHUB_SERVER_PASSWORD ?? process.env.PI_WEB_PASSWORD;
  if (
    isWebPasswordEnabled(password)
    && !isValidBasicAuthorization(request.headers.get("authorization"), password)
  ) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="PiHub Server", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/api/:path*"] };
