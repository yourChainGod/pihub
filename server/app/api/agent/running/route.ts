import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { privateSessionJson, requireTrustedPihubCapability } from "@/lib/session-access";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET(req: Request) {
  const access = requireTrustedPihubCapability(req, "agents:use");
  if ("response" in access) return access.response;
  return privateSessionJson({
    runningSessionIds: getRunningRpcSessionIds(access.context.deviceId),
  });
}
