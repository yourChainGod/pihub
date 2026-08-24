import { NextResponse } from "next/server";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { randomUUID } from "crypto";
import {
  AllowedRootError,
  canonicalizeAllowedFileRoot,
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  type AllowedRootScope,
} from "@/lib/file-access";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { startRpcSession } from "@/lib/rpc-manager";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE });
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
export async function POST(req: Request) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const authentication = getTrustedPihubRequestContext(req);
    if (!authentication) {
      return json({ error: "Authentication required" }, 401);
    }
    if (!authentication.capabilities.includes("agents:use")) {
      return json({ error: "Insufficient device capability" }, 403);
    }
    const scope: AllowedRootScope = { ownerId: authentication.deviceId };
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (!cwd || typeof cwd !== "string") {
      return json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, 400);
    }
    const canonicalCwd = canonicalizeAllowedFileRoot(cwd);
    const allowedRoots = await getAllowedFileRoots(scope);
    if (!isExistingFilePathAllowed(canonicalCwd, allowedRoots)) {
      return json({
        error: "Access denied",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, 403);
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; [key: string]: unknown };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);

    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session. Date.now() (ms resolution) collides for
    // requests in the same millisecond, merging two new sessions into one.
    const tempKey = `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", canonicalCwd, {
      ownerId: authentication.deviceId,
      // No req.signal: session creation must survive a client disconnect.
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
    });

    invalidateSessionListCache();

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
    };

    if (promptCommand.type === "ensure_session") {
      return json({
        success: true,
        sessionId: realSessionId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
      });
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";

    return json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
    });
  } catch (error) {
    console.error("[pihub] agent/new request failed:", error instanceof Error ? error.message : error);
    const status = error instanceof AllowedRootError
      ? (error.code === "UNSAFE_ROOT" ? 403 : 400)
      : 500;
    const message = error instanceof AllowedRootError
      ? error.message
      : error instanceof Error && error.message.startsWith("Invalid thinking level:")
        ? "Invalid thinking level"
        : "Agent request failed";
    return json({
      error: message,
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, status);
  }
}
