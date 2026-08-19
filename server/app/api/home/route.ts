import { NextResponse } from "next/server";
import { homedir } from "os";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

function privateJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE });
}

export async function GET(request: Request) {
  const authentication = getTrustedPihubRequestContext(request);
  if (!authentication) {
    return privateJson({ error: "Authentication required" }, 401);
  }
  if (!authentication.capabilities.includes("workspaces:read")) {
    return privateJson({ error: "Insufficient device capability" }, 403);
  }
  return privateJson({ home: homedir() });
}
