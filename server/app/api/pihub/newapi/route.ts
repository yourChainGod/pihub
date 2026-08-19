import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getProviders } from "@earendil-works/pi-ai/compat";
import { invalidateModelsCache } from "@/lib/models-cache";
import {
  normalizeNewApiBaseUrl,
  readNewApiConfig,
  validateNewApiProviderName,
  writeNewApiConfig,
} from "@/lib/newapi-config-store";
import { removeStoredCredentialIfType, storeProviderCredential } from "@/lib/provider-credential-store";
import {
  assertLiteralCredential,
  OutboundRequestError,
  readBoundedJsonRequest,
} from "@/lib/outbound-http-security";
import { isApiRequestAllowed } from "@/lib/request-security";
import { reloadRpcSessions } from "@/lib/rpc-manager";
import { createSafeAgentSessionServices, createSafeModelRuntime } from "@/lib/safe-model-runtime";
import { privateRouteJson, requirePihubRouteCapability } from "@/lib/api-route-security";

export const dynamic = "force-dynamic";

async function credentialProviderIds(): Promise<Set<string>> {
  const runtime = await createSafeModelRuntime({ modelsPath: null });
  return new Set((await runtime.listCredentials()).filter((item) => item.type === "api_key").map((item) => item.providerId));
}

async function responseState() {
  const config = readNewApiConfig();
  const credentials = await credentialProviderIds();
  return {
    providers: Object.entries(config.providers).map(([name, provider]) => ({
      name,
      baseUrl: provider.baseUrl,
      allowTailnet: provider.allowTailnet === true,
      authenticated: credentials.has(name),
      overrideCount: Object.keys(provider.modelOverrides ?? {}).length,
    })),
    settings: {
      enableModelsDevEnrichment: config.settings.enableModelsDevEnrichment === true,
      sendSessionAffinityHeaders: config.settings.sendSessionAffinityHeaders === true,
    },
  };
}

async function forceRefresh(name: string, signal: AbortSignal) {
  const services = await createSafeAgentSessionServices({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    resourceLoaderOptions: {
      extensionFactories: [(await import("@/lib/newapi-provider")).createNewApiProviderExtension()],
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
    },
  });
  if (!services.modelRuntime.getProvider(name)) throw new Error(`Provider ${name} 尚未注册；请确认 PiHub Server 已加载内置 NewAPI Provider`);
  const result = await services.modelRuntime.refresh({ allowNetwork: true, force: true, providers: [name], signal });
  const refreshError = result.errors.get(name);
  if (refreshError) throw refreshError;
  return services.modelRuntime.getModels(name).length;
}

export async function GET(req: Request) {
  const access = requirePihubRouteCapability(req, "models:read");
  if ("response" in access) return access.response;
  if (!isApiRequestAllowed(req)) return privateRouteJson({ error: "Untrusted API request" }, { status: 403 });
  try {
    return privateRouteJson(await responseState());
  } catch {
    return privateRouteJson({ error: "Unable to read NewAPI settings" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const access = requirePihubRouteCapability(req, "models:manage");
  if ("response" in access) return access.response;
  if (!isApiRequestAllowed(req)) return privateRouteJson({ error: "Untrusted API request" }, { status: 403 });
  try {
    const parsed = await readBoundedJsonRequest(req, 64 * 1024);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return privateRouteJson({ error: "NewAPI request must be an object" }, { status: 400 });
    }
    const body = parsed as {
      action?: unknown;
      name?: unknown;
      baseUrl?: unknown;
      apiKey?: unknown;
      allowTailnet?: unknown;
      enableModelsDevEnrichment?: unknown;
      sendSessionAffinityHeaders?: unknown;
    };
    const action = body.action ?? "save";
    if (action !== "save" && action !== "delete" && action !== "refresh") {
      return privateRouteJson({ error: "Unsupported NewAPI action" }, { status: 400 });
    }
    const name = validateNewApiProviderName(typeof body.name === "string" ? body.name : "");
    const config = readNewApiConfig();

    if (action === "delete") {
      if (!config.providers[name]) return privateRouteJson({ error: "Provider not found" }, { status: 404 });
      delete config.providers[name];
      writeNewApiConfig(config);
      await removeStoredCredentialIfType(name, "api_key");
      invalidateModelsCache();
      await reloadRpcSessions();
      return privateRouteJson({ success: true, ...(await responseState()) });
    }

    if (action === "refresh") {
      if (!config.providers[name]) return privateRouteJson({ error: "Provider not found" }, { status: 404 });
      const modelCount = await forceRefresh(name, req.signal);
      invalidateModelsCache();
      return privateRouteJson({ success: true, modelCount, ...(await responseState()) });
    }

    const builtins = new Set((getProviders() as unknown as Array<string | { id?: string }>).map((item) => typeof item === "string" ? item : String(item.id ?? "")));
    if (!config.providers[name] && builtins.has(name)) throw new Error(`Provider 名称 ${name} 与 Pi 内置 Provider 冲突`);
    const allowTailnet = body.allowTailnet === true;
    const baseUrl = normalizeNewApiBaseUrl(typeof body.baseUrl === "string" ? body.baseUrl : "", { allowTailnet });
    config.providers[name] = {
      baseUrl,
      modelOverrides: config.providers[name]?.modelOverrides ?? {},
      ...(allowTailnet ? { allowTailnet: true } : {}),
    };
    const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
      ? assertLiteralCredential(body.apiKey, "NewAPI API key")
      : undefined;
    config.settings.enableModelsDevEnrichment = body.enableModelsDevEnrichment === true;
    config.settings.sendSessionAffinityHeaders = body.sendSessionAffinityHeaders === true;
    if (apiKey) await storeProviderCredential(name, { type: "api_key", key: apiKey });
    writeNewApiConfig(config);
    invalidateModelsCache();
    await reloadRpcSessions();
    return privateRouteJson({ success: true, ...(await responseState()) });
  } catch (error) {
    const safeValidationError = error instanceof OutboundRequestError
      || (error instanceof Error && error.message.startsWith("Provider "));
    return privateRouteJson(
      { error: safeValidationError && error instanceof Error ? error.message : "Unable to update NewAPI settings" },
      { status: error instanceof OutboundRequestError ? error.httpStatus : 400 },
    );
  }
}
