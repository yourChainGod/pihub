import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { privateSessionJson, requireOwnedSession } from "@/lib/session-access";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = requireOwnedSession(req, id, "sessions:read");
  if ("response" in access) return access.response;
  try {
    const rpc = getRpcSession(id, access.context.deviceId);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" });
      return privateSessionJson({ running: true, state });
    }

    if (!await resolveSessionPath(id)) {
      return privateSessionJson({ error: "Session not found" }, { status: 404 });
    }
    return privateSessionJson({ running: false });
  } catch {
    return privateSessionJson({ error: "Failed to read session state" }, { status: 500 });
  }
}
