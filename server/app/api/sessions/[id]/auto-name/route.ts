import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { privateSessionJson, requireOwnedSession } from "@/lib/session-access";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = requireOwnedSession(req, id, "sessions:write");
  if ("response" in access) return access.response;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return privateSessionJson({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id, access.context.deviceId);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined, {
          ownerId: access.context.deviceId,
          signal: req.signal,
        });

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      return privateSessionJson(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return privateSessionJson({ title: result.title, usage: result.usage ?? null });
  } catch {
    return privateSessionJson(
      { error: "Failed to name session" },
      { status: 500 },
    );
  }
}
