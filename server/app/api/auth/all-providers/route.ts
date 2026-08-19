import { buildApiKeyProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { createSafeModelRuntime } from "@/lib/safe-model-runtime";
import { privateRouteJson, requirePihubRouteCapability } from "@/lib/api-route-security";

export const dynamic = "force-dynamic";

// Providers that accept an API key, including dual-auth ones such as anthropic —
// see lib/provider-listing.ts for why membership is capability-based (#309).
export async function GET(request: Request) {
  const access = requirePihubRouteCapability(request, "providers:manage");
  if ("response" in access) return access.response;
  try {
    const modelRuntime = await createSafeModelRuntime({ modelsPath: null });
    const providers = buildApiKeyProviderList(await collectProviderListingInputs(modelRuntime));
    return privateRouteJson({ providers });
  } catch {
    return privateRouteJson({ error: "Unable to list authentication providers" }, { status: 500 });
  }
}
