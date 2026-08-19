import { NextResponse } from "next/server";
import type { SkillInstallScope } from "@/lib/api-types";
import { checkSkillUpdates } from "@/lib/skill-updates";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { readBoundedJsonRequest } from "@/lib/outbound-http-security";
import { hasJsonContentType } from "@/lib/request-security";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";

export const dynamic = "force-dynamic";

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

export async function POST(req: Request) {
  const authentication = getTrustedPihubRequestContext(req);
  if (!authentication) {
    return privateJson({ error: "Authentication required" }, { status: 401 });
  }
  if (!authentication.capabilities.includes("packages:read")) {
    return privateJson({ error: "Insufficient capability" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return privateJson({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await readBoundedJsonRequest(req, 16 * 1024) as {
      cwd?: unknown;
      package?: unknown;
      scope?: unknown;
    };
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    if (!cwd) return privateJson({ error: "cwd required" }, { status: 400 });
    const allowedRoots = await getAllowedFileRoots({ ownerId: authentication.deviceId });
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return privateJson({ error: "Access denied" }, { status: 403 });
    }

    const pkg = typeof body.package === "string" ? body.package : undefined;
    const scope = body.scope === "global" || body.scope === "project"
      ? body.scope as SkillInstallScope
      : undefined;
    if ((pkg && !scope) || (!pkg && scope)) {
      return privateJson({ error: "package and scope must be provided together" }, { status: 400 });
    }

    const { skills } = await loadSkillsWithInstallInfo(cwd);
    const installs = skills
      .map((skill) => skill.install)
      .filter((install): install is NonNullable<typeof install> => Boolean(install))
      .filter((install) => !pkg || (install.package === pkg && install.scope === scope));

    if (pkg && installs.length === 0) {
      return privateJson({ error: "Installed skill not found" }, { status: 404 });
    }

    const updates = await checkSkillUpdates(installs, {
      githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      signal: req.signal,
    });
    return privateJson({ updates });
  } catch {
    return privateJson(
      { error: "Unable to check skill updates" },
      { status: 500 },
    );
  }
}
