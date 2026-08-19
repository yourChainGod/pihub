import { NextResponse } from "next/server";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";

export const dynamic = "force-dynamic";

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

// Kept for API compatibility. Dynamic package execution remains unavailable
// until PiHub ships a signed catalog bound to immutable source hashes.
export async function POST(req: Request) {
  const authentication = getTrustedPihubRequestContext(req);
  if (!authentication) {
    return privateJson({ error: "Authentication required" }, { status: 401 });
  }
  if (!authentication.capabilities.includes("packages:manage")) {
    return privateJson({ error: "Insufficient capability" }, { status: 403 });
  }
  return privateJson({
    code: "signed_catalog_required",
    error: "Skill installation is unavailable until a signed immutable catalog is configured",
  }, { status: 410 });
}
