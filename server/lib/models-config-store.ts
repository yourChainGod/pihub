import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { invalidateModelsCache } from "./models-cache";
import {
  assertLiteralCredential,
  canonicalizeOutboundBaseUrl,
  OutboundRequestError,
  sanitizeOutboundHeaders,
} from "./outbound-http-security";

const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export const REDACTED_CONFIG_VALUE = "[REDACTED]";
const MAX_CONFIG_DEPTH = 16;
const MAX_CONFIG_NODES = 50_000;
const MAX_STORED_CONFIG_BYTES = 8 * 1024 * 1024;
export const LOCAL_MODEL_DEVELOPMENT_ENV = "PIHUB_ALLOW_LOCAL_MODEL_PROVIDER";
const SECRET_FIELD_NAMES = new Set([
  "api-key",
  "apikey",
  "authorization",
  "cookie",
  "password",
  "proxy-authorization",
  "secret",
  "set-cookie",
  "token",
  "x-api-key",
  "x-goog-api-key",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replaceAll("_", "-");
}

function isSecretField(name: string): boolean {
  const normalized = normalizedFieldName(name);
  return SECRET_FIELD_NAMES.has(normalized)
    || normalized.endsWith("-token")
    || normalized.endsWith("-secret")
    || normalized.endsWith("-password");
}

function restoreRedactedValues(submitted: unknown, current: unknown, depth = 0): unknown {
  if (submitted === REDACTED_CONFIG_VALUE) {
    if (current === undefined || current === REDACTED_CONFIG_VALUE) {
      throw new OutboundRequestError("invalid_input", "Redacted configuration value has no stored source", 400);
    }
    return structuredClone(current);
  }
  if (depth > MAX_CONFIG_DEPTH) {
    throw new OutboundRequestError("invalid_input", "Models configuration is too deeply nested", 400);
  }
  if (Array.isArray(submitted)) {
    const currentItems = Array.isArray(current) ? current : [];
    return submitted.map((item, index) => restoreRedactedValues(item, currentItems[index], depth + 1));
  }
  if (isRecord(submitted)) {
    const currentRecord = isRecord(current) ? current : {};
    return Object.fromEntries(Object.entries(submitted).map(([key, value]) => [
      key,
      restoreRedactedValues(value, currentRecord[key], depth + 1),
    ]));
  }
  return submitted;
}

/** Reject all SDK config syntaxes that could resolve environment or commands. */
export function validateModelsConfigCredentials(data: Record<string, unknown>): void {
  let nodes = 0;
  const visit = (value: unknown, key: string | undefined, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_CONFIG_NODES || depth > MAX_CONFIG_DEPTH) {
      throw new OutboundRequestError("invalid_input", "Models configuration is too large or deeply nested", 400);
    }
    const normalizedKey = key ? normalizedFieldName(key) : undefined;
    if (normalizedKey === "apikey" || normalizedKey === "api-key") {
      if (typeof value !== "string") {
        throw new OutboundRequestError("invalid_input", "Provider API key must be a string", 400);
      }
      assertLiteralCredential(value, "Provider API key");
      return;
    }
    if (normalizedKey === "headers") {
      sanitizeOutboundHeaders(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, undefined, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey, depth + 1);
    }
  };
  visit(data, undefined, 0);
}

export function isLocalModelDevelopmentAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[LOCAL_MODEL_DEVELOPMENT_ENV]?.trim() === "1";
}

function validateModelsConfigTargets(data: Record<string, unknown>): void {
  if (!isRecord(data.providers)) return;
  for (const provider of Object.values(data.providers)) {
    if (!isRecord(provider)) continue;
    const normalizeBaseUrl = (value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "string") {
        throw new OutboundRequestError("invalid_input", "Provider base URL must be a string", 400);
      }
      return canonicalizeOutboundBaseUrl(value, {
        allowLocalhost: isLocalModelDevelopmentAllowed(),
      }).toString().replace(/\/+$/, "");
    };
    const providerBaseUrl = normalizeBaseUrl(provider.baseUrl);
    if (providerBaseUrl !== undefined) provider.baseUrl = providerBaseUrl;
    if (Array.isArray(provider.models)) {
      for (const model of provider.models) {
        if (!isRecord(model)) continue;
        const modelBaseUrl = normalizeBaseUrl(model.baseUrl);
        if (modelBaseUrl !== undefined) model.baseUrl = modelBaseUrl;
      }
    }
  }
}

function redactModelsConfigValue(value: unknown, key?: string, inHeaders = false): unknown {
  if (inHeaders || (key !== undefined && isSecretField(key))) {
    if (value === null || value === undefined || value === "") return value;
    return REDACTED_CONFIG_VALUE;
  }
  if (Array.isArray(value)) return value.map((item) => redactModelsConfigValue(item));
  if (!isRecord(value)) return value;
  const headers = key !== undefined && normalizedFieldName(key) === "headers";
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    redactModelsConfigValue(childValue, childKey, headers),
  ]));
}

function normalizeModelCost(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const providedKeys = MODEL_COST_KEYS.filter((key) => value[key] !== undefined);
  if (providedKeys.length === 0) return undefined;
  if (providedKeys.some((key) => (
    typeof value[key] !== "number" || !Number.isFinite(value[key])
  ))) return undefined;

  return Object.fromEntries([
    ...Object.entries(value),
    ...MODEL_COST_KEYS.map((key) => [key, value[key] ?? 0]),
  ]);
}

/** Complete partial cost groups with zero; omit a cost group only when it is empty. */
export function normalizeModelsConfigCosts(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = structuredClone(data);
  if (!isRecord(normalized.providers)) return normalized;

  for (const provider of Object.values(normalized.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || !("cost" in model)) continue;
      const cost = normalizeModelCost(model.cost);
      if (cost) model.cost = cost;
      else delete model.cost;
    }
  }
  return normalized;
}

function sanitizeModelsConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;

  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => (
      !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0
    ));
    return [providerId, { ...provider, models }];
  }));

  return { ...data, providers };
}

export function getModelsConfigPath(): string {
  return join(getAgentDir(), "models.json");
}

/** Fail closed before the SDK can resolve credentials or use a stored target. */
export function assertStoredModelsConfigSafe(
  modelsPath = getModelsConfigPath(),
): void {
  if (!existsSync(modelsPath)) return;

  let parsed: unknown;
  try {
    if (statSync(modelsPath).size > MAX_STORED_CONFIG_BYTES) {
      throw new OutboundRequestError("invalid_input", "Stored models configuration is too large", 400);
    }
    parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof OutboundRequestError) throw error;
    throw new OutboundRequestError("invalid_input", "Stored models configuration is invalid", 400);
  }

  if (!isRecord(parsed)) {
    throw new OutboundRequestError("invalid_input", "Stored models configuration must be an object", 400);
  }
  validateModelsConfigCredentials(parsed);
  validateModelsConfigTargets(parsed);
}

export function readModelsConfig(
  modelsPath = getModelsConfigPath(),
): Record<string, unknown> {
  if (!existsSync(modelsPath)) return { providers: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(modelsPath, "utf8"));
    return isRecord(parsed) ? parsed : { providers: {} };
  } catch {
    return { providers: {} };
  }
}

/** Browser/API representation; raw credential material remains server-internal. */
export function readPublicModelsConfig(
  modelsPath = getModelsConfigPath(),
): Record<string, unknown> {
  return redactModelsConfigValue(readModelsConfig(modelsPath)) as Record<string, unknown>;
}

export function writeModelsConfig(
  data: Record<string, unknown>,
  modelsPath = getModelsConfigPath(),
): void {
  const dir = dirname(modelsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const restored = restoreRedactedValues(data, readModelsConfig(modelsPath));
  if (!isRecord(restored)) {
    throw new OutboundRequestError("invalid_input", "Models configuration must be an object", 400);
  }
  validateModelsConfigTargets(restored);
  validateModelsConfigCredentials(restored);
  const normalized = normalizeModelsConfigCosts(sanitizeModelsConfig(restored));
  writePrivateFileAtomicSync(modelsPath, JSON.stringify(normalized, null, 2));
  invalidateModelsCache();
}
