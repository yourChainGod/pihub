import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { canonicalizeOutboundBaseUrl } from "./outbound-http-security";

export interface NewApiProviderConfig {
  baseUrl: string;
  modelOverrides: Record<string, unknown>;
  allowTailnet?: boolean;
}

export interface NewApiConfig {
  providers: Record<string, NewApiProviderConfig>;
  settings: {
    enableModelsDevEnrichment?: boolean;
    onboardingWarnCountdown?: number;
    sendSessionAffinityHeaders?: boolean;
  };
}

export function getNewApiConfigPath(): string {
  return join(getAgentDir(), "extensions", "provider-newapi.json");
}

export function readNewApiConfig(configPath = getNewApiConfigPath()): NewApiConfig {
  if (!existsSync(configPath)) return { providers: {}, settings: {} };
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<NewApiConfig>;
    const providers: Record<string, NewApiProviderConfig> = {};
    if (parsed.providers && typeof parsed.providers === "object" && !Array.isArray(parsed.providers)) {
      for (const [name, raw] of Object.entries(parsed.providers)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const entry = raw as Partial<NewApiProviderConfig>;
        if (typeof entry.baseUrl !== "string") continue;
        const allowTailnet = entry.allowTailnet === true;
        try {
          providers[name] = {
            baseUrl: normalizeNewApiBaseUrl(entry.baseUrl, { allowTailnet }),
            modelOverrides: entry.modelOverrides && typeof entry.modelOverrides === "object" && !Array.isArray(entry.modelOverrides)
              ? entry.modelOverrides
              : {},
            ...(allowTailnet ? { allowTailnet: true } : {}),
          };
        } catch {
          // Invalid legacy entries remain on disk for recovery but are not loaded.
        }
      }
    }
    return {
      providers,
      settings: parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)
        ? parsed.settings
        : {},
    };
  } catch {
    return { providers: {}, settings: {} };
  }
}

export function writeNewApiConfig(config: NewApiConfig, configPath = getNewApiConfigPath()): void {
  const parent = dirname(configPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const providers = Object.fromEntries(Object.entries(config.providers).map(([name, entry]) => {
    const allowTailnet = entry.allowTailnet === true;
    return [name, {
      baseUrl: normalizeNewApiBaseUrl(entry.baseUrl, { allowTailnet }),
      modelOverrides: entry.modelOverrides ?? {},
      ...(allowTailnet ? { allowTailnet: true } : {}),
    }];
  }));
  writePrivateFileAtomicSync(configPath, JSON.stringify({ ...config, providers }, null, 2));
}

export function normalizeNewApiBaseUrl(value: string, options: { allowTailnet?: boolean } = {}): string {
  const url = canonicalizeOutboundBaseUrl(value, options);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  url.pathname = path || "/";
  return url.toString().replace(/\/+$/, "");
}

export function validateNewApiProviderName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Provider 名称不能为空");
  if (name.length > 128) throw new Error("Provider 名称不能超过 128 个字符");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Provider 名称只能包含字母、数字、点、下划线和连字符");
  if (["__proto__", "constructor", "prototype"].includes(name.toLowerCase())) throw new Error("Provider 名称不可用");
  return name;
}
