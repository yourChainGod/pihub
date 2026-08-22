/**
 * GET  /api/pihub/permissions       — list all rules (PiHub + Pi merged)
 * POST /api/pihub/permissions       — add a rule
 * DELETE /api/pihub/permissions     — remove a rule by pattern+scope
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { readBoundedJsonRequest } from "@/lib/outbound-http-security";
import { initializePermissions, type PermissionRule } from "@/lib/permissions-adapter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

function authorize(request: NextRequest) {
  const ctx = getTrustedPihubRequestContext(request);
  if (!ctx) return { error: privateJson({ error: "Authentication required" }, { status: 401 }) };
  if (!ctx.capabilities.includes("system:manage")) {
    return { error: privateJson({ error: "Insufficient capability" }, { status: 403 }) };
  }
  return { ctx };
}

async function getSystem() {
  return initializePermissions();
}

export async function GET(request: NextRequest) {
  const { error } = authorize(request);
  if (error) return error;

  try {
    const system = await getSystem();
    const rules = await system.getRules();
    return privateJson({ rules, readAt: new Date().toISOString() });
  } catch (err) {
    console.error("[permissions route] GET failed:", err);
    return privateJson({ error: "Failed to read permissions" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const { error } = authorize(request);
  if (error) return error;

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, 4 * 1024);
  } catch {
    return privateJson({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return privateJson({ error: "Expected JSON object" }, { status: 400 });
  }
  const { pattern, action, scope } = body as Record<string, unknown>;

  if (typeof pattern !== "string" || !pattern.trim()) {
    return privateJson({ error: "pattern is required" }, { status: 400 });
  }
  if (action !== "allow" && action !== "deny" && action !== "ask") {
    return privateJson({ error: "action must be allow, deny, or ask" }, { status: 400 });
  }

  const rule: PermissionRule = {
    pattern: pattern.trim().slice(0, 500),
    action: action as "allow" | "deny" | "ask",
    ...(typeof scope === "string" && scope.trim() ? { scope: scope.trim() } : {}),
  };

  try {
    const system = await getSystem();
    await system.addRule(rule);
    const rules = await system.getRules();
    return privateJson({ ok: true, rules });
  } catch (err) {
    console.error("[permissions route] POST failed:", err);
    return privateJson({ error: "Failed to add rule" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const { error } = authorize(request);
  if (error) return error;

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, 4 * 1024);
  } catch {
    return privateJson({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return privateJson({ error: "Expected JSON object" }, { status: 400 });
  }
  const { pattern } = body as Record<string, unknown>;
  if (typeof pattern !== "string" || !pattern.trim()) {
    return privateJson({ error: "pattern is required" }, { status: 400 });
  }

  try {
    // Load, filter out the matching rule, save.
    const system = await getSystem();
    const rules = await system.getRules();
    // Only remove PiHub-owned rules (scope !== "pi-native").
    const target = pattern.trim();
    const kept = rules.filter((r) => !(r.pattern === target && r.scope !== "pi-native"));
    if (kept.length === rules.length) {
      return privateJson({ error: "Rule not found or is pi-native (read-only)" }, { status: 404 });
    }

    // Re-initialize with kept rules by re-writing the config.
    const { existsSync, writeFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const dataRoot = join(homedir(), ".pihub");
    const configPath = join(dataRoot, "permissions.yml");
    if (existsSync(configPath)) {
      const config = { version: "1.0", syncToPi: true, rules: kept.filter((r) => r.scope !== "pi-native") };
      writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
      await system.syncToPi();
    }

    const refreshed = await system.getRules();
    return privateJson({ ok: true, rules: refreshed });
  } catch (err) {
    console.error("[permissions route] DELETE failed:", err);
    return privateJson({ error: "Failed to remove rule" }, { status: 500 });
  }
}
