import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { addWorktree, findCurrentWorktreePath, listWorktrees, removeWorktree, resolveProject } from "@/lib/worktree";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, type AllowedRootScope } from "@/lib/file-access";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { projectIdentityKey } from "@/lib/project-identity";
import { getProjectOperationTrustStatus } from "@/lib/project-trust";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

function privateJson(body: unknown, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", PRIVATE_NO_STORE["Cache-Control"]);
  return NextResponse.json(body, { ...init, headers });
}

/** Same gate as /api/files: only session cwds / project roots / explicitly
 *  allowed dirs may be inspected or mutated through this endpoint. */
async function checkCwdAllowed(cwd: string, scope: AllowedRootScope): Promise<NextResponse | null> {
  const allowedRoots = await getAllowedFileRoots(scope);
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return privateJson({ error: "Access denied" }, { status: 403 });
  }
  return null;
}

function isScopedExistingPathAllowed(path: string, allowedRoots: ReadonlySet<string>): boolean {
  return isFilePathAllowed(path, allowedRoots) && isExistingFilePathAllowed(path, allowedRoots);
}

function requestScope(
  request: Request,
  requiredCapability: "workspaces:read" | "workspaces:manage",
): { scope: AllowedRootScope } | { response: NextResponse } {
  const authentication = getTrustedPihubRequestContext(request);
  if (!authentication) {
    return { response: privateJson({ error: "Authentication required" }, { status: 401 }) };
  }
  if (!authentication.capabilities.includes(requiredCapability)) {
    return { response: privateJson({ error: "Insufficient device capability" }, { status: 403 }) };
  }
  return { scope: { ownerId: authentication.deviceId } };
}

async function checkMutationTrusted(cwd: string): Promise<NextResponse | null> {
  const trust = await getProjectOperationTrustStatus(cwd, getAgentDir());
  if (trust.requiresTrust && !trust.trusted) {
    return privateJson({
      error: "Trust this project before changing its worktrees",
      code: "project_trust_required",
    }, { status: 403 });
  }
  return null;
}

// GET /api/worktrees?cwd=  →  { projectRoot, projectKey, isGit, isTopLevel, currentWorktreePath, worktrees }
export async function GET(req: Request) {
  try {
    const authentication = requestScope(req, "workspaces:read");
    if ("response" in authentication) return authentication.response;
    const cwd = new URL(req.url).searchParams.get("cwd");
    if (!cwd) {
      return privateJson({ error: "cwd is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(cwd, authentication.scope);
    if (denied) return denied;

    const project = await resolveProject(cwd);
    const allowedRoots = await getAllowedFileRoots(authentication.scope);
    let worktrees: Awaited<ReturnType<typeof listWorktrees>> = [];
    let currentWorktreePath: string | null = null;
    let isGit = true;
    try {
      // For a removed-worktree cwd (session of a deleted worktree), fall back
      // to the inferred project root so the switcher still shows the project.
      worktrees = (await listWorktrees(existsSync(cwd) ? cwd : project.projectRoot))
        .filter((worktree) => isScopedExistingPathAllowed(worktree.path, allowedRoots));
      currentWorktreePath = findCurrentWorktreePath(worktrees, cwd);
    } catch {
      isGit = false;
    }
    const visibleProjectRoot = isScopedExistingPathAllowed(project.projectRoot, allowedRoots)
      ? project.projectRoot
      : cwd;
    return privateJson({
      projectRoot: visibleProjectRoot,
      projectKey: projectIdentityKey(visibleProjectRoot),
      isGit,
      isTopLevel: project.isTopLevel,
      currentWorktreePath,
      worktrees,
    });
  } catch {
    console.warn("Unable to list Git worktrees");
    return privateJson({ error: "Unable to list Git worktrees" }, { status: 500 });
  }
}

// POST /api/worktrees  body: { cwd, branch }  →  { path, branch }
export async function POST(req: Request) {
  try {
    const authentication = requestScope(req, "workspaces:manage");
    if ("response" in authentication) return authentication.response;
    const body = await req.json() as { cwd?: string; branch?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return privateJson({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.branch || typeof body.branch !== "string") {
      return privateJson({ error: "branch is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(body.cwd, authentication.scope);
    if (denied) return denied;
    if (!existsSync(body.cwd)) {
      return privateJson({ error: "Directory does not exist" }, { status: 400 });
    }
    const untrusted = await checkMutationTrusted(body.cwd);
    if (untrusted) return untrusted;

    const project = await resolveProject(body.cwd);
    const projectDenied = await checkCwdAllowed(project.projectRoot, authentication.scope);
    if (projectDenied) return projectDenied;

    const result = await addWorktree(body.cwd, body.branch, authentication.scope);
    return privateJson(result);
  } catch (error) {
    console.warn("Unable to create Git worktree");
    const invalidBranch = /Invalid branch name/.test(error instanceof Error ? error.message : "");
    return privateJson({
      error: invalidBranch ? "Invalid branch name" : "Unable to create Git worktree",
    }, { status: 400 });
  }
}

// DELETE /api/worktrees  body: { cwd, path, force? }
export async function DELETE(req: Request) {
  try {
    const authentication = requestScope(req, "workspaces:manage");
    if ("response" in authentication) return authentication.response;
    const body = await req.json() as { cwd?: string; path?: string; force?: boolean };
    if (!body.cwd || typeof body.cwd !== "string") {
      return privateJson({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.path || typeof body.path !== "string") {
      return privateJson({ error: "path is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(body.cwd, authentication.scope);
    if (denied) return denied;
    const targetDenied = await checkCwdAllowed(body.path, authentication.scope);
    if (targetDenied) return targetDenied;
    const untrusted = await checkMutationTrusted(body.cwd);
    if (untrusted) return untrusted;

    await removeWorktree(body.cwd, body.path, body.force === true, authentication.scope);
    return privateJson({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // git refuses to remove dirty worktrees without --force; surface that so
    // the UI can offer a force-remove confirmation.
    const dirty = /contains modified or untracked files|is dirty/i.test(message);
    console.warn("Unable to remove Git worktree");
    return privateJson({
      error: dirty ? "Worktree contains uncommitted changes" : "Unable to remove Git worktree",
      dirty,
    }, { status: dirty ? 409 : 400 });
  }
}
