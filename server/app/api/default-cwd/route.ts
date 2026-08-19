import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { allowFileRoot } from "@/lib/file-access";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

// POST /api/default-cwd
// Creates ~/pi-cwd if it doesn't exist and returns the path. A single stable
// scratch directory — the old daily pi-cwd-<YYYYMMDD> folders littered home.
export async function POST(req: Request) {
  const authentication = getTrustedPihubRequestContext(req);
  if (!authentication) {
    return privateJson({ error: "Authentication required" }, { status: 401 });
  }
  if (!authentication.capabilities.includes("workspaces:manage")) {
    return privateJson({ error: "Insufficient capability" }, { status: 403 });
  }

  try {
    const dir = join(homedir(), "pi-cwd");
    mkdirSync(dir, { recursive: true });
    const cwd = allowFileRoot(dir, { ownerId: authentication.deviceId });
    return privateJson({ cwd });
  } catch {
    return privateJson({ error: "Unable to create the default workspace" }, { status: 500 });
  }
}
