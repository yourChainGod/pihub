import { NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";

export const dynamic = "force-dynamic";

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

// GET /api/skills?cwd=<path>
// Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json
// skill paths, package skills, and .agents/skills directories are all included.
export async function GET(req: Request) {
  const authentication = getTrustedPihubRequestContext(req);
  if (!authentication) {
    return privateJson({ error: "Authentication required" }, { status: 401 });
  }
  if (!authentication.capabilities.includes("packages:read")) {
    return privateJson({ error: "Insufficient capability" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return privateJson({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots({ ownerId: authentication.deviceId });
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return privateJson({ error: "Access denied" }, { status: 403 });
    }
    return privateJson(await loadSkillsWithInstallInfo(cwd));
  } catch {
    return privateJson({ error: "Unable to load skills" }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a SKILL.md file
export async function PATCH(req: Request) {
  const authentication = getTrustedPihubRequestContext(req);
  if (!authentication) {
    return privateJson({ error: "Authentication required" }, { status: 401 });
  }
  if (!authentication.capabilities.includes("packages:manage")) {
    return privateJson({ error: "Insufficient capability" }, { status: 403 });
  }

  try {
    const body = await req.json() as { filePath: string; disableModelInvocation: boolean };
    const { filePath, disableModelInvocation } = body;
    if (!filePath) return privateJson({ error: "filePath required" }, { status: 400 });
    if (!existsSync(filePath)) return privateJson({ error: "file not found" }, { status: 404 });
    const allowedRoots = new Set(await getAllowedFileRoots({ ownerId: authentication.deviceId }));
    allowedRoots.add(getAgentDir());
    // Globally installed skills live in ~/.agents/skills and are symlinked into
    // the agent's skills dir; isExistingFilePathAllowed resolves the symlink, so
    // the real target sits outside getAgentDir(). Allow the global skills root
    // too (the SDK always treats ~/.agents/skills as trusted).
    const globalSkillsDir = path.join(homedir(), ".agents", "skills");
    if (existsSync(globalSkillsDir)) allowedRoots.add(globalSkillsDir);
    if (!isExistingFilePathAllowed(filePath, allowedRoots)) {
      return privateJson({ error: "Access denied" }, { status: 403 });
    }

    const content = readFileSync(filePath, "utf8");
    const key = "disable-model-invocation";

    // Use parseFrontmatter to check current value, then do a surgical line edit
    // to preserve the original YAML formatting of all other fields.
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
    const alreadySet = Boolean(frontmatter[key]);

    let updated = content;
    if (disableModelInvocation && !alreadySet) {
      // Add key after the opening --- line
      updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
      // If no frontmatter exists, create one
      if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
    } else if (!disableModelInvocation && alreadySet) {
      // Remove the key line entirely
      updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
    }

    writeFileSync(filePath, updated, "utf8");
    return privateJson({ success: true });
  } catch {
    return privateJson({ error: "Unable to update the skill" }, { status: 500 });
  }
}
