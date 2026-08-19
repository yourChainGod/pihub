import { stat } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { getProjectOperationTrustStatus, trustProjectOperation } from "@/lib/project-trust";
import { destroyRpcSessionsForCwd, hasBusyRpcSessionForCwd } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

function privateJson(body: unknown, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", PRIVATE_NO_STORE["Cache-Control"]);
  return NextResponse.json(body, { ...init, headers });
}

async function validateCwd(value: unknown, ownerId: string): Promise<
  { cwd: string } | { response: NextResponse }
> {
  if (typeof value !== "string" || !value.trim()) {
    return { response: privateJson({ error: "cwd required" }, { status: 400 }) };
  }
  if (!isAbsolute(value)) {
    return { response: privateJson({ error: "cwd must be an absolute path" }, { status: 400 }) };
  }

  const cwd = resolve(value);
  try {
    if (!(await stat(cwd)).isDirectory()) {
      return { response: privateJson({ error: "cwd must be a directory" }, { status: 400 }) };
    }
  } catch {
    return { response: privateJson({ error: "Directory does not exist" }, { status: 400 }) };
  }

  const allowedRoots = await getAllowedFileRoots({ ownerId });
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { response: privateJson({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

export async function GET(req: Request) {
  try {
    const authentication = getTrustedPihubRequestContext(req);
    if (!authentication) return privateJson({ error: "Authentication required" }, { status: 401 });
    if (!authentication.capabilities.includes("workspaces:read")) {
      return privateJson({ error: "Insufficient device capability" }, { status: 403 });
    }
    const result = await validateCwd(
      new URL(req.url).searchParams.get("cwd"),
      authentication.deviceId,
    );
    if ("response" in result) return result.response;
    return privateJson(await getProjectOperationTrustStatus(result.cwd, getAgentDir()));
  } catch {
    console.warn("Unable to read project trust");
    return privateJson({ error: "Unable to read project trust" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const authentication = getTrustedPihubRequestContext(req);
    if (!authentication) return privateJson({ error: "Authentication required" }, { status: 401 });
    if (!authentication.capabilities.includes("workspaces:manage")) {
      return privateJson({ error: "Insufficient device capability" }, { status: 403 });
    }
    const body = await req.json() as { cwd?: unknown };
    const result = await validateCwd(body.cwd, authentication.deviceId);
    if ("response" in result) return result.response;

    const agentDir = getAgentDir();
    const current = await getProjectOperationTrustStatus(result.cwd, agentDir);
    if (!current.requiresTrust) {
      return privateJson({ error: "This project has no resources that require trust" }, { status: 409 });
    }
    if (hasBusyRpcSessionForCwd(result.cwd)) {
      return privateJson({ error: "Wait for the active session to finish before trusting this project" }, { status: 409 });
    }

    const status = trustProjectOperation(result.cwd, agentDir);
    invalidateModelsCache();
    await destroyRpcSessionsForCwd(result.cwd);
    return privateJson(status);
  } catch {
    console.warn("Unable to update project trust");
    return privateJson({ error: "Unable to update project trust" }, { status: 500 });
  }
}
