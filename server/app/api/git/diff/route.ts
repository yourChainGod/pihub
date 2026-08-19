import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitFileDiff } from "@/lib/git-changes";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";

function privateJson(body: unknown, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

export async function GET(request: NextRequest) {
  try {
    const authentication = getTrustedPihubRequestContext(request);
    if (!authentication) return privateJson({ error: "Authentication required" }, { status: 401 });
    if (!authentication.capabilities.includes("workspaces:read")) {
      return privateJson({ error: "Insufficient device capability" }, { status: 403 });
    }
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const filePath = request.nextUrl.searchParams.get("path")?.trim() ?? "";
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return privateJson({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
      return privateJson({ error: "path must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots({ ownerId: authentication.deviceId });
    if (!isFilePathAllowed(cwd, allowedRoots) || !isFilePathAllowed(filePath, allowedRoots)) {
      return privateJson({ error: "Access denied" }, { status: 403 });
    }
    // The cwd must resolve inside an allowed root. The file itself may no
    // longer exist when Git reports it as deleted; getGitFileDiff verifies
    // that the requested path belongs to this repository and its status.
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return privateJson({ error: "Access denied" }, { status: 403 });
    }

    return privateJson(await getGitFileDiff(cwd, filePath));
  } catch {
    console.warn("Unable to read Git diff");
    return privateJson({ error: "Unable to read Git diff" }, { status: 500 });
  }
}
