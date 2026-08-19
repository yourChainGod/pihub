import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitStatus } from "@/lib/git-changes";
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
    if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
      return privateJson({ error: "cwd must be an absolute path" }, { status: 400 });
    }

    const allowedRoots = await getAllowedFileRoots({ ownerId: authentication.deviceId });
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return privateJson({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return privateJson({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return privateJson({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return privateJson({ error: "Access denied" }, { status: 403 });
    }

    return privateJson(await getGitStatus(cwd));
  } catch {
    console.warn("Unable to read Git status");
    return privateJson({ error: "Unable to read Git status" }, { status: 500 });
  }
}
