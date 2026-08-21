import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { privateSessionJson, requireOwnedSession } from "@/lib/session-access";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = requireOwnedSession(req, id, "agents:use");
  if ("response" in access) return access.response;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id, access.context.deviceId);
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return privateSessionJson({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return privateSessionJson({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ownerId: access.context.deviceId,
      signal: req.signal,
    });
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return privateSessionJson({ success: true, data: result });
  } catch (error) {
    console.error("[pihub] agent/[id] request failed:", error instanceof Error ? error.message : error);
    return privateSessionJson({
      error: "Agent request failed",
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = requireOwnedSession(req, id, "agents:use");
  if ("response" in access) return access.response;

  try {
    const session = getRpcSession(id, access.context.deviceId);
    if (!session || !session.isAlive()) {
      if (!await resolveSessionPath(id)) {
        return privateSessionJson({ error: "Session not found" }, { status: 404 });
      }
      return privateSessionJson({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return privateSessionJson({ running: true, state });
  } catch {
    return privateSessionJson({ error: "Failed to read agent state" }, { status: 500 });
  }
}
