import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import {
  DirectoryEntryLimitError,
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

function privateJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE });
}

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
export async function GET(request: NextRequest) {
  try {
    const authentication = getTrustedPihubRequestContext(request);
    if (!authentication) {
      return privateJson({ error: "Authentication required" }, 401);
    }
    if (!authentication.capabilities.includes("workspaces:read")) {
      return privateJson({ error: "Insufficient device capability" }, 403);
    }

    const requested = request.nextUrl.searchParams.get("path")?.trim();

    if (shouldShowWindowsDrivePicker(requested)) {
      return privateJson({
        path: "",
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: [],
      });
    }

    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return privateJson({ error: "Directory does not exist" }, 404);
    }

    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return privateJson({ error: "Path is not a directory" }, 400);
    }

    const directories = await listDirectories(resolved);

    return privateJson({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    });
  } catch (error) {
    if (error instanceof DirectoryEntryLimitError) {
      return privateJson({ error: error.message }, 422);
    }
    return privateJson({ error: "Unable to browse directories" }, 500);
  }
}
