import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model, ModelThinkingLevel, Provider, RefreshModelsContext, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getApiProvider, getModels, getProviders, type BuiltinProvider } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionFactory, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { isSafeModelId } from "./model-discovery";
import { readNewApiConfig, writeNewApiConfig, type NewApiProviderConfig } from "./newapi-config-store";
import { createSecureOutboundFetch, fetchOutboundJson } from "./outbound-http-security";

type GatewayModel = {
  id: string;
  supported_endpoint_types?: string[];
};

type ModelOverride = {
  name?: string;
  api?: Api;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: Model<Api>["compat"];
};

type ModelsDevInfo = ModelOverride & { id: string; provider: string; inexact?: boolean };
type ModelsDevCache = {
  fetchedAt: number;
  raw: unknown;
  byFullId: Map<string, ModelsDevInfo>;
  byNormalizedId: Map<string, ModelsDevInfo>;
};
type Ratios = {
  model: Record<string, number>;
  completion: Record<string, number>;
  cache: Record<string, number>;
  createCache: Record<string, number>;
};
type CachedCatalog = {
  models?: readonly unknown[];
  checkedAt?: number;
  etag?: string;
};

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_OUTPUT = 4_096;
const FETCH_TIMEOUT_MS = 5_000;
const MODELS_DEV_TIMEOUT_MS = 15_000;
const MODELS_DEV_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE = "models-dev-cache.json";
const MAX_GATEWAY_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS_DEV_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_GATEWAY_MODELS = 2_000;
const MAX_MODELS_DEV_MODELS = 50_000;
const VARIANT_SUFFIXES = new Set(["pro", "fast", "max", "high", "low", "thinking", "reasoning", "nonreasoning", "instant", "latest", "preview"]);
const ENRICHMENT_PROVIDERS = ["deepseek", "zai", "google", "anthropic", "minimax", "moonshotai", "xiaomi", "openai", "vercel-ai-gateway"] as const;
const PROVIDER_PRIORITY = ["anthropic", "openai", "google", "deepseek", "moonshotai", "xai", "zhipuai", "minimax", "mistral", "meta"];
const SUPPORTED_APIS = new Set<Api>(["anthropic-messages", "openai-completions", "openai-responses"]);
const EMPTY_RATIOS: Ratios = { model: {}, completion: {}, cache: {}, createCache: {} };

let modelsDevCache: ModelsDevCache | undefined;
let modelsDevInflight: Promise<ModelsDevCache | undefined> | undefined;
let enrichmentCache: Map<string, Model<Api>> | undefined;
let configWriteQueue = Promise.resolve();

function normalizeModelId(id: string): string {
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return bare.replaceAll(".", "-").toLowerCase();
}

export function newApiOriginFingerprint(entry: NewApiProviderConfig): string {
  const value = JSON.stringify([entry.baseUrl.replace(/\/+$/, ""), entry.allowTailnet === true]);
  return `"pihub-newapi-origin-${createHash("sha256").update(value).digest("base64url")}"`;
}

function modelCandidates(id: string): string[] {
  const candidates = [normalizeModelId(id)];
  let parts = candidates[0].split("-");
  while (parts.length > 1 && VARIANT_SUFFIXES.has(parts.at(-1)!)) {
    parts = parts.slice(0, -1);
    candidates.push(parts.join("-"));
  }
  return candidates;
}

function apiForModel(id: string, advertised: string[] = [], catalogProvider?: string): Api {
  const bare = normalizeModelId(id);
  const provider = (id.includes("/") ? id.slice(0, id.indexOf("/")) : catalogProvider ?? "").toLowerCase();
  const vendor = provider === "anthropic" || provider === "claude" || bare.includes("claude-")
    ? "anthropic"
    : provider === "openai" || /^(gpt-|o1|o3|o4|chatgpt-)/.test(bare) ? "openai" : "other";
  const preferred: Api[] = vendor === "anthropic"
    ? ["anthropic-messages", "openai-completions", "openai-responses"]
    : vendor === "openai" ? ["openai-responses", "openai-completions", "anthropic-messages"]
      : ["openai-completions", "openai-responses", "anthropic-messages"];
  const allowed = new Set<Api>();
  for (const type of advertised.map((value) => value.toLowerCase())) {
    if (type === "anthropic" || type === "anthropic-messages") allowed.add("anthropic-messages");
    if (type === "openai" || type === "openai-completions" || type === "completions") allowed.add("openai-completions");
    if (type === "openai" || type === "openai-responses" || type === "responses") allowed.add("openai-responses");
  }
  return preferred.find((api) => allowed.size === 0 || allowed.has(api)) ?? preferred[0];
}

export function modelUrl(baseUrl: string, api: Api): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  url.pathname = api === "anthropic-messages" ? (path || "/") : `${path}/v1`;
  return url.toString().replace(/\/+$/, "");
}

function reasoningFor(id: string): boolean {
  return /reason|thinking|opus|sonnet|o[1-9]|deepseek-r|qwq|kimi-k2|gpt-5|grok-4/i.test(id);
}

function requiresAdaptiveThinking(id: string): boolean {
  return modelCandidates(id).some((candidate) => /^claude-(?:opus|sonnet)-4-(?:6|7|8)(?:-|$)/.test(candidate)
    || /^claude-(?:opus|sonnet|fable|mythos)-5(?:-|$)/.test(candidate)
    || /^claude-mythos-preview(?:-|$)/.test(candidate));
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function thinkingMap(options: unknown): ThinkingLevelMap | undefined {
  if (!Array.isArray(options)) return undefined;
  const aliases: Record<string, ModelThinkingLevel> = { minimal: "minimal", lowest: "minimal", low: "low", medium: "medium", med: "medium", high: "high", xhigh: "xhigh", "extra-high": "xhigh", extrahigh: "xhigh", veryhigh: "xhigh", max: "max", maximum: "max", ultra: "max", ultrahigh: "max" };
  const supported = new Map<ModelThinkingLevel, string>();
  let canDisable = false;
  for (const option of options) {
    if (!option || typeof option !== "object") continue;
    const record = option as Record<string, unknown>;
    if (record.type === "toggle") canDisable = true;
    if (record.type !== "effort" || !Array.isArray(record.values)) continue;
    for (const raw of record.values) {
      if (raw === "none" || raw === "off") { canDisable = true; continue; }
      if (typeof raw === "string" && aliases[raw.toLowerCase()] && !supported.has(aliases[raw.toLowerCase()])) supported.set(aliases[raw.toLowerCase()], raw);
    }
  }
  if (supported.size === 0) return undefined;
  const result: ThinkingLevelMap = {};
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) result[level] = supported.get(level) ?? null;
  if (!canDisable) result.off = null;
  return result;
}

function parseModelsDev(raw: unknown, fetchedAt = Date.now()): ModelsDevCache {
  const byFullId = new Map<string, ModelsDevInfo>();
  const byNormalizedId = new Map<string, ModelsDevInfo>();
  if (!raw || typeof raw !== "object") return { fetchedAt, raw, byFullId, byNormalizedId };
  let modelCount = 0;
  providerLoop: for (const [providerId, providerRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!providerRaw || typeof providerRaw !== "object") continue;
    const models = (providerRaw as Record<string, unknown>).models;
    if (!models || typeof models !== "object") continue;
    const provider = providerId.toLowerCase();
    for (const [modelId, modelRaw] of Object.entries(models as Record<string, unknown>)) {
      if (modelCount >= MAX_MODELS_DEV_MODELS) break providerLoop;
      if (!modelRaw || typeof modelRaw !== "object") continue;
      modelCount += 1;
      const model = modelRaw as Record<string, unknown>;
      const limit = model.limit && typeof model.limit === "object" ? model.limit as Record<string, unknown> : {};
      const modalities = model.modalities && typeof model.modalities === "object" ? (model.modalities as Record<string, unknown>).input : undefined;
      const input: ("text" | "image")[] = [];
      if (Array.isArray(modalities)) {
        if (modalities.includes("text")) input.push("text");
        if (modalities.some((value) => value === "image" || value === "pdf" || value === "video")) input.push("image");
      }
      const info: ModelsDevInfo = {
        id: `${provider}/${modelId}`, provider,
        name: typeof model.name === "string" ? model.name : undefined,
        reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
        input: input.length ? input : undefined,
        contextWindow: positiveInt(limit.context), maxTokens: positiveInt(limit.output),
        thinkingLevelMap: thinkingMap(model.reasoning_options),
      };
      byFullId.set(info.id.toLowerCase(), info);
      const normalized = normalizeModelId(modelId);
      const prior = byNormalizedId.get(normalized);
      if (!prior || (PROVIDER_PRIORITY.indexOf(provider) + 1 || 999) < (PROVIDER_PRIORITY.indexOf(prior.provider) + 1 || 999)) byNormalizedId.set(normalized, info);
    }
  }
  return { fetchedAt, raw, byFullId, byNormalizedId };
}

function modelsDevPath(): string { return join(getAgentDir(), "extensions", MODELS_DEV_CACHE); }

function readModelsDevDisk(): ModelsDevCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(modelsDevPath(), "utf8")) as { fetchedAt?: number; catalog?: unknown };
    return parsed.catalog ? parseModelsDev(parsed.catalog, parsed.fetchedAt ?? 0) : undefined;
  } catch { return undefined; }
}

function writeModelsDevDisk(cache: ModelsDevCache): void {
  try {
    const path = modelsDevPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(temporary, JSON.stringify({ fetchedAt: cache.fetchedAt, catalog: cache.raw }), { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) { console.warn("NewAPI: 无法保存 models.dev 缓存", error); }
}

async function loadModelsDev(signal: AbortSignal): Promise<ModelsDevCache | undefined> {
  const now = Date.now();
  if (!modelsDevCache) modelsDevCache = readModelsDevDisk();
  if (modelsDevCache && now - modelsDevCache.fetchedAt < MODELS_DEV_TTL_MS) return modelsDevCache;
  if (modelsDevInflight) return modelsDevInflight;
  modelsDevInflight = (async () => {
    try {
      const response = await fetchOutboundJson(MODELS_DEV_URL, { signal }, {
        timeoutMs: MODELS_DEV_TIMEOUT_MS,
        maxResponseBytes: MAX_MODELS_DEV_RESPONSE_BYTES,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      modelsDevCache = parseModelsDev(response.data);
      writeModelsDevDisk(modelsDevCache);
      return modelsDevCache;
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn("NewAPI: models.dev 不可用，继续使用本地元数据", error);
      return modelsDevCache;
    } finally { modelsDevInflight = undefined; }
  })();
  return modelsDevInflight;
}

function lookupModelsDev(cache: ModelsDevCache | undefined, id: string): ModelsDevInfo | undefined {
  if (!cache) return undefined;
  const exact = cache.byFullId.get(id.toLowerCase());
  if (exact) return exact;
  const candidates = modelCandidates(id);
  for (let index = 0; index < candidates.length; index++) {
    const found = cache.byNormalizedId.get(candidates[index]);
    if (found) return index === 0 ? found : { ...found, inexact: true };
  }
  return undefined;
}

function enrichment(): Map<string, Model<Api>> {
  if (enrichmentCache) return enrichmentCache;
  enrichmentCache = new Map();
  for (const provider of ENRICHMENT_PROVIDERS) {
    let models: Model<Api>[];
    try { models = getModels(provider as BuiltinProvider) as Model<Api>[]; } catch { continue; }
    for (const model of models) if (SUPPORTED_APIS.has(model.api) && !enrichmentCache.has(normalizeModelId(model.id))) enrichmentCache.set(normalizeModelId(model.id), model);
  }
  return enrichmentCache;
}

function findRatio(id: string, ratios: Record<string, number>): number | undefined {
  if (id in ratios) return ratios[id];
  const lower = id.toLowerCase();
  for (const [key, value] of Object.entries(ratios)) if (key.toLowerCase() === lower) return value;
  for (const [key, value] of Object.entries(ratios)) if (lower.startsWith(key.toLowerCase())) return value;
  return undefined;
}

export function ratioMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => (
    typeof entry[1] === "number"
    && Number.isFinite(entry[1])
    && entry[1] >= 0
    && entry[1] <= 1_000_000
    && isSafeModelId(entry[0])
  )));
}

async function loadRatios(entry: NewApiProviderConfig, signal: AbortSignal): Promise<Ratios> {
  try {
    const response = await fetchOutboundJson(`${entry.baseUrl}/api/ratio_config`, { signal }, {
      allowTailnet: entry.allowTailnet === true,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxResponseBytes: 512 * 1024,
    });
    if (!response.ok) return EMPTY_RATIOS;
    const root = response.data as Record<string, unknown>;
    if (!root || typeof root !== "object") return EMPTY_RATIOS;
    const data = (root.data ?? root) as Record<string, unknown>;
    return { model: ratioMap(data.model_ratio), completion: ratioMap(data.completion_ratio), cache: ratioMap(data.cache_ratio), createCache: ratioMap(data.create_cache_ratio) };
  } catch (error) {
    if (signal.aborted) throw error;
    return EMPTY_RATIOS;
  }
}

function buildModel(provider: string, baseUrl: string, raw: GatewayModel, ratios: Ratios, modelsDev?: ModelsDevInfo): { model: ProviderModelConfig; generatedOverride?: ModelOverride } {
  const config = readNewApiConfig();
  const override = config.providers[provider]?.modelOverrides?.[raw.id] as ModelOverride | undefined;
  const builtIn = modelCandidates(raw.id).map((id) => enrichment().get(id)).find(Boolean);
  const api = override?.api ?? apiForModel(raw.id, raw.supported_endpoint_types, modelsDev?.provider);
  const reasoning = override?.reasoning ?? modelsDev?.reasoning ?? builtIn?.reasoning ?? reasoningFor(raw.id);
  let thinkingLevelMap = override?.thinkingLevelMap ?? modelsDev?.thinkingLevelMap ?? builtIn?.thinkingLevelMap;
  if (!thinkingLevelMap && reasoning) thinkingLevelMap = { minimal: "low", low: "low", medium: "medium", high: "high" };
  let contextWindow = override?.contextWindow ?? modelsDev?.contextWindow ?? builtIn?.contextWindow ?? DEFAULT_CONTEXT;
  const maxTokens = override?.maxTokens ?? modelsDev?.maxTokens ?? builtIn?.maxTokens ?? DEFAULT_OUTPUT;
  let compat = { ...(builtIn?.compat as Record<string, unknown> | undefined), ...(override?.compat as Record<string, unknown> | undefined) } as Model<Api>["compat"];
  if (api === "anthropic-messages" && reasoning && requiresAdaptiveThinking(raw.id) && (override?.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking !== false) compat = { ...(compat as Record<string, unknown>), forceAdaptiveThinking: true } as Model<Api>["compat"];
  if (config.settings.sendSessionAffinityHeaders === true && (api === "anthropic-messages" || api === "openai-completions")) compat = { ...(compat as Record<string, unknown>), sendSessionAffinityHeaders: true } as Model<Api>["compat"];
  if (/^grok-4-6(?:-|$)/.test(normalizeModelId(raw.id))) {
    contextWindow = Math.max(contextWindow, 1_000_000);
    if (reasoning) thinkingLevelMap = { ...thinkingLevelMap, xhigh: "xhigh" };
  }
  const modelRate = findRatio(raw.id, ratios.model) ?? 0;
  const completionRate = findRatio(raw.id, ratios.completion) ?? 1;
  const inputCost = modelRate * 2;
  const generatedOverride = !override && !builtIn ? { api, reasoning, input: modelsDev?.input ?? ["text"], contextWindow, maxTokens, thinkingLevelMap, compat } : undefined;
  return { model: {
    id: raw.id,
    name: override?.name ?? (!modelsDev?.inexact ? modelsDev?.name : undefined) ?? builtIn?.name ?? raw.id,
    api, baseUrl: modelUrl(baseUrl, api), reasoning, thinkingLevelMap,
    input: override?.input ?? modelsDev?.input ?? builtIn?.input ?? ["text"],
    cost: { input: inputCost, output: inputCost * completionRate, cacheRead: inputCost * (findRatio(raw.id, ratios.cache) ?? 0), cacheWrite: inputCost * (findRatio(raw.id, ratios.createCache) ?? 0) },
    contextWindow, maxTokens, compat,
  }, generatedOverride };
}

export function parseGatewayModels(payload: unknown): GatewayModel[] {
  const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new Error("/v1/models 响应缺少 data 数组");
  const seen = new Set<string>();
  const models: GatewayModel[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !isSafeModelId(record.id) || seen.has(record.id)) continue;
    seen.add(record.id);
    const advertised = Array.isArray(record.supported_endpoint_types)
      ? record.supported_endpoint_types
        .filter((value): value is string => typeof value === "string" && value.length <= 64)
        .slice(0, 8)
      : undefined;
    models.push({ id: record.id, ...(advertised?.length ? { supported_endpoint_types: advertised } : {}) });
    if (models.length >= MAX_GATEWAY_MODELS) break;
  }
  return models;
}

function mergeGeneratedOverrides(provider: string, generated: Record<string, ModelOverride>): Promise<void> {
  if (Object.keys(generated).length === 0) return Promise.resolve();
  const run = configWriteQueue.then(() => {
    const latest = readNewApiConfig();
    const entry = latest.providers[provider];
    if (!entry) return;
    entry.modelOverrides ??= {};
    for (const [id, value] of Object.entries(generated)) if (!entry.modelOverrides[id]) entry.modelOverrides[id] = value;
    writeNewApiConfig(latest);
  });
  configWriteQueue = run.catch(() => undefined);
  return run;
}

async function discover(
  provider: string,
  entry: NewApiProviderConfig,
  context: RefreshModelsContext,
  update?: (models: ProviderModelConfig[]) => void,
): Promise<ProviderModelConfig[]> {
  const cached = context.stored as CachedCatalog | undefined;
  const fingerprint = newApiOriginFingerprint(entry);
  const cacheMatchesOrigin = cached?.etag === fingerprint;
  const cachedModels = (cacheMatchesOrigin ? cached?.models ?? [] : []) as unknown as ProviderModelConfig[];
  if (!context.allowNetwork || context.signal.aborted) {
    if (update) await context.publish({ update: () => update(cachedModels) });
    return cachedModels;
  }
  const credential = context.credential?.type === "api_key" ? context.credential.key : undefined;
  const headers = new Headers({ accept: "application/json" });
  if (credential) headers.set("authorization", `Bearer ${credential}`);
  const baseUrl = entry.baseUrl.replace(/\/+$/, "");
  try {
    const response = await fetchOutboundJson(`${baseUrl}/v1/models`, { headers, signal: context.signal }, {
      allowTailnet: entry.allowTailnet === true,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxResponseBytes: MAX_GATEWAY_RESPONSE_BYTES,
    });
    if (response.status === 401 || response.status === 403) throw new Error(`认证失败（HTTP ${response.status}），请检查 API Key`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rawModels = parseGatewayModels(response.data);
    if (rawModels.length === 0 && cachedModels.length) return cachedModels;
    const allowModelsDev = readNewApiConfig().settings.enableModelsDevEnrichment === true;
    const [modelsDev, ratios] = await Promise.all([
      allowModelsDev ? loadModelsDev(context.signal) : Promise.resolve(undefined),
      loadRatios(entry, context.signal),
    ]);
    const generated: Record<string, ModelOverride> = Object.create(null) as Record<string, ModelOverride>;
    const models = rawModels.map((raw) => {
      const built = buildModel(provider, baseUrl, raw, ratios, lookupModelsDev(modelsDev, raw.id));
      if (built.generatedOverride) generated[raw.id] = built.generatedOverride;
      return built.model;
    });
    await mergeGeneratedOverrides(provider, generated);
    await context.publish({
      persist: {
        models: models as unknown as Model<Api>[],
        checkedAt: Date.now(),
        etag: fingerprint,
      },
      ...(update ? { update: () => update(models) } : {}),
    });
    return models;
  } catch (error) {
    if (context.signal.aborted) return cachedModels;
    console.warn(`NewAPI [${provider}] 刷新失败${cachedModels.length ? "，使用缓存" : ""}`);
    if (cachedModels.length) {
      if (update) await context.publish({ update: () => update(cachedModels) });
      return cachedModels;
    }
    throw error;
  }
}

export function createNewApiProviderExtension(): ExtensionFactory {
  return (pi) => {
    const config = readNewApiConfig();
    const builtinNames = new Set(getProviders() as unknown as string[]);
    for (const [name, entry] of Object.entries(config.providers)) {
      if (!entry?.baseUrl || builtinNames.has(name)) continue;
      let currentModels: Model<Api>[] = [];
      const secureOptions = <T extends { timeoutMs?: number }>(options: T | undefined) => ({
        ...options,
        transport: "sse" as const,
        fetch: createSecureOutboundFetch({
          allowTailnet: entry.allowTailnet === true,
          timeoutMs: 120_000,
          connectTimeoutMs: 10_000,
          headersTimeoutMs: 120_000,
          idleTimeoutMs: Math.min(
            typeof options?.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : 300_000,
            10 * 60_000,
          ),
          streamResponse: true,
          maxResponseBytes: 64 * 1024 * 1024,
          maxRequestBytes: 64 * 1024 * 1024,
        }),
      });
      const apiProviderFor = (api: Api) => {
        const apiProvider = getApiProvider(api);
        if (!apiProvider) throw new Error(`NewAPI 不支持 API: ${api}`);
        return apiProvider;
      };
      const provider: Provider<Api> = {
        id: name,
        name: `NewAPI (${name})`,
        baseUrl: entry.baseUrl,
        auth: {
          apiKey: {
            name: "NewAPI API key",
            login: async (interaction) => ({
              type: "api_key",
              key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
            }),
            check: async ({ credential }) => credential?.key
              ? { type: "api_key", source: "stored credential" }
              : undefined,
            resolve: async ({ credential }) => credential?.key
              ? { auth: { apiKey: credential.key }, source: "stored credential" }
              : undefined,
          },
        },
        getModels: () => currentModels,
        refreshModels: async (context) => {
          await discover(name, entry, context, (models) => {
            currentModels = models.map((model) => ({
              ...model,
              provider: name,
              api: model.api ?? "openai-completions",
              baseUrl: model.baseUrl ?? entry.baseUrl,
            })) as Model<Api>[];
          });
        },
        stream: (model, context, options) => apiProviderFor(model.api).stream(
          model,
          context,
          secureOptions(options) as never,
        ),
        streamSimple: (model, context, options) => apiProviderFor(model.api).streamSimple(
          model,
          context,
          secureOptions(options),
        ),
      };
      pi.registerProvider(provider);
    }
  };
}
