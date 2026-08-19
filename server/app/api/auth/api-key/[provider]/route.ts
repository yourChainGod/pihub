import { invalidateModelsCache } from "@/lib/models-cache";
import { removeStoredCredentialIfType, storeProviderCredential } from "@/lib/provider-credential-store";
import { createSafeModelRuntime } from "@/lib/safe-model-runtime";
import { privateRouteJson, requirePihubRouteCapability } from "@/lib/api-route-security";
import { readPihubAuthJsonBody } from "@/lib/pihub-auth-http";
import { PihubAuthInputError } from "@/lib/pihub-auth-shared";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

// GET /api/auth/api-key/[provider] — returns auth status (never returns the actual key)
export async function GET(request: Request, { params }: Params) {
  const access = requirePihubRouteCapability(request, "providers:manage");
  if ("response" in access) return access.response;
  try {
    const { provider } = await params;
    const modelRuntime = await createSafeModelRuntime({ modelsPath: null });
    const registered = modelRuntime.getProvider(provider);
    if (!registered) return privateRouteJson({ error: "Provider not found" }, { status: 404 });
    const status = modelRuntime.getProviderAuthStatus(provider);
    const models = modelRuntime.getModels(provider).length;
    return privateRouteJson({
      provider,
      displayName: registered.name,
      configured: status.configured,
      source: status.source,
      models,
    });
  } catch {
    return privateRouteJson({ error: "Unable to read API key status" }, { status: 500 });
  }
}

// POST /api/auth/api-key/[provider]  body: { apiKey: string }
export async function POST(req: Request, { params }: Params) {
  const access = requirePihubRouteCapability(req, "providers:manage");
  if ("response" in access) return access.response;
  try {
    const { provider } = await params;
    const { apiKey } = await readPihubAuthJsonBody(req, 16 * 1024);
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      return privateRouteJson({ error: "apiKey is required" }, { status: 400 });
    }
    const modelRuntime = await createSafeModelRuntime({ modelsPath: null });
    const apiKeyAuth = modelRuntime.getProvider(provider)?.auth.apiKey;
    if (!apiKeyAuth?.login) {
      return privateRouteJson({ error: "API key provider not found" }, { status: 404 });
    }
    let keySubmitted = false;
    const credential = await apiKeyAuth.login({
      signal: req.signal,
      notify: () => {},
      prompt: async (prompt) => {
        if (prompt.type === "select") {
          const keyOption = prompt.options.find((option) => option.id === "api-key" || option.id === "bearer-token");
          if (keyOption) return keyOption.id;
          throw new Error(`${provider} requires interactive authentication setup`);
        }
        if (!keySubmitted && prompt.type === "secret") {
          keySubmitted = true;
          return apiKey.trim();
        }
        throw new Error(`${provider} requires additional authentication settings`);
      },
    });
    // ModelRuntime.login() persists the credential and then performs an
    // unbounded network catalog refresh. Store the returned credential
    // directly so a slow catalog cannot leave the save request hanging.
    await storeProviderCredential(provider, credential);
    invalidateModelsCache();
    return privateRouteJson({ success: true });
  } catch (error) {
    return privateRouteJson(
      { error: error instanceof PihubAuthInputError ? "Invalid request" : "Unable to save API key" },
      { status: error instanceof PihubAuthInputError ? 400 : 500 },
    );
  }
}

// DELETE /api/auth/api-key/[provider] — removes stored API key
export async function DELETE(request: Request, { params }: Params) {
  const access = requirePihubRouteCapability(request, "providers:manage");
  if ("response" in access) return access.response;
  try {
    const { provider } = await params;
    const modelRuntime = await createSafeModelRuntime({ modelsPath: null });
    if (!modelRuntime.getProvider(provider)) {
      return privateRouteJson({ error: "Provider not found" }, { status: 404 });
    }
    const removal = await removeStoredCredentialIfType(provider, "api_key");
    if (removal.status === "type_mismatch") {
      return privateRouteJson(
        { error: "Provider is authenticated with OAuth" },
        { status: 409 },
      );
    }
    invalidateModelsCache();
    return privateRouteJson({ success: true });
  } catch {
    return privateRouteJson({ error: "Unable to remove API key" }, { status: 500 });
  }
}
