import type { SkillSearchResult } from "./api-types";
import {
  fetchOutboundJson,
  OutboundRequestError,
} from "./outbound-http-security";

export const SKILLS_CATALOG_ORIGIN = "https://skills.sh";
const MAX_QUERY_LENGTH = 200;
const MAX_CATALOG_ITEMS = 200;
const MAX_CATALOG_RESPONSE_BYTES = 256 * 1024;
const CATALOG_TIMEOUT_MS = 5_000;
const SOURCE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SLUG_RE = /^[A-Za-z0-9._/-]{1,300}$/;

interface SkillsApiSkill {
  id?: unknown;
  installs?: unknown;
  name?: unknown;
  source?: unknown;
}

interface SkillsApiResponse {
  skills?: unknown;
}

type SkillsCatalogTestPolicy = Parameters<typeof fetchOutboundJson>[2];

function formatInstalls(count: number): string {
  if (!Number.isSafeInteger(count) || count <= 0) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${count} install${count === 1 ? "" : "s"}`;
}

function parseInstallCount(installs: string): number {
  const match = installs.match(/^([\d.]+)([KMB])?\s+installs?$/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const multiplier = match[2] === "B" ? 1_000_000_000 : match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
  return value * multiplier;
}

function resultUrl(slug: unknown): string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug) || slug.split("/").some((part) => !part)) return "";
  return `${SKILLS_CATALOG_ORIGIN}/${slug.split("/").map(encodeURIComponent).join("/")}`;
}

function parseCatalog(data: unknown, limit: number): SkillSearchResult[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new OutboundRequestError("invalid_json", "Skills catalog returned an invalid JSON object", 502);
  }
  const rawSkills = (data as SkillsApiResponse).skills;
  if (!Array.isArray(rawSkills) || rawSkills.length > MAX_CATALOG_ITEMS) {
    throw new OutboundRequestError("invalid_json", "Skills catalog returned an invalid item list", 502);
  }
  const deduplicated = new Map<string, SkillSearchResult>();
  for (const raw of rawSkills) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const skill = raw as SkillsApiSkill;
    if (typeof skill.source !== "string" || !SOURCE_RE.test(skill.source)) continue;
    if (typeof skill.name !== "string" || !SKILL_NAME_RE.test(skill.name)) continue;
    const packageName = `${skill.source}@${skill.name}`;
    const installs = formatInstalls(typeof skill.installs === "number" ? skill.installs : 0);
    const previous = deduplicated.get(packageName);
    if (!previous || parseInstallCount(installs) > parseInstallCount(previous.installs)) {
      deduplicated.set(packageName, {
        package: packageName,
        installs,
        url: resultUrl(skill.id),
      });
    }
  }
  return [...deduplicated.values()]
    .sort((left, right) => parseInstallCount(right.installs) - parseInstallCount(left.installs))
    .slice(0, limit);
}

export async function searchSkillsCatalog(
  query: string,
  limit: number,
  signal: AbortSignal,
  testPolicy: SkillsCatalogTestPolicy = {},
): Promise<SkillSearchResult[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || normalizedQuery.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(normalizedQuery)) {
    throw new RangeError("Skill search query is invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("Skill search limit is invalid");
  }
  const url = new URL("/api/search", SKILLS_CATALOG_ORIGIN);
  url.searchParams.set("q", normalizedQuery);
  url.searchParams.set("limit", String(limit));
  const response = await fetchOutboundJson(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent": "PiHub/0.0.1",
    },
    signal,
  }, {
    ...testPolicy,
    connectTimeoutMs: Math.min(testPolicy.connectTimeoutMs ?? CATALOG_TIMEOUT_MS, CATALOG_TIMEOUT_MS),
    headersTimeoutMs: Math.min(testPolicy.headersTimeoutMs ?? CATALOG_TIMEOUT_MS, CATALOG_TIMEOUT_MS),
    idleTimeoutMs: Math.min(testPolicy.idleTimeoutMs ?? CATALOG_TIMEOUT_MS, CATALOG_TIMEOUT_MS),
    maxRedirects: 0,
    maxResponseBytes: Math.min(testPolicy.maxResponseBytes ?? MAX_CATALOG_RESPONSE_BYTES, MAX_CATALOG_RESPONSE_BYTES),
    timeoutMs: Math.min(testPolicy.timeoutMs ?? CATALOG_TIMEOUT_MS, CATALOG_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new OutboundRequestError("upstream_failure", `Skills catalog request failed with HTTP ${response.status}`, 502);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new OutboundRequestError("invalid_json", "Skills catalog did not return JSON", 502);
  }
  return parseCatalog(response.data, limit);
}
