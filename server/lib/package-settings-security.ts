import {
  lstatSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  CONFIG_DIR_NAME,
  type PackageSource,
} from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";

const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_CONFIGURED_PACKAGES = 256;
const MAX_SOURCE_LENGTH = 2048;
const DISABLED_MARKER = "pihubDisabledV1";
const PACKAGE_ID_PATTERN = /^pkg_[A-Za-z0-9_-]{43}$/;

type StoredPackageSource = {
  autoload?: boolean;
  extensions?: string[];
  prompts?: string[];
  skills?: string[];
  source: string;
  themes?: string[];
  [DISABLED_MARKER]?: PackageSource;
};

export type PackageSettingsMutationCode =
  | "ambiguous-source"
  | "invalid-settings"
  | "legacy-disabled"
  | "not-configured"
  | "unsafe-settings-path";

export class PackageSettingsMutationError extends Error {
  constructor(
    public readonly code: PackageSettingsMutationCode,
    message: string,
  ) {
    super(message);
    this.name = "PackageSettingsMutationError";
  }
}

function fail(code: PackageSettingsMutationCode, message: string): never {
  throw new PackageSettingsMutationError(code, message);
}

function packageSource(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const source = (entry as { source?: unknown }).source;
  return typeof source === "string" ? source : null;
}

export function configuredPackageId(scope: "global" | "project", source: string): string {
  return `pkg_${createHash("sha256").update(scope).update("\0").update(source).digest("base64url")}`;
}

function isDisabled(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const value = entry as Record<string, unknown>;
  return value.autoload === false
    && ["extensions", "skills", "prompts", "themes"].every(
      (key) => Array.isArray(value[key]) && (value[key] as unknown[]).length === 0,
    );
}

function disabledEntry(entry: PackageSource): StoredPackageSource {
  if (typeof entry === "object" && DISABLED_MARKER in entry) {
    const original = (entry as Record<string, unknown>)[DISABLED_MARKER];
    if (isDisabled(entry) && packageSource(original) === packageSource(entry)) {
      return entry as StoredPackageSource;
    }
    fail("invalid-settings", "Stored PiHub package disable state is invalid");
  }
  return {
    source: packageSource(entry)!,
    autoload: false,
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    [DISABLED_MARKER]: structuredClone(entry),
  };
}

function enabledEntry(entry: PackageSource): PackageSource {
  if (!isDisabled(entry)) return entry;
  if (typeof entry === "string") return entry;
  const original = (entry as StoredPackageSource)[DISABLED_MARKER];
  if (packageSource(original) !== packageSource(entry)) {
    fail(
      "legacy-disabled",
      "This package was disabled without a restorable PiHub state and cannot be enabled remotely",
    );
  }
  return structuredClone(original!);
}

function settingsPath(cwd: string, agentDir: string, scope: "global" | "project"): string {
  return scope === "project"
    ? path.join(cwd, CONFIG_DIR_NAME, "settings.json")
    : path.join(agentDir, "settings.json");
}

function assertSafeSettingsFile(filename: string): void {
  const directory = path.dirname(filename);
  const directoryStat = lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    fail("unsafe-settings-path", "Package settings directory is not a regular directory");
  }
  const fileStat = lstatSync(filename, { throwIfNoEntry: false });
  if (!fileStat) fail("not-configured", "Configured package was not found");
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    fail("unsafe-settings-path", "Package settings must be a regular file");
  }
  if (fileStat.size > MAX_SETTINGS_BYTES) {
    fail("invalid-settings", "Package settings exceed the size limit");
  }
}

function readSettings(filename: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    fail("invalid-settings", "Package settings are not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("invalid-settings", "Package settings must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function configuredPackages(settings: Record<string, unknown>): PackageSource[] {
  const raw = settings.packages;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_CONFIGURED_PACKAGES) {
    fail("invalid-settings", "Configured package list is invalid or exceeds its limit");
  }
  for (const entry of raw) {
    const source = packageSource(entry);
    if (!source || source.length > MAX_SOURCE_LENGTH || /[\u0000-\u001f\u007f]/.test(source)) {
      fail("invalid-settings", "Configured package source is invalid");
    }
  }
  return raw as PackageSource[];
}

function acquireSettingsLock(filename: string, signal: AbortSignal): () => void {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal.throwIfAborted();
    try {
      return lockfile.lockSync(filename, { realpath: false });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
      const deadline = Date.now() + 10;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
      }
    }
  }
  throw new Error("Package settings lock could not be acquired");
}

export function setConfiguredPackageDisabled(options: {
  agentDir: string;
  cwd: string;
  disabled: boolean;
  packageId: string;
  scope: "global" | "project";
  signal: AbortSignal;
}): { changed: boolean } {
  const { agentDir, cwd, disabled, packageId, scope, signal } = options;
  if (!PACKAGE_ID_PATTERN.test(packageId)) {
    fail("not-configured", "Configured package was not found");
  }
  signal.throwIfAborted();
  const filename = settingsPath(cwd, agentDir, scope);
  assertSafeSettingsFile(filename);

  let release: (() => void) | undefined;
  try {
    release = acquireSettingsLock(filename, signal);
    signal.throwIfAborted();
    assertSafeSettingsFile(filename);
    const settings = readSettings(filename);
    const packages = configuredPackages(settings);
    const matches = packages
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => configuredPackageId(scope, packageSource(entry)!) === packageId);
    if (matches.length === 0) fail("not-configured", "Configured package was not found");
    if (matches.length !== 1) fail("ambiguous-source", "Configured package source is ambiguous");

    const current = matches[0].entry;
    const next = disabled ? disabledEntry(current) : enabledEntry(current);
    if (JSON.stringify(current) === JSON.stringify(next)) return { changed: false };
    const nextPackages = [...packages];
    nextPackages[matches[0].index] = next;
    const serialized = `${JSON.stringify({ ...settings, packages: nextPackages }, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) {
      fail("invalid-settings", "Updated package settings exceed the size limit");
    }
    signal.throwIfAborted();
    writePrivateFileAtomicSync(filename, serialized);
    return { changed: true };
  } finally {
    release?.();
  }
}
