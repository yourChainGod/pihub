import { buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { createSafeModelRuntime } from "@/lib/safe-model-runtime";
import { privateRouteJson, requirePihubRouteCapability } from "@/lib/api-route-security";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
export async function GET(request: Request) {
  const access = requirePihubRouteCapability(request, "providers:manage");
  if ("response" in access) return access.response;
  try {
    const modelRuntime = await createSafeModelRuntime({ modelsPath: null });
    const providers = buildOAuthProviderList(await collectProviderListingInputs(modelRuntime));
    return privateRouteJson({ providers });
  } catch {
    return privateRouteJson({ error: "Unable to list authentication providers" }, { status: 500 });
  }
}
