import {
  assertLiteralCredential,
  canonicalizeOutboundBaseUrl,
  OutboundRequestError,
  sanitizeOutboundHeaders,
} from "./outbound-http-security";
import {
  readModelsConfig,
  REDACTED_CONFIG_VALUE,
} from "./models-config-store";

export interface ModelDiscoveryAuth {
  apiKey?: string;
  headers: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedProvider(providerName: string, modelsPath?: string): Record<string, unknown> | undefined {
  const providers = readModelsConfig(modelsPath).providers;
  return isRecord(providers) && isRecord(providers[providerName]) ? providers[providerName] : undefined;
}

function assertStoredSecretTarget(
  submitted: Record<string, unknown>,
  stored: Record<string, unknown> | undefined,
  effectiveBaseUrl: string | undefined,
): void {
  if (!stored || typeof stored.baseUrl !== "string" || typeof effectiveBaseUrl !== "string") {
    throw new OutboundRequestError("invalid_input", "Stored provider credential is unavailable", 400);
  }
  const submittedTailnet = submitted.allowTailnet === true;
  const storedTailnet = stored.allowTailnet === true;
  if (submittedTailnet !== storedTailnet) {
    throw new OutboundRequestError("invalid_input", "Stored provider target does not match", 400);
  }
  const requested = canonicalizeOutboundBaseUrl(effectiveBaseUrl, { allowTailnet: submittedTailnet }).toString().replace(/\/+$/, "");
  const expected = canonicalizeOutboundBaseUrl(stored.baseUrl, { allowTailnet: storedTailnet }).toString().replace(/\/+$/, "");
  if (requested !== expected) {
    throw new OutboundRequestError("invalid_input", "Stored provider target does not match", 400);
  }
}

function storedHeader(headers: unknown, name: string): string | undefined {
  if (!isRecord(headers)) return undefined;
  const match = Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
  return typeof match?.[1] === "string" ? match[1] : undefined;
}

/**
 * Resolve only literal values supplied by the editor request. ModelRuntime is
 * intentionally not used here because local models.json values may execute a
 * leading !command or interpolate environment variables.
 */
export async function resolveModelDiscoveryAuth(
  providerName: string,
  provider: Record<string, unknown>,
  effectiveBaseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
  modelsPath?: string,
): Promise<ModelDiscoveryAuth> {
  const submittedHeaders = sanitizeOutboundHeaders(provider.headers);
  const needsStored = provider.apiKey === REDACTED_CONFIG_VALUE
    || Object.values(submittedHeaders).includes(REDACTED_CONFIG_VALUE);
  const stored = needsStored ? storedProvider(providerName, modelsPath) : undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(submittedHeaders)) {
    if (value !== REDACTED_CONFIG_VALUE) {
      headers[name] = value;
      continue;
    }
    assertStoredSecretTarget(provider, stored, effectiveBaseUrl);
    const secret = storedHeader(stored?.headers, name);
    if (!secret) throw new OutboundRequestError("invalid_input", "Stored provider header is unavailable", 400);
    headers[name] = assertLiteralCredential(secret, "Stored provider header");
  }
  if (provider.apiKey !== undefined && typeof provider.apiKey !== "string") {
    throw new OutboundRequestError("invalid_input", "Provider API key must be a string", 400);
  }
  let apiKey: string | undefined;
  if (typeof provider.apiKey === "string" && provider.apiKey.trim()) {
    if (provider.apiKey === REDACTED_CONFIG_VALUE) {
      assertStoredSecretTarget(provider, stored, effectiveBaseUrl);
      if (typeof stored?.apiKey !== "string") {
        throw new OutboundRequestError("invalid_input", "Stored provider API key is unavailable", 400);
      }
      apiKey = assertLiteralCredential(stored.apiKey, "Stored provider API key");
    } else {
      apiKey = assertLiteralCredential(provider.apiKey, "Provider API key");
    }
  }
  return {
    apiKey,
    headers,
  };
}
