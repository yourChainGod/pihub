import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  MAX_INLINE_BASH_OUTPUT_BYTES,
  openRegularFileNoFollow,
  readUtf8FileWithinLimit,
  resolveBashOutputPath,
} from "@/lib/bash-output";
import { isBashOutputPathReferencedBySession } from "@/lib/session-file-references";
import { privateSessionJson, requireOwnedSession } from "@/lib/session-access";

// GET /api/agent/[id]/bash-output?path=<absPath>
// Reads a bash output temp file referenced by this session. Inline display is
// size-limited; download responses stream the file without buffering it.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = requireOwnedSession(req, id, "agents:use");
  if ("response" in access) return access.response;
  let path: string | null = null;
  let download = false;
  try {
    const url = new URL(req.url);
    path = url.searchParams.get("path");
    download = url.searchParams.get("download") === "1";
  } catch {
    return privateSessionJson({ error: "invalid url" }, { status: 400 });
  }

  if (!path) {
    return privateSessionJson({ error: "path required" }, { status: 400 });
  }

  const resolved = resolveBashOutputPath(path, tmpdir());
  if (!resolved) {
    return privateSessionJson({ error: "invalid path" }, { status: 400 });
  }

  if (!await isBashOutputPathReferencedBySession(resolved, id)) {
    return privateSessionJson({ error: "forbidden" }, { status: 403 });
  }

  try {
    if (download) {
      const { handle } = await openRegularFileNoFollow(resolved);
      const stream = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
      return new Response(stream, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": "attachment; filename=\"bash-output.log\"",
          "Cache-Control": "no-store",
        },
      });
    }

    const result = await readUtf8FileWithinLimit(resolved);
    if (result.tooLarge) {
      return privateSessionJson({
        error: `Full output is too large to display (limit ${MAX_INLINE_BASH_OUTPUT_BYTES} bytes)`,
        data: { size: result.size, maxBytes: MAX_INLINE_BASH_OUTPUT_BYTES },
      }, { status: 413 });
    }
    return privateSessionJson({ success: true, data: { output: result.content } });
  } catch {
    return privateSessionJson({ error: "full output unavailable" }, { status: 404 });
  }
}
