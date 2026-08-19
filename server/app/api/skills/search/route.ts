import { NextResponse } from "next/server";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import {
  outboundErrorResponse,
  readBoundedJsonRequest,
} from "@/lib/outbound-http-security";
import { hasJsonContentType } from "@/lib/request-security";
import { searchSkillsCatalog } from "@/lib/skills-catalog";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

function parseLimit(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(num)));
}

// POST /api/skills/search  body: { query: string, limit?: number }
export async function POST(req: Request) {
  const authentication = getTrustedPihubRequestContext(req);
  if (!authentication) {
    return privateJson({ error: "Authentication required" }, { status: 401 });
  }
  if (!authentication.capabilities.includes("packages:read")) {
    return privateJson({ error: "Insufficient capability" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return privateJson({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await readBoundedJsonRequest(req, 8 * 1024) as { limit?: unknown; query?: unknown };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) return privateJson({ error: "query required" }, { status: 400 });
    const results = await searchSkillsCatalog(query, parseLimit(body.limit), req.signal);
    return privateJson({ results });
  } catch (error) {
    if (error instanceof RangeError) {
      return privateJson({ error: error.message }, { status: 400 });
    }
    const failure = outboundErrorResponse(error);
    return privateJson({ error: failure.error }, { status: failure.status });
  }
}
