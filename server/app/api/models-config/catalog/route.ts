import {
  flattenModelsDevCatalog,
  recommendModelCatalogPreset,
  searchModelCatalog,
  type ModelCatalogEntry,
} from "@/lib/model-catalog";
import { privateRouteJson, requirePihubRouteCapability } from "@/lib/api-route-security";
import { fetchOutboundJson } from "@/lib/outbound-http-security";

export const dynamic = "force-dynamic";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_ENTRIES = 20_000;

interface CatalogCache {
  entries: ModelCatalogEntry[];
  expiresAt: number;
  inFlight?: Promise<ModelCatalogEntry[]>;
}

declare global {
  var __piModelsDevCatalogCache: CatalogCache | undefined;
}

function getCache(): CatalogCache {
  return globalThis.__piModelsDevCatalogCache ??= { entries: [], expiresAt: 0 };
}

async function fetchCatalog(): Promise<ModelCatalogEntry[]> {
  const response = await fetchOutboundJson(MODELS_DEV_URL, {
    headers: { Accept: "application/json" },
  }, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxResponseBytes: MAX_CATALOG_BYTES,
    maxRedirects: 2,
  });
  if (!response.ok) throw new Error("Model catalog request failed");
  const entries = flattenModelsDevCatalog(response.data);
  if (entries.length === 0) throw new Error("models.dev returned an empty catalog");
  if (entries.length > MAX_CATALOG_ENTRIES) throw new Error("Model catalog is too large");
  return entries;
}

async function loadCatalog(): Promise<ModelCatalogEntry[]> {
  const cache = getCache();
  if (cache.entries.length > 0 && cache.expiresAt > Date.now()) return cache.entries;
  if (!cache.inFlight) {
    cache.inFlight = fetchCatalog().then((entries) => {
      cache.entries = entries;
      cache.expiresAt = Date.now() + CATALOG_TTL_MS;
      return entries;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }

  try {
    return await cache.inFlight;
  } catch (error) {
    if (cache.entries.length > 0) return cache.entries;
    throw error;
  }
}

export async function GET(req: Request) {
  const access = requirePihubRouteCapability(req, "models:read");
  if ("response" in access) return access.response;
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").slice(0, 120);
  const provider = (searchParams.get("provider") ?? "").slice(0, 120);
  const baseUrl = (searchParams.get("baseUrl") ?? "").slice(0, 500);
  const parsedLimit = Number.parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;

  try {
    const entries = await loadCatalog();
    const models = searchModelCatalog(entries, query, provider, limit);
    const recommendation = recommendModelCatalogPreset(entries, query, provider, baseUrl);
    return privateRouteJson({ models, recommendation, source: MODELS_DEV_URL });
  } catch {
    return privateRouteJson({ error: "Unable to load model catalog" }, { status: 502 });
  }
}
