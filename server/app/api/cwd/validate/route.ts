import { NextResponse } from "next/server";
import { homedir } from "os";
import { isAbsolute, resolve } from "path";
import {
  AllowedRootError,
  allowFileRoot,
  canonicalizeAllowedFileRoot,
  type AllowedRootScope,
} from "@/lib/file-access";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { projectIdentityKey } from "@/lib/project-identity";
import { resolveProject } from "@/lib/worktree";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE });
}

function normalizeCwd(cwd: string): string | null {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/") || cwd.startsWith("~\\")) {
    return resolve(homedir(), cwd.slice(2));
  }
  return isAbsolute(cwd) ? cwd : null;
}

// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
export async function POST(req: Request) {
  try {
    const authentication = getTrustedPihubRequestContext(req);
    if (!authentication) {
      return json({ error: "Authentication required" }, 401);
    }
    if (!authentication.capabilities.includes("workspaces:manage")) {
      return json({ error: "Insufficient device capability" }, 403);
    }
    const scope: AllowedRootScope = { ownerId: authentication.deviceId };
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return json({ error: "Path is required" }, 400);
    }

    const normalizedCwd = normalizeCwd(cwd);
    if (!normalizedCwd) {
      return json({ error: "Workspace path must be absolute" }, 400);
    }
    const canonicalCwd = canonicalizeAllowedFileRoot(normalizedCwd);
    const project = await resolveProject(canonicalCwd);
    const canonicalProjectRoot = canonicalizeAllowedFileRoot(project.projectRoot);

    // Grant only after every path that will be returned has passed policy.
    const grantedCwd = allowFileRoot(canonicalCwd, scope);
    return json({
      success: true,
      cwd: grantedCwd,
      projectRoot: canonicalProjectRoot,
      projectKey: projectIdentityKey(canonicalProjectRoot),
    });
  } catch (error) {
    if (error instanceof AllowedRootError) {
      return json(
        { error: error.message },
        error.code === "UNSAFE_ROOT" ? 403 : 400,
      );
    }
    return json({ error: "Workspace validation failed" }, 500);
  }
}
