import { invalidateModelsCache } from "@/lib/models-cache";
import { removeStoredCredentialIfType } from "@/lib/provider-credential-store";
import { createSafeModelRuntime } from "@/lib/safe-model-runtime";
import { privateRouteJson, requirePihubRouteCapability } from "@/lib/api-route-security";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const access = requirePihubRouteCapability(request, "providers:manage");
  if ("response" in access) return access.response;
  try {
    const { provider } = await params;
    const modelRuntime = await createSafeModelRuntime({ modelsPath: null });
    if (!modelRuntime.getProvider(provider)?.auth.oauth) {
      return privateRouteJson({ error: "OAuth provider not found" }, { status: 404 });
    }
    const removal = await removeStoredCredentialIfType(provider, "oauth");
    if (removal.status === "type_mismatch") {
      return privateRouteJson(
        { error: "Provider is authenticated with an API key" },
        { status: 409 },
      );
    }
    invalidateModelsCache();
    return privateRouteJson({ ok: true });
  } catch {
    return privateRouteJson({ error: "Unable to remove OAuth credentials" }, { status: 500 });
  }
}
