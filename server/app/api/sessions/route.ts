import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { getSessionOwners } from "@/lib/session-ownership";
import { privateSessionJson, requireTrustedPihubCapability } from "@/lib/session-access";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const access = requireTrustedPihubCapability(req, "sessions:read");
  if ("response" in access) return access.response;

  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const [persistedSessions, runtimeSessions] = await Promise.all([
      listAllSessions({ force, includeProjectInfo: false }),
      getRpcSessionInfos(access.context.deviceId),
    ]);
    const owners = getSessionOwners(persistedSessions.map((session) => session.id));
    const ownedPersistedSessions = persistedSessions.filter(
      (session) => owners.get(session.id) === access.context.deviceId,
    );
    const sessions = await attachSessionProjectInfo(
      mergeSessionLists(ownedPersistedSessions, runtimeSessions),
    );
    return privateSessionJson({
      sessions,
      runningSessionIds: getRunningRpcSessionIds(access.context.deviceId),
    });
  } catch {
    return privateSessionJson({ error: "Failed to list sessions" }, { status: 500 });
  }
}
