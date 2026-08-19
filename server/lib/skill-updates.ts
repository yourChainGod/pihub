import type {
  SkillInstallInfo,
  SkillUpdateResult,
} from "@/lib/api-types";
import { createSecureOutboundFetch } from "./outbound-http-security";

const CHECK_TIMEOUT_MS = 15_000;
const MAX_UPDATE_RESPONSE_BYTES = 2 * 1024 * 1024;
const SKILLS_API_BASE = "https://skills.sh";
const GITHUB_API_BASE = "https://api.github.com";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface CheckOptions {
  fetcher?: Fetcher;
  githubToken?: string;
  signal?: AbortSignal;
}

interface GitHubTreeEntry {
  path?: unknown;
  sha?: unknown;
  type?: unknown;
}

interface GitHubTreeResponse {
  sha?: unknown;
  tree?: unknown;
}

interface SnapshotResponse {
  hash?: unknown;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super("HTTP " + status);
  }
}

export function skillUpdateKey(install: Pick<SkillInstallInfo, "scope" | "package">): string {
  return install.scope + "\0" + install.package;
}

function skillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function skillNameFromPackage(pkg: string): string {
  const at = pkg.lastIndexOf("@");
  return at >= 0 ? pkg.slice(at + 1) : pkg;
}

function skillFolder(skillPath: string): string {
  let folder = skillPath.replace(/\\/g, "/");
  if (folder.toLowerCase().endsWith("/skill.md")) folder = folder.slice(0, -9);
  else if (folder.toLowerCase().endsWith("skill.md")) folder = folder.slice(0, -8);
  return folder.replace(/\/$/, "");
}

function validatedGitHubSource(source: string): string {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(source);
  if (!match || match[2] === "." || match[2] === "..") {
    throw new Error("Invalid GitHub repository source");
  }
  return match[1] + "/" + match[2];
}

function validatedGitRef(ref: string): string {
  if (
    !ref
    || ref.length > 255
    || ref.startsWith("-")
    || ref.startsWith("/")
    || ref.endsWith("/")
    || ref.endsWith(".")
    || ref.includes("..")
    || ref.includes("@{")
    || /[\u0000-\u0020\u007f~^:?*\\[]/.test(ref)
    || ref.split("/").some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"))
  ) {
    throw new Error("Invalid Git reference");
  }
  return ref;
}

function validatedSkillFolder(skillPath: string): string {
  const folder = skillFolder(skillPath);
  if (!folder) return "";
  if (
    folder.length > 4096
    || folder.startsWith("/")
    || /[\u0000-\u001f\u007f\\:]/.test(folder)
    || folder.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid skill path");
  }
  return folder;
}

function result(
  install: SkillInstallInfo,
  state: SkillUpdateResult["state"],
  latestVersion?: string,
  message?: string,
): SkillUpdateResult {
  return {
    package: install.package,
    scope: install.scope,
    state,
    currentVersion: install.versionHash,
    latestVersion,
    message,
  };
}

async function fetchJson(
  url: string,
  fetcher: Fetcher,
  signal: AbortSignal | undefined,
  headers?: HeadersInit,
): Promise<unknown> {
  const response = await fetcher(url, {
    cache: "no-store",
    headers,
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(response.status);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    await response.body?.cancel();
    throw new Error("Remote update metadata was not JSON");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPDATE_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Remote update metadata exceeded the size limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_UPDATE_RESPONSE_BYTES) {
    throw new Error("Remote update metadata exceeded the size limit");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Remote update metadata was invalid JSON");
  }
}

async function checkGlobalSkill(
  install: SkillInstallInfo,
  options: Required<Pick<CheckOptions, "fetcher">> & CheckOptions,
): Promise<SkillUpdateResult> {
  const source = validatedGitHubSource(install.source);
  const ref = validatedGitRef(install.ref || "HEAD");
  const folder = validatedSkillFolder(install.skillPath!);
  const url = new URL("/repos/" + source + "/git/trees/" + encodeURIComponent(ref), GITHUB_API_BASE);
  url.searchParams.set("recursive", "1");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "PiHub/0.0.1",
  };
  if (options.githubToken) headers.Authorization = "Bearer " + options.githubToken;
  const raw = (await fetchJson(url.toString(), options.fetcher, options.signal, headers)) as GitHubTreeResponse;
  let latestVersion = typeof raw.sha === "string" && !folder ? raw.sha : undefined;
  if (folder && Array.isArray(raw.tree) && raw.tree.length <= 100_000) {
    const entry = (raw.tree as GitHubTreeEntry[]).find(
      (item) => item.type === "tree" && item.path === folder,
    );
    if (entry && typeof entry.sha === "string") latestVersion = entry.sha;
  }
  if (!latestVersion || !/^[0-9a-f]{40}$/i.test(latestVersion)) {
    return result(install, "error", undefined, "Remote skill path did not return an immutable tree hash.");
  }
  return result(
    install,
    latestVersion === install.versionHash ? "up-to-date" : "update-available",
    latestVersion,
  );
}

async function checkProjectSkill(
  install: SkillInstallInfo,
  options: Required<Pick<CheckOptions, "fetcher">> & CheckOptions,
): Promise<SkillUpdateResult> {
  const [owner, repo] = validatedGitHubSource(install.source).split("/");
  const name = skillSlug(skillNameFromPackage(install.package));
  if (!name) return result(install, "error", undefined, "Installed skill name is invalid.");
  const url = new URL(
    "/api/download/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/" + encodeURIComponent(name),
    SKILLS_API_BASE,
  );
  const raw = (await fetchJson(url.toString(), options.fetcher, options.signal)) as SnapshotResponse;
  const latestVersion = typeof raw.hash === "string" && /^[0-9a-f]{40,128}$/i.test(raw.hash)
    ? raw.hash
    : undefined;
  if (!latestVersion) {
    return result(install, "error", undefined, "skills.sh did not return an immutable version hash.");
  }
  return result(
    install,
    latestVersion === install.versionHash ? "up-to-date" : "update-available",
    latestVersion,
  );
}

function secureUpdateFetcher(): Fetcher {
  return createSecureOutboundFetch({
    connectTimeoutMs: 10_000,
    headersTimeoutMs: CHECK_TIMEOUT_MS,
    idleTimeoutMs: CHECK_TIMEOUT_MS,
    maxRedirects: 0,
    maxResponseBytes: MAX_UPDATE_RESPONSE_BYTES,
    timeoutMs: CHECK_TIMEOUT_MS,
  });
}

export async function checkSkillUpdate(
  install: SkillInstallInfo,
  options: CheckOptions = {},
): Promise<SkillUpdateResult> {
  if (!install.canCheckForUpdates || !install.versionHash || !install.skillPath) {
    return result(install, "unsupported", undefined, "This lock entry cannot be checked automatically.");
  }
  const fetcher = options.fetcher ?? secureUpdateFetcher();
  try {
    return install.scope === "global"
      ? await checkGlobalSkill(install, { ...options, fetcher })
      : await checkProjectSkill(install, { ...options, fetcher });
  } catch (error) {
    return result(
      install,
      "error",
      undefined,
      error instanceof HttpError ? error.message : "Remote update check failed.",
    );
  }
}

export async function checkSkillUpdates(
  installs: SkillInstallInfo[],
  options: CheckOptions = {},
): Promise<SkillUpdateResult[]> {
  const fetcher = options.fetcher ?? secureUpdateFetcher();
  const requests = new Map<string, Promise<Response>>();
  const cachedFetcher: Fetcher = async (input, init) => {
    const headers = new Headers(init?.headers);
    const cacheKey = input + "\0" + (headers.get("authorization") ?? "");
    let request = requests.get(cacheKey);
    if (!request) {
      request = fetcher(input, init);
      requests.set(cacheKey, request);
    }
    return (await request).clone();
  };
  return Promise.all(
    installs.map((install) => checkSkillUpdate(install, {
      ...options,
      fetcher: cachedFetcher,
    })),
  );
}
