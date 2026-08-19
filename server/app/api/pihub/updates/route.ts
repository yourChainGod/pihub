import { NextRequest, NextResponse } from "next/server";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import {
  isReleaseVersion,
  selectReleaseAsset,
  type ReleaseArchitecture,
  type ReleasePlatform,
} from "@/lib/release-manifest";
import {
  compareReleaseVersions,
} from "@/lib/update-engine";
import { readBoundedJsonRequest } from "@/lib/outbound-http-security";
import {
  fetchVerifiedServerReleaseManifest,
  SERVER_RELEASE_CHANNEL,
} from "@/lib/server-release";
import {
  isServerUpdateAccepted,
  isServerUpdateSupervisorAvailable,
  isServerUpdateSupervisorSnapshot,
  requestServerUpdateSupervisor,
  ServerUpdateIpcError,
} from "@/lib/server-update-ipc";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

function authorize(request: NextRequest): NextResponse | null {
  const authentication = getTrustedPihubRequestContext(request);
  if (!authentication) {
    return privateJson({ error: "Authentication required" }, { status: 401 });
  }
  if (!authentication.capabilities.includes("system:update")) {
    return privateJson({ error: "Insufficient capability" }, { status: 403 });
  }
  return null;
}

function targetPlatform(): { platform: ReleasePlatform; arch: ReleaseArchitecture } | null {
  if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
    return null;
  }
  if (process.arch !== "arm64" && process.arch !== "x64") return null;
  return { platform: process.platform, arch: process.arch };
}

export async function GET(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;
  const target = targetPlatform();
  if (!target) {
    return privateJson({ error: "Platform is not supported", code: "unsupported_platform" }, { status: 503 });
  }

  try {
    const installSupported = isServerUpdateSupervisorAvailable();
    const supervisorValue = installSupported
      ? await requestServerUpdateSupervisor("status")
      : null;
    if (supervisorValue !== null && !isServerUpdateSupervisorSnapshot(supervisorValue)) {
      throw new ServerUpdateIpcError("update_runtime_invalid", "Stable update launcher returned invalid state");
    }
    const manifest = await fetchVerifiedServerReleaseManifest();
    const asset = selectReleaseAsset(manifest, target.platform, target.arch);
    const fallbackVersion = process.env.PIHUB_SERVER_VERSION;
    const current = supervisorValue?.currentVersion
      ?? (isReleaseVersion(fallbackVersion) ? fallbackVersion : null);
    const updateAvailable = current === null || compareReleaseVersions(manifest.version, current) > 0;
    return privateJson({
      server: {
        current,
        latest: manifest.version,
        updateAvailable,
        platform: asset.platform,
        arch: asset.arch,
        channel: SERVER_RELEASE_CHANNEL,
      },
      installSupported,
      update: supervisorValue?.update ?? null,
      running: getRunningRpcSessionIds(),
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof ServerUpdateIpcError) {
      return privateJson(
        { error: "Stable update launcher is unavailable", code: error.code },
        { status: 503 },
      );
    }
    return privateJson(
      { error: "Signed public release could not be verified", code: "release_unavailable" },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;
  if (!isServerUpdateSupervisorAvailable()) {
    return privateJson(
      { error: "Stable update launcher is not installed", code: "update_runtime_unavailable" },
      { status: 503 },
    );
  }
  if (!targetPlatform()) {
    return privateJson({ error: "Platform is not supported", code: "unsupported_platform" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, 8 * 1024);
  } catch {
    return privateJson({ error: "Invalid update request" }, { status: 400 });
  }
  if (
    typeof body !== "object"
    || body === null
    || Array.isArray(body)
    || Object.keys(body).some((key) => key !== "action" && key !== "force")
    || (body as { action?: unknown }).action !== "apply"
    || ((body as { force?: unknown }).force !== undefined && typeof (body as { force?: unknown }).force !== "boolean")
  ) {
    return privateJson({ error: "Unsupported update action" }, { status: 400 });
  }

  const running = getRunningRpcSessionIds();
  if (running.length > 0 && (body as { force?: boolean }).force !== true) {
    return privateJson(
      { error: "Agent sessions are still running", code: "busy", running },
      { status: 409 },
    );
  }

  try {
    const accepted = await requestServerUpdateSupervisor("apply");
    if (!isServerUpdateAccepted(accepted)) {
      throw new ServerUpdateIpcError("update_runtime_invalid", "Stable update launcher returned invalid acknowledgement");
    }
    return privateJson(accepted, { status: 202 });
  } catch (error) {
    if (error instanceof ServerUpdateIpcError) {
      const status = error.code === "concurrent_update" ? 409 : 503;
      return privateJson(
        { error: "Server update could not be queued", code: error.code },
        { status },
      );
    }
    return privateJson({ error: "Server update could not be queued", code: "update_failed" }, { status: 500 });
  }
}
