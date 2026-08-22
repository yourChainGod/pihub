import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { readBoundedJsonRequest } from "@/lib/outbound-http-security";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

function authorize(request: NextRequest): NextResponse | null {
  const ctx = getTrustedPihubRequestContext(request);
  if (!ctx) return privateJson({ error: "Authentication required" }, { status: 401 });
  if (!ctx.capabilities.includes("system:update")) {
    return privateJson({ error: "Insufficient capability" }, { status: 403 });
  }
  return null;
}

// ── Pi version helpers ──────────────────────────────────────────────────────

const PI_BINARY = process.env.PIHUB_PI_EXECUTABLE?.trim() || "pi";

async function getPiVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(PI_BINARY, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return stdout.trim().split(/\s+/).pop() ?? null;
  } catch {
    return null;
  }
}

async function getPiExtensions(): Promise<Array<{ name: string; version: string }>> {
  try {
    const { stdout } = await execFileAsync(PI_BINARY, ["list", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const data = JSON.parse(stdout) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter((e): e is { name: string; version: string } =>
      typeof e === "object" && e !== null &&
      typeof (e as Record<string, unknown>).name === "string" &&
      typeof (e as Record<string, unknown>).version === "string",
    );
  } catch {
    return [];
  }
}

// ── Pi update helpers ───────────────────────────────────────────────────────

type UpdateJobStatus = { status: "running" | "done" | "failed"; output: string; startedAt: string; finishedAt?: string };
const updateJobs = new Map<string, UpdateJobStatus>();

async function runPiUpdate(target: "self" | "extensions" | string): Promise<{ jobId: string }> {
  const { randomUUID } = await import("node:crypto");
  const jobId = randomUUID();
  const startedAt = new Date().toISOString();

  updateJobs.set(jobId, { status: "running", output: "", startedAt });

  // Run non-blocking — caller gets the jobId and polls /api/pihub/components?job=<id>
  setImmediate(async () => {
    const args = target === "self"
      ? ["update", "--self"]
      : target === "extensions"
        ? ["update", "--extensions"]
        : ["update", target];
    try {
      const { stdout, stderr } = await execFileAsync(PI_BINARY, args, {
        encoding: "utf8",
        timeout: 120_000,
      });
      updateJobs.set(jobId, { status: "done", output: (stdout + stderr).trim(), startedAt, finishedAt: new Date().toISOString() });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      updateJobs.set(jobId, { status: "failed", output: msg, startedAt, finishedAt: new Date().toISOString() });
    }
  });

  return { jobId };
}

// ── Server version ──────────────────────────────────────────────────────────

function getServerVersion(): string {
  return process.env.PIHUB_SERVER_VERSION ?? "unknown";
}

// ── Route handlers ──────────────────────────────────────────────────────────

/**
 * GET /api/pihub/components
 *
 * Returns version and status for all three layers:
 *   server   – PiHub Server
 *   pi       – Pi Agent (out-of-process)
 *   extensions – Pi-managed extensions
 */
export async function GET(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;

  const [piVersion, extensions] = await Promise.all([
    getPiVersion(),
    getPiExtensions(),
  ]);

  return privateJson({
    server: {
      current: getServerVersion(),
      mode: process.env.PIHUB_USE_IPC === "1" ? "ipc" : "legacy",
    },
    pi: {
      current: piVersion,
      available: piVersion !== null,
      binary: PI_BINARY,
    },
    extensions: {
      items: extensions,
      count: extensions.length,
      managedBy: "pi",
    },
    checkedAt: new Date().toISOString(),
  });
}

/**
 * POST /api/pihub/components
 *
 * Body: { component: "pi" | "extensions", action: "update", target?: string }
 *
 * component "pi"         → pi update --self
 * component "extensions" → pi update --extensions  (or pi update <name>)
 */
export async function POST(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, 4 * 1024);
  } catch {
    return privateJson({ error: "Invalid request body" }, { status: 400 });
  }

  if (
    typeof body !== "object" || body === null || Array.isArray(body)
  ) {
    return privateJson({ error: "Expected JSON object" }, { status: 400 });
  }

  const { component, action, target, force } = body as Record<string, unknown>;

  if (action !== "update") {
    return privateJson({ error: "Only 'update' action is supported" }, { status: 400 });
  }

  // Busy guard — same contract as /api/pihub/updates
  const running = getRunningRpcSessionIds();
  if (running.length > 0 && force !== true) {
    return privateJson(
      { error: "Agent sessions are still running", code: "busy", running },
      { status: 409 },
    );
  }

  if (component === "pi") {
    const currentPiVersion = await getPiVersion();
    if (currentPiVersion === null) {
      return privateJson({ error: "Pi Agent not found", code: "pi_unavailable" }, { status: 503 });
    }
    const job = await runPiUpdate("self");
    return privateJson({ accepted: true, jobId: job.jobId });
  }

  if (component === "extensions") {
    const extensionTarget = typeof target === "string" && target.trim() ? target.trim() : "extensions";
    const job = await runPiUpdate(extensionTarget);
    return privateJson({ accepted: true, jobId: job.jobId });
  }

  return privateJson(
    { error: "Unknown component; expected 'pi' or 'extensions'" },
    { status: 400 },
  );
}
