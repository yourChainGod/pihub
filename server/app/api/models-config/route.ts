import { readPublicModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import {
  OutboundRequestError,
  readBoundedJsonRequest,
} from "@/lib/outbound-http-security";
import { privateRouteJson, requirePihubRouteCapability } from "@/lib/api-route-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = requirePihubRouteCapability(request, "models:read");
  if ("response" in access) return access.response;
  try {
    return privateRouteJson(readPublicModelsConfig());
  } catch {
    return privateRouteJson({ error: "Unable to read models configuration" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const access = requirePihubRouteCapability(req, "models:manage");
  if ("response" in access) return access.response;
  try {
    const body = await readBoundedJsonRequest(req, 1024 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return privateRouteJson({ error: "Models configuration must be an object" }, { status: 400 });
    }
    writeModelsConfig(body as Record<string, unknown>);
    return privateRouteJson({ success: true });
  } catch (error) {
    const status = error instanceof OutboundRequestError ? error.httpStatus : 500;
    return privateRouteJson(
      { error: error instanceof OutboundRequestError ? error.message : "Unable to save models configuration" },
      { status },
    );
  }
}
