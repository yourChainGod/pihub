import { NextResponse } from "next/server";
import { existsSync, lstatSync, readFileSync } from "fs";
import { join } from "path";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
  type PackageSource,
  type ResolvedPaths,
} from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  configuredPackageId,
  PackageSettingsMutationError,
  setConfiguredPackageDisabled,
} from "@/lib/package-settings-security";
import { hasJsonContentType } from "@/lib/request-security";
import { readBoundedJsonRequest } from "@/lib/outbound-http-security";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginScope,
  PluginsResponse,
} from "@/lib/api-types";

export const dynamic = "force-dynamic";

type PluginAction = "install" | "remove" | "update" | "disable" | "enable";

const MAX_CONFIGURED_PACKAGES = 256;
const MAX_PACKAGE_METADATA_BYTES = 64 * 1024;
const MAX_PACKAGE_SOURCE_LENGTH = 2048;
const MAX_VISIBLE_PACKAGE_RESOURCES = 10_000;

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(body, { ...init, headers });
}

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function toPluginScope(scope: string): PluginScope {
  return scope === "project" ? "project" : "global";
}

function keyFor(source: string, scope: PluginScope): string {
  return `${scope}\0${source}`;
}

function getPackageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function isDisabledPackage(entry: PackageSource): boolean {
  if (typeof entry === "string") return false;
  return (
    Array.isArray(entry.extensions) && entry.extensions.length === 0 &&
    Array.isArray(entry.skills) && entry.skills.length === 0 &&
    Array.isArray(entry.prompts) && entry.prompts.length === 0 &&
    Array.isArray(entry.themes) && entry.themes.length === 0
  );
}

function getDisabledPackages(settingsManager: SettingsManager): Map<string, boolean> {
  const disabled = new Map<string, boolean>();
  for (const entry of settingsManager.getGlobalSettings().packages ?? []) {
    disabled.set(keyFor(getPackageSource(entry), "global"), isDisabledPackage(entry));
  }
  for (const entry of settingsManager.getProjectSettings().packages ?? []) {
    disabled.set(keyFor(getPackageSource(entry), "project"), isDisabledPackage(entry));
  }
  return disabled;
}

function addCount(counts: PluginResourceCounts, kind: keyof PluginResourceCounts): void {
  counts[kind] += 1;
}

function readPackageMetadata(installedPath?: string): { packageName?: string; version?: string } {
  if (!installedPath) return {};
  try {
    const stats = lstatSync(installedPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return {};
    const packageJsonPath = join(installedPath, "package.json");
    if (!existsSync(packageJsonPath)) return {};
    const packageJsonStat = lstatSync(packageJsonPath);
    if (packageJsonStat.isSymbolicLink() || !packageJsonStat.isFile()
        || packageJsonStat.size > MAX_PACKAGE_METADATA_BYTES) return {};
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    const safeValue = (value: unknown, pattern: RegExp): string | undefined => typeof value === "string"
      && value.length > 0
      && value.length <= 128
      && !/[\u0000-\u001f\u007f]/.test(value)
      && pattern.test(value)
      ? value
      : undefined;
    return {
      packageName: safeValue(parsed.name, /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/),
      version: safeValue(parsed.version, /^[0-9A-Za-z.+-]+$/),
    };
  } catch {
    return {};
  }
}

function safePackageLabel(source: string, packageName?: string): string {
  if (packageName) return packageName;
  if (source.startsWith("npm:")) {
    const spec = source.slice(4).trim();
    const lastAt = spec.lastIndexOf("@");
    const nameEnd = spec.startsWith("@") ? spec.indexOf("/", 1) : 0;
    const name = lastAt > nameEnd ? spec.slice(0, lastAt) : spec;
    if (/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) && name.length <= 128) return name;
    return "Configured npm plugin";
  }
  if (source.startsWith("git:") || /^(?:https?|ssh):\/\//i.test(source)
      || /^[^@\s]+@[^:\s]+:/.test(source)) return "Configured Git plugin";
  return "Configured local plugin";
}

function collectResource(
  resource: ResolvedPaths["extensions"][number],
  kind: keyof PluginResourceCounts,
  countsByPackage: Map<string, PluginResourceCounts>,
  totals: PluginResourceCounts,
): void {
  if (!resource.enabled || resource.metadata.origin !== "package") return;
  const source = resource.metadata.source;
  const scope = toPluginScope(resource.metadata.scope);
  const key = keyFor(source, scope);
  const counts = countsByPackage.get(key) ?? emptyCounts();
  addCount(counts, kind);
  addCount(totals, kind);
  countsByPackage.set(key, counts);
}

function collectResources(paths: ResolvedPaths, signal: AbortSignal): {
  countsByPackage: Map<string, PluginResourceCounts>;
  totals: PluginResourceCounts;
} {
  const countsByPackage = new Map<string, PluginResourceCounts>();
  const totals = emptyCounts();
  let visibleResources = 0;
  const collect = (resources: ResolvedPaths["extensions"], kind: keyof PluginResourceCounts) => {
    for (const resource of resources) {
      signal.throwIfAborted();
      if (resource.enabled && resource.metadata.origin === "package") {
        visibleResources += 1;
        if (visibleResources > MAX_VISIBLE_PACKAGE_RESOURCES) {
          throw new Error("Configured plugin resources exceed the response limit");
        }
      }
      collectResource(resource, kind, countsByPackage, totals);
    }
  };
  collect(paths.extensions, "extensions");
  collect(paths.skills, "skills");
  collect(paths.prompts, "prompts");
  collect(paths.themes, "themes");
  return { countsByPackage, totals };
}

async function readPlugins(cwd: string, signal: AbortSignal): Promise<PluginsResponse> {
  signal.throwIfAborted();
  const agentDir = getAgentDir();
  const projectTrust = getProjectTrustStatus(cwd, agentDir);
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: projectTrust.trusted,
  });
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });
  const configuredPackages = packageManager.listConfiguredPackages();
  if (configuredPackages.length > MAX_CONFIGURED_PACKAGES
      || configuredPackages.some((pkg) => !pkg.source || pkg.source.length > MAX_PACKAGE_SOURCE_LENGTH
        || /[\u0000-\u001f\u007f]/.test(pkg.source))) {
    throw new Error("Configured plugin list is invalid or exceeds its limit");
  }

  const diagnostics: PluginDiagnostic[] = [];
  let countsByPackage = new Map<string, PluginResourceCounts>();
  let totals = emptyCounts();
  const disabledByPackage = getDisabledPackages(settingsManager);

  try {
    const resolved = await packageManager.resolve(async () => {
      signal.throwIfAborted();
      diagnostics.push({
        type: "warning",
        message: "Package is configured but not installed yet.",
      });
      return "skip";
    });
    signal.throwIfAborted();
    ({ countsByPackage, totals } = collectResources(resolved, signal));
  } catch {
    signal.throwIfAborted();
    diagnostics.push({
      type: "error",
      message: "Package resources could not be resolved.",
    });
  }

  const packages = configuredPackages.map((pkg) => {
    signal.throwIfAborted();
    const scope = toPluginScope(pkg.scope);
    const key = keyFor(pkg.source, scope);
    const disabled = disabledByPackage.get(key) ?? false;
    const counts = countsByPackage.get(key) ?? emptyCounts();
    const resourceCount = counts.extensions + counts.skills + counts.prompts + counts.themes;
    const packageMetadata = readPackageMetadata(pkg.installedPath);
    if (!pkg.installedPath) {
      diagnostics.push({
        type: "warning",
        message: "Configured package path was not found.",
      });
    }
    return {
      id: configuredPackageId(scope, pkg.source),
      label: safePackageLabel(pkg.source, packageMetadata.packageName),
      scope,
      disabled,
      version: packageMetadata.version,
      counts,
      status: disabled ? "disabled" : resourceCount > 0 ? "loaded" : pkg.installedPath ? "installed" : "missing",
    } satisfies PluginPackageInfo;
  });

  return {
    packages,
    totals,
    diagnostics,
    projectResourcesLoaded: projectTrust.trusted,
  };
}

function readScope(scope: unknown): PluginScope | null {
  return scope === "project" || scope === "global" ? scope : null;
}

export async function GET(req: Request) {
  const authentication = getTrustedPihubRequestContext(req);
  if (!authentication) {
    return privateJson({ error: "Authentication required" }, { status: 401 });
  }
  if (!authentication.capabilities.includes("packages:read")) {
    return privateJson({ error: "Insufficient capability" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return privateJson({ error: "cwd required" }, { status: 400 });

  try {
    const allowedRoots = await getAllowedFileRoots({ ownerId: authentication.deviceId });
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return privateJson({ error: "Access denied" }, { status: 403 });
    }
    return privateJson(await readPlugins(cwd, req.signal));
  } catch {
    return privateJson({ error: "Unable to load plugins" }, { status: 500 });
  }
}

// POST /api/plugins body: { action, packageId?, scope?, cwd }
export async function POST(req: Request) {
  const authentication = getTrustedPihubRequestContext(req);
  if (!authentication) {
    return privateJson({ error: "Authentication required" }, { status: 401 });
  }
  if (!authentication.capabilities.includes("packages:manage")) {
    return privateJson({ error: "Insufficient capability" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return privateJson({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const raw = await readBoundedJsonRequest(req, 16 * 1024);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return privateJson({ error: "Expected a JSON object" }, { status: 400 });
    }
    const body = raw as {
      action?: unknown;
      packageId?: unknown;
      scope?: unknown;
      cwd?: unknown;
    };
    const action = typeof body.action === "string" ? body.action as PluginAction : undefined;
    if (!action) return privateJson({ error: "action required" }, { status: 400 });
    if (["install", "update", "remove"].includes(action)) {
      return privateJson({
        code: "signed_catalog_required",
        error: "Plugin package mutations are unavailable until a signed immutable catalog is configured",
      }, { status: 410 });
    }
    if (action !== "enable" && action !== "disable") {
      return privateJson({ error: "Unsupported action" }, { status: 400 });
    }
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const packageId = typeof body.packageId === "string" ? body.packageId : "";
    const scope = readScope(body.scope);
    if (!cwd) return privateJson({ error: "cwd required" }, { status: 400 });
    if (!packageId) return privateJson({ error: "packageId required" }, { status: 400 });
    if (!scope) return privateJson({ error: "scope must be global or project" }, { status: 400 });
    req.signal.throwIfAborted();
    const allowedRoots = await getAllowedFileRoots({ ownerId: authentication.deviceId });
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return privateJson({ error: "Access denied" }, { status: 403 });
    }

    const agentDir = getAgentDir();
    const projectTrust = getProjectTrustStatus(cwd, agentDir);
    if (scope === "project" && !projectTrust.trusted) {
      return privateJson(
        { error: "Project resources must be trusted before modifying project plugins" },
        { status: 403 },
      );
    }
    setConfiguredPackageDisabled({
      agentDir,
      cwd,
      disabled: action === "disable",
      packageId,
      scope,
      signal: req.signal,
    });

    return privateJson(await readPlugins(cwd, req.signal));
  } catch (error) {
    if (error instanceof PackageSettingsMutationError) {
      const status = error.code === "not-configured" ? 404
        : error.code === "legacy-disabled" || error.code === "ambiguous-source" ? 409
          : 400;
      return privateJson({ code: error.code, error: error.message }, { status });
    }
    return privateJson({ error: "Plugin operation failed" }, { status: 500 });
  }
}
