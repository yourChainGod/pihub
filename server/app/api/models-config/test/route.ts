import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { resolveModelDiscoveryAuth } from "@/lib/model-discovery-auth";
import { isSafeModelId } from "@/lib/model-discovery";
import {
  canonicalizeOutboundBaseUrl,
  createSecureOutboundFetch,
  outboundErrorResponse,
  readBoundedJsonRequest,
  redactSensitiveText,
} from "@/lib/outbound-http-security";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  UNSUPPORTED_MODEL_TRANSPORT_CODE,
  UNSUPPORTED_MODEL_TRANSPORT_MESSAGE,
} from "@/lib/safe-model-runtime";
import { privateRouteJson, requirePihubRouteCapability } from "@/lib/api-route-security";

export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 20_000;
const TEST_MAX_RESPONSE_BYTES = 1024 * 1024;
const SUPPORTED_APIS = new Set<Api>([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function POST(req: Request) {
  const access = requirePihubRouteCapability(req, "models:manage");
  if ("response" in access) return access.response;
  if (!isApiRequestAllowed(req)) return privateRouteJson({ ok: false, error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) {
    return privateRouteJson(
      { ok: false, error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  try {
    const body = await readBoundedJsonRequest(req) as { providerName?: unknown; provider?: unknown; model?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName || providerName.length > 128) return privateRouteJson({ ok: false, error: "providerName is invalid" }, { status: 400 });
    if (!isRecord(body.provider)) return privateRouteJson({ ok: false, error: "provider is required" }, { status: 400 });
    if (!isRecord(body.model)) return privateRouteJson({ ok: false, error: "model is required" }, { status: 400 });
    if (Object.hasOwn(body.provider, "allowTailnet")) {
      return privateRouteJson({ ok: false, error: "allowTailnet is reserved for managed NewAPI providers" }, { status: 400 });
    }

    const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
    if (!isSafeModelId(modelId)) {
      return privateRouteJson({ ok: false, error: "Model ID is invalid" }, { status: 400 });
    }
    const api = (typeof body.model.api === "string" && body.model.api
      ? body.model.api
      : typeof body.provider.api === "string" && body.provider.api
        ? body.provider.api
        : "openai-completions") as Api;
    if (!SUPPORTED_APIS.has(api)) {
      return privateRouteJson({
        ok: false,
        error: UNSUPPORTED_MODEL_TRANSPORT_MESSAGE,
        code: UNSUPPORTED_MODEL_TRANSPORT_CODE,
      }, { status: 400 });
    }
    const rawBaseUrl = typeof body.model.baseUrl === "string" && body.model.baseUrl.trim()
      ? body.model.baseUrl
      : body.provider.baseUrl;
    if (typeof rawBaseUrl !== "string" || !rawBaseUrl.trim()) {
      return privateRouteJson({ ok: false, error: "Base URL is required" }, { status: 400 });
    }
    const baseUrl = canonicalizeOutboundBaseUrl(rawBaseUrl).toString().replace(/\/$/, "");
    const resolved = await resolveModelDiscoveryAuth(providerName, body.provider, rawBaseUrl);
    if (!resolved.apiKey) {
      return privateRouteJson({ ok: false, error: "No API key found for provider" });
    }

    const model: Model<Api> = {
      id: modelId,
      name: typeof body.model.name === "string" && body.model.name.trim() ? body.model.name.trim().slice(0, 256) : modelId,
      api,
      provider: providerName,
      baseUrl,
      reasoning: body.model.reasoning === true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 16,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let status: number | undefined;
    const startedAt = Date.now();

    try {
      const message = await completeSimple(model, {
        messages: [{
          role: "user",
          content: "Reply with OK only.",
          timestamp: Date.now(),
        }],
      }, {
        apiKey: resolved.apiKey,
        headers: resolved.headers,
        fetch: createSecureOutboundFetch({
          timeoutMs: TEST_TIMEOUT_MS,
          maxResponseBytes: TEST_MAX_RESPONSE_BYTES,
          maxRequestBytes: 256 * 1024,
        }),
        transport: "sse",
        maxTokens: 16,
        timeoutMs: TEST_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
        onResponse: (response) => { status = response.status; },
      });

      const latencyMs = Date.now() - startedAt;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return privateRouteJson({
          ok: false,
          error: controller.signal.aborted ? "Test timed out" : "Model returned an error",
          latencyMs,
          status,
        });
      }

      return privateRouteJson({
        ok: true,
        latencyMs,
        status,
        responseText: redactSensitiveText(
          getAssistantText(message),
          [resolved.apiKey, ...Object.values(resolved.headers)],
        ).slice(0, 300),
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const failure = outboundErrorResponse(error);
    return privateRouteJson({ ok: false, error: failure.error }, { status: failure.status });
  }
}
