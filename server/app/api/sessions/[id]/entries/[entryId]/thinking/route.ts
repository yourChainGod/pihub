import { getSessionEntries, resolveSessionPath } from "@/lib/session-reader";
import { privateSessionJson, requireOwnedSession } from "@/lib/session-access";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
) {
  const { id, entryId } = await params;
  const access = requireOwnedSession(req, id, "sessions:read");
  if ("response" in access) return access.response;
  const blockIndexParam = new URL(req.url).searchParams.get("blockIndex");
  const blockIndex = blockIndexParam === null ? Number.NaN : Number(blockIndexParam);
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) {
    return privateSessionJson({ error: "Valid blockIndex is required" }, { status: 400 });
  }

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return privateSessionJson({ error: "Session not found" }, { status: 404 });

    // SessionManager-backed parsing preserves the SDK's malformed-line tolerance.
    const entry = getSessionEntries(filePath).find((candidate) => candidate.id === entryId);
    if (!entry || entry.type !== "message" || entry.message.role !== "assistant") {
      return privateSessionJson({ error: "Assistant message not found" }, { status: 404 });
    }

    const block = entry.message.content[blockIndex];
    if (!block || block.type !== "thinking") {
      return privateSessionJson({ error: "Thinking block not found" }, { status: 404 });
    }

    return privateSessionJson({ thinking: block.thinking });
  } catch {
    return privateSessionJson({ error: "Failed to read thinking block" }, { status: 500 });
  }
}
