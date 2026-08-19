import { join, resolve } from "node:path";
import {
  lazyStream,
  type Api,
  type Context,
  type Model,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  type AgentSessionServices,
  type CreateAgentSessionServicesOptions,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";
import {
  assertOutboundUrlAllowed,
  createSecureOutboundFetch,
  OutboundRequestError,
  type OutboundPolicy,
} from "./outbound-http-security";
import {
  assertStoredModelsConfigSafe,
  getModelsConfigPath,
  isLocalModelDevelopmentAllowed,
  readModelsConfig,
} from "./models-config-store";
import { readNewApiConfig } from "./newapi-config-store";

const FETCH_INJECTABLE_APIS = new Set<Api>([
  "anthropic-messages",
  "azure-openai-responses",
  "mistral-conversations",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
  "pi-messages",
]);
const UNSUPPORTED_TRANSPORT_APIS = new Set<Api>([
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
]);
const UNSUPPORTED_PROVIDER_IDS = new Set([
  "amazon-bedrock",
  "google",
  "google-vertex",
]);
const SAFE_HOOK_HEADER_NAMES = new Set([
  "accept",
  "accept-encoding",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
  "openai-beta",
  "user-agent",
]);
const REDACTED_HEADER_VALUE = "[REDACTED]";
const MODEL_SETUP_TIMEOUT_MS = 120_000;
const MODEL_CONNECT_TIMEOUT_MS = 10_000;
const MODEL_IDLE_TIMEOUT_MS = 300_000;
const MODEL_MAX_IDLE_TIMEOUT_MS = 10 * 60_000;
const MODEL_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MODEL_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const HARDENED_RUNTIME = Symbol.for("pihub.safe-model-runtime.hardened");
export const UNSUPPORTED_MODEL_TRANSPORT_CODE = "unsupported_transport";
export const UNSUPPORTED_MODEL_TRANSPORT_MESSAGE = "unsupported_transport: provider transport is unavailable";

type ProviderRequestOptions = Record<string, unknown> & {
  client?: unknown;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
  transport?: string;
};

type MutableModelRuntime = ModelRuntime & {
  [HARDENED_RUNTIME]?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveTimeout(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback;
}

function isRegisteredNewApiProvider(
  providerId: string,
  getProvider: (id: string) => ReturnType<ModelRuntime["getProvider"]>,
): boolean {
  try {
    return readNewApiConfig().providers[providerId] !== undefined
      && getProvider(providerId)?.name === `NewAPI (${providerId})`;
  } catch {
    return false;
  }
}

function configuredProviderTransportPolicy(modelsPath: string | null | undefined): {
  safe: Set<string>;
  blocked: Set<string>;
} {
  const safe = new Set<string>();
  const blocked = new Set<string>();
  if (!modelsPath) return { safe, blocked };
  const providers = readModelsConfig(modelsPath).providers;
  if (!isRecord(providers)) return { safe, blocked };

  for (const [providerId, value] of Object.entries(providers)) {
    if (!isRecord(value)) continue;
    if (UNSUPPORTED_PROVIDER_IDS.has(providerId) || value.oauth !== undefined) {
      blocked.add(providerId);
      continue;
    }
    if (!Array.isArray(value.models)) continue;
    const providerApi = typeof value.api === "string" ? value.api : undefined;
    if (value.models.some((entry) => {
      if (!isRecord(entry)) return false;
      const api = typeof entry.api === "string" ? entry.api : providerApi;
      return FETCH_INJECTABLE_APIS.has(api as Api) && !UNSUPPORTED_TRANSPORT_APIS.has(api as Api);
    })) {
      safe.add(providerId);
    }
  }
  return { safe, blocked };
}

function modelOutboundPolicy(
  runtime: ModelRuntime,
  model: Model<Api>,
  options?: ProviderRequestOptions,
): OutboundPolicy {
  const newApi = (() => {
    try {
      return isRegisteredNewApiProvider(model.provider, runtime.getProvider.bind(runtime))
        ? readNewApiConfig().providers[model.provider]
        : undefined;
    } catch {
      return undefined;
    }
  })();
  return {
    allowTailnet: newApi?.allowTailnet === true,
    allowLocalhost: isLocalModelDevelopmentAllowed(),
    timeoutMs: MODEL_SETUP_TIMEOUT_MS,
    connectTimeoutMs: MODEL_CONNECT_TIMEOUT_MS,
    headersTimeoutMs: MODEL_SETUP_TIMEOUT_MS,
    idleTimeoutMs: positiveTimeout(options?.timeoutMs, MODEL_IDLE_TIMEOUT_MS, MODEL_MAX_IDLE_TIMEOUT_MS),
    streamResponse: true,
    maxRequestBytes: MODEL_MAX_REQUEST_BYTES,
    maxResponseBytes: MODEL_MAX_RESPONSE_BYTES,
    maxRedirects: 3,
  };
}

function assertSecureTransportSupported(model: Model<Api>, options?: ProviderRequestOptions): void {
  if (options?.client !== undefined) {
    throw new OutboundRequestError(
      "forbidden_target",
      "Preconfigured provider clients are not allowed",
      400,
    );
  }
  if (hasSecureModelTransport(model)) return;
  throw unsupportedTransportError();
}

function unsupportedTransportError(): OutboundRequestError {
  return new OutboundRequestError(
    UNSUPPORTED_MODEL_TRANSPORT_CODE,
    UNSUPPORTED_MODEL_TRANSPORT_MESSAGE,
    400,
  );
}

function hasSecureModelTransport(model: Model<Api>): boolean {
  return !UNSUPPORTED_PROVIDER_IDS.has(model.provider)
    && FETCH_INJECTABLE_APIS.has(model.api)
    && !UNSUPPORTED_TRANSPORT_APIS.has(model.api);
}

function headerName(headers: ProviderHeaders, lowerName: string): string | undefined {
  return Object.keys(headers).find((name) => name.toLowerCase() === lowerName);
}

function redactHeadersForHook(headers: ProviderHeaders): ProviderHeaders {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    value === null || SAFE_HOOK_HEADER_NAMES.has(name.toLowerCase()) || name.toLowerCase().startsWith("x-stainless-")
      ? value
      : REDACTED_HEADER_VALUE,
  ]));
}

function restoreHookHeaderSecrets(original: ProviderHeaders, transformed: ProviderHeaders): ProviderHeaders {
  const restored = { ...transformed };
  for (const [name, value] of Object.entries(original)) {
    if (value === null || SAFE_HOOK_HEADER_NAMES.has(name.toLowerCase()) || name.toLowerCase().startsWith("x-stainless-")) {
      continue;
    }
    const transformedName = headerName(restored, name.toLowerCase());
    if (transformedName && restored[transformedName] === REDACTED_HEADER_VALUE) {
      restored[transformedName] = value;
    }
  }
  return restored;
}

function secureProviderOptions(
  model: Model<Api>,
  options: ProviderRequestOptions | undefined,
  policy: OutboundPolicy,
): ProviderRequestOptions {
  assertSecureTransportSupported(model, options);
  const transformHeaders = options?.transformHeaders;
  return {
    ...(options ?? {}),
    fetch: createSecureOutboundFetch(policy),
    ...(model.api === "openai-codex-responses" ? { transport: "sse" } : {}),
    ...(transformHeaders
      ? {
          transformHeaders: async (headers: ProviderHeaders) => restoreHookHeaderSecrets(
            headers,
            await transformHeaders(redactHeadersForHook(headers)),
          ),
        }
      : {}),
  };
}

async function assertModelTargetAllowed(model: Model<Api>, policy: OutboundPolicy): Promise<void> {
  if (typeof model.baseUrl !== "string" || !model.baseUrl.trim()) {
    throw new OutboundRequestError("invalid_url", "Provider base URL is required", 400);
  }
  await assertOutboundUrlAllowed(model.baseUrl, policy);
}

/** Apply the final request boundary after models.json, extension and auth overlays. */
export function hardenModelRuntime(
  runtime: ModelRuntime,
  modelsPath?: string | null,
): ModelRuntime {
  const mutable = runtime as MutableModelRuntime;
  if (mutable[HARDENED_RUNTIME]) return runtime;

  const originalGetProviders = runtime.getProviders.bind(runtime);
  const originalGetProvider = runtime.getProvider.bind(runtime);
  const originalStream = runtime.stream.bind(runtime);
  const originalStreamSimple = runtime.streamSimple.bind(runtime);
  const originalFetchDeferred = runtime.fetchDeferred.bind(runtime);
  const originalCancelDeferred = runtime.cancelDeferred.bind(runtime);
  const originalRefresh = runtime.refresh.bind(runtime);
  const originalGetModels = runtime.getModels.bind(runtime);
  const originalGetModel = runtime.getModel.bind(runtime);
  const originalGetAvailable = runtime.getAvailable.bind(runtime);
  const originalGetAvailableSnapshot = runtime.getAvailableSnapshot.bind(runtime);
  const originalCheckAuth = runtime.checkAuth.bind(runtime);
  const originalGetAuth = runtime.getAuth.bind(runtime) as ModelRuntime["getAuth"];
  const originalGetProviderAuthStatus = runtime.getProviderAuthStatus.bind(runtime);
  const originalIsUsingOAuth = runtime.isUsingOAuth.bind(runtime);
  const originalIsUsingSubscription = runtime.isUsingSubscription.bind(runtime);
  const originalHasConfiguredAuth = runtime.hasConfiguredAuth.bind(runtime);
  const originalSetRuntimeApiKey = runtime.setRuntimeApiKey.bind(runtime);
  const originalRemoveRuntimeApiKey = runtime.removeRuntimeApiKey.bind(runtime);
  const originalLogin = runtime.login.bind(runtime);
  const originalLogout = runtime.logout.bind(runtime);

  const safeProviderIds = (): Set<string> => {
    const configured = configuredProviderTransportPolicy(modelsPath);
    const safe = new Set(configured.safe);
    for (const model of originalGetModels()) {
      if (hasSecureModelTransport(model) && !configured.blocked.has(model.provider)) {
        safe.add(model.provider);
      }
    }
    for (const provider of originalGetProviders()) {
      if (!configured.blocked.has(provider.id)
        && !UNSUPPORTED_PROVIDER_IDS.has(provider.id)
        && isRegisteredNewApiProvider(provider.id, originalGetProvider)) {
        safe.add(provider.id);
      }
    }
    return safe;
  };
  const assertProviderTransportSupported = (providerId: string): void => {
    if (!safeProviderIds().has(providerId)) throw unsupportedTransportError();
  };

  runtime.getProviders = (() => {
    const safe = safeProviderIds();
    return originalGetProviders().filter((provider) => safe.has(provider.id));
  }) as ModelRuntime["getProviders"];

  runtime.getProvider = ((providerId: string) => (
    safeProviderIds().has(providerId) ? originalGetProvider(providerId) : undefined
  )) as ModelRuntime["getProvider"];

  runtime.getModels = ((providerId?: string) => (
    originalGetModels(providerId).filter(hasSecureModelTransport)
  )) as ModelRuntime["getModels"];

  runtime.getModel = ((providerId: string, modelId: string) => {
    const model = originalGetModel(providerId, modelId);
    return model && hasSecureModelTransport(model) ? model : undefined;
  }) as ModelRuntime["getModel"];

  runtime.getAvailable = (async (providerId, options) => {
    const safe = safeProviderIds();
    if (providerId !== undefined) {
      if (!safe.has(providerId)) return [];
      return (await originalGetAvailable(providerId, options)).filter(hasSecureModelTransport);
    }
    const available = await Promise.all([...safe].map((id) => originalGetAvailable(id, options)));
    return available.flat().filter(hasSecureModelTransport);
  }) as ModelRuntime["getAvailable"];

  runtime.getAvailableSnapshot = (() => (
    originalGetAvailableSnapshot().filter(hasSecureModelTransport)
  )) as ModelRuntime["getAvailableSnapshot"];

  runtime.checkAuth = (async (providerId, options) => {
    assertProviderTransportSupported(providerId);
    return originalCheckAuth(providerId, options);
  }) as ModelRuntime["checkAuth"];

  runtime.getAuth = (async (providerOrModel, overrides = {}) => {
    if (typeof providerOrModel === "string") {
      assertProviderTransportSupported(providerOrModel);
      return originalGetAuth(providerOrModel, overrides);
    }
    assertSecureTransportSupported(providerOrModel);
    assertProviderTransportSupported(providerOrModel.provider);
    return originalGetAuth(providerOrModel, overrides);
  }) as ModelRuntime["getAuth"];

  runtime.getProviderAuthStatus = ((providerId: string) => (
    safeProviderIds().has(providerId)
      ? originalGetProviderAuthStatus(providerId)
      : { configured: false }
  )) as ModelRuntime["getProviderAuthStatus"];

  runtime.isUsingOAuth = ((providerId: string) => (
    safeProviderIds().has(providerId) && originalIsUsingOAuth(providerId)
  )) as ModelRuntime["isUsingOAuth"];

  runtime.isUsingSubscription = ((providerId: string) => (
    safeProviderIds().has(providerId) && originalIsUsingSubscription(providerId)
  )) as ModelRuntime["isUsingSubscription"];

  runtime.hasConfiguredAuth = ((providerId: string) => (
    safeProviderIds().has(providerId) && originalHasConfiguredAuth(providerId)
  )) as ModelRuntime["hasConfiguredAuth"];

  runtime.setRuntimeApiKey = (async (providerId, apiKey, options) => {
    assertProviderTransportSupported(providerId);
    return originalSetRuntimeApiKey(providerId, apiKey, options);
  }) as ModelRuntime["setRuntimeApiKey"];

  runtime.removeRuntimeApiKey = (async (providerId, options) => {
    assertProviderTransportSupported(providerId);
    return originalRemoveRuntimeApiKey(providerId, options);
  }) as ModelRuntime["removeRuntimeApiKey"];

  runtime.login = (async (providerId, type, interaction) => {
    assertProviderTransportSupported(providerId);
    return originalLogin(providerId, type, interaction);
  }) as ModelRuntime["login"];

  runtime.logout = (async (providerId, options) => {
    assertProviderTransportSupported(providerId);
    return originalLogout(providerId, options);
  }) as ModelRuntime["logout"];

  runtime.stream = ((model: Model<Api>, context: Context, options?: ProviderRequestOptions) => lazyStream(model, async () => {
    const policy = modelOutboundPolicy(runtime, model, options);
    assertSecureTransportSupported(model, options);
    await assertModelTargetAllowed(model, policy);
    return originalStream(model, context, secureProviderOptions(model, options, policy) as never);
  })) as ModelRuntime["stream"];

  runtime.streamSimple = ((model: Model<Api>, context: Context, options?: ProviderRequestOptions) => lazyStream(model, async () => {
    const policy = modelOutboundPolicy(runtime, model, options);
    assertSecureTransportSupported(model, options);
    await assertModelTargetAllowed(model, policy);
    return originalStreamSimple(model, context, secureProviderOptions(model, options, policy) as never);
  })) as ModelRuntime["streamSimple"];

  runtime.fetchDeferred = (async (model, handle, options) => {
    const providerOptions = options as ProviderRequestOptions | undefined;
    const policy = modelOutboundPolicy(runtime, model, providerOptions);
    assertSecureTransportSupported(model, providerOptions);
    await assertModelTargetAllowed(model, policy);
    return originalFetchDeferred(model, handle, secureProviderOptions(model, providerOptions, policy));
  }) as ModelRuntime["fetchDeferred"];

  runtime.cancelDeferred = (async (model, handle, options) => {
    const providerOptions = options as ProviderRequestOptions | undefined;
    const policy = modelOutboundPolicy(runtime, model, providerOptions);
    assertSecureTransportSupported(model, providerOptions);
    await assertModelTargetAllowed(model, policy);
    return originalCancelDeferred(model, handle, secureProviderOptions(model, providerOptions, policy));
  }) as ModelRuntime["cancelDeferred"];

  runtime.refresh = (async (options = {}) => {
    if (modelsPath) assertStoredModelsConfigSafe(modelsPath);
    const safe = safeProviderIds();
    const requestedProviders = options.providers ?? [...safe];
    const providers = [...new Set(requestedProviders.filter((providerId) => safe.has(providerId)))];
    const safeExplicitRefresh = options.allowNetwork === true
      && providers.length > 0
      && providers.every((providerId) => isRegisteredNewApiProvider(providerId, originalGetProvider));
    return originalRefresh({
      ...options,
      providers,
      allowNetwork: safeExplicitRefresh,
    });
  }) as ModelRuntime["refresh"];

  Object.defineProperty(mutable, HARDENED_RUNTIME, { value: true });
  return runtime;
}

export async function createSafeModelRuntime(
  options: CreateModelRuntimeOptions = {},
): Promise<ModelRuntime> {
  const modelsPath = options.modelsPath === null
    ? null
    : resolve(options.modelsPath ?? getModelsConfigPath());
  if (modelsPath) assertStoredModelsConfigSafe(modelsPath);
  const runtime = await ModelRuntime.create({
    ...options,
    modelsPath,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const hardened = hardenModelRuntime(runtime, modelsPath);
  if (options.refreshOnCreate !== false) {
    await hardened.refresh({ allowNetwork: false, signal: options.signal });
  }
  return hardened;
}

export async function createSafeAgentSessionServices(
  options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
  if (options.modelRuntime) {
    return createAgentSessionServices({
      ...options,
      modelRuntime: hardenModelRuntime(options.modelRuntime),
    });
  }

  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const modelRuntime = await createSafeModelRuntime({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    signal: options.modelRuntimeSignal,
  });
  return createAgentSessionServices({ ...options, agentDir, modelRuntime });
}
