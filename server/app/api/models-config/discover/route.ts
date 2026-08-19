import { resolveModelDiscoveryAuth } from "@/lib/model-discovery-auth";
import { buildModelsListUrl, parseDiscoveredModels } from "@/lib/model-discovery";
import {
  canonicalizeOutboundBaseUrl,
  fetchOutboundJson,
  outboundErrorResponse,
  readBoundedJsonRequest,
} from "@/lib/outbound-http-security";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  UNSUPPORTED_MODEL_TRANSPORT_CODE,
  UNSUPPORTED_MODEL_TRANSPORT_MESSAGE,
} from "@/lib/safe-model-runtime";
import { privateRouteJson, requirePihubRouteCapability } from "@/lib/api-route-security";

export const dynamic = "force-dynamic";

const DISCOVERY_TIMEOUT_MS = 20_000;
const MAX_DISCOVERY_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERED_MODELS = 2_000;
const SUPPORTED_APIS = new Set([
  "anthropic-messages",
  "google-generative-ai",
  "openai-completions",
  "openai-responses",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHeader(headers: Headers, name: string): boolean {
  return headers.has(name);
}

function buildHeaders(api: string, apiKey: string | undefined, configured: Record<string, string>): Headers {
  const headers = new Headers(configured);
  if (!hasHeader(headers, "accept")) headers.set("Accept", "application/json");
  if (!apiKey) return headers;

  if (api === "anthropic-messages") {
    if (!hasHeader(headers, "x-api-key")) headers.set("x-api-key", apiKey);
    if (!hasHeader(headers, "anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (api === "google-generative-ai") {
    if (!hasHeader(headers, "x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
  } else if (!hasHeader(headers, "authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

export async function POST(req: Request) {
  const access = requirePihubRouteCapability(req, "models:manage");
  if ("response" in access) return access.response;
  if (!isApiRequestAllowed(req)) return privateRouteJson({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) {
    return privateRouteJson({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await readBoundedJsonRequest(req) as { providerName?: unknown; provider?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName || providerName.length > 128) return privateRouteJson({ error: "providerName is invalid" }, { status: 400 });
    if (!isRecord(body.provider)) return privateRouteJson({ error: "provider is required" }, { status: 400 });
    if (Object.hasOwn(body.provider, "allowTailnet")) {
      return privateRouteJson({ error: "allowTailnet is reserved for managed NewAPI providers" }, { status: 400 });
    }

    const baseUrl = typeof body.provider.baseUrl === "string" ? body.provider.baseUrl.trim() : "";
    if (!baseUrl) return privateRouteJson({ error: "Base URL is required" }, { status: 400 });
    const api = typeof body.provider.api === "string" && body.provider.api
      ? body.provider.api
      : "openai-completions";
    if (!SUPPORTED_APIS.has(api)) {
      return privateRouteJson({
        error: UNSUPPORTED_MODEL_TRANSPORT_MESSAGE,
        code: UNSUPPORTED_MODEL_TRANSPORT_CODE,
      }, { status: 400 });
    }

    let endpoint: URL;
    try {
      const canonicalBaseUrl = canonicalizeOutboundBaseUrl(baseUrl);
      endpoint = buildModelsListUrl(canonicalBaseUrl.toString(), api);
    } catch {
      return privateRouteJson({ error: "Base URL is invalid" }, { status: 400 });
    }

    const auth = await resolveModelDiscoveryAuth(providerName, body.provider);
    if (typeof body.provider.apiKey === "string" && body.provider.apiKey.trim() && !auth.apiKey) {
      return privateRouteJson({ error: "No API key found for provider" }, { status: 400 });
    }

    const response = await fetchOutboundJson(endpoint, {
      headers: buildHeaders(api, auth.apiKey, auth.headers),
      signal: req.signal,
    }, {
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      maxResponseBytes: MAX_DISCOVERY_RESPONSE_BYTES,
    });
    if (!response.ok) {
      return privateRouteJson({
        error: `Upstream returned HTTP ${response.status}`,
        status: response.status,
      }, { status: 502 });
    }
    const models = parseDiscoveredModels(response.data).slice(0, MAX_DISCOVERED_MODELS);
    if (models.length === 0) {
      return privateRouteJson({ error: "No models found in the upstream response" }, { status: 502 });
    }

    return privateRouteJson({ models, endpoint: `${endpoint.origin}${endpoint.pathname}` });
  } catch (error) {
    const failure = outboundErrorResponse(error);
    return privateRouteJson({ error: failure.error }, { status: failure.status });
  }
}
