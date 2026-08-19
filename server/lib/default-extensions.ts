import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { canonicalizeReleaseJson } from "./release-manifest";

export type DefaultExtensionPackage = Readonly<{
  name: string;
  version: string;
  extensions: readonly string[];
  skills?: readonly string[];
}>;

export const DEFAULT_EXTENSIONS: readonly DefaultExtensionPackage[] = Object.freeze([
  Object.freeze({ name: "@ff-labs/pi-fff", version: "0.10.5", extensions: Object.freeze(["src/index.ts"]) }),
  Object.freeze({ name: "pi-simplify", version: "0.2.3", extensions: Object.freeze(["dist/index.js"]) }),
  Object.freeze({ name: "@gotgenes/pi-permission-system", version: "26.3.0", extensions: Object.freeze(["src/index.ts"]) }),
  Object.freeze({ name: "@eko24ive/pi-ask", version: "1.2.0", extensions: Object.freeze(["src/index.ts"]), skills: Object.freeze(["skills"]) }),
  Object.freeze({ name: "@gotgenes/pi-subagents", version: "19.3.2", extensions: Object.freeze(["src/index.ts"]) }),
]);

const LEGACY_MAGIC_CONTEXT = "@cortexkit/pi-magic-context";
const INVENTORY_SCHEMA_VERSION = 1;
const MAX_INVENTORY_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_PREFERENCE_BYTES = 16 * 1024;
const PREFERENCE_SCHEMA_VERSION = 1;
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

const DEFAULT_PERMISSION_CONFIG = Object.freeze({
  $schema: "https://raw.githubusercontent.com/gotgenes/pi-packages/main/packages/pi-permission-system/schemas/permissions.schema.json",
  debugLog: false,
  permissionReviewLog: true,
  yoloMode: false,
  doublePressToConfirm: true,
  permission: {
    "*": "allow",
    path: {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow",
      "*.pem": "deny",
      "*.key": "deny",
      "*.p12": "deny",
      "*.pfx": "deny",
      id_rsa: "deny",
      id_ed25519: "deny",
      id_ecdsa: "deny",
      "~/.ssh/*": "deny",
      "~/.aws/*": "deny",
      "~/.config/gh/*": "deny",
      "~/.netrc": "deny",
    },
    bash: {
      "*": "allow",
      "rm -rf /*": "deny",
      "rm -rf ~": "deny",
      "rm -rf /": "deny",
      "mkfs*": "deny",
      "dd if=* of=/dev/*": "deny",
      "shutdown*": "deny",
      "reboot*": "deny",
      "sudo *": "ask",
      "curl * | sh": "ask",
      "curl * | bash": "ask",
      "wget * | sh": "ask",
      "wget * | bash": "ask",
      "chmod -R 777 *": "ask",
      "chown -R *": "ask",
      "git push --force*": "ask",
      "git reset --hard*": "ask",
    },
    external_directory: {
      "*": "allow",
      "~/.ssh/*": "deny",
    },
  },
});

type InventoryFile = { path: string; size: number; sha256: string };
type FileSnapshot = { file: string; contents: Buffer | null };

export type DefaultExtensionsStatus = Readonly<{
  installed: boolean;
  installedCount: number;
  total: number;
  source: "signed-release";
  packages: readonly Readonly<{ name: string; version: string; installed: boolean }>[];
}>;

export type ProvisionDefaultExtensionsOptions = {
  agentDir?: string;
  environment?: NodeJS.ProcessEnv;
  expectedPackages?: readonly Readonly<{ name: string; version: string }>[];
  home?: string;
};

export function defaultExtensionsPreferenceText(enabled: boolean): string {
  return canonicalizeReleaseJson({
    schemaVersion: PREFERENCE_SCHEMA_VERSION,
    enabled,
  });
}

export async function readDefaultExtensionsPreference(dataRootValue: string): Promise<boolean> {
  const dataRoot = safeAbsolutePath(dataRootValue, "PiHub Server data root");
  const raw = await readRegularFileBounded(
    path.join(dataRoot, "state", "default-extensions.json"),
    MAX_PREFERENCE_BYTES,
  );
  if (raw === null) return false;
  const text = raw.toString("utf8");
  let preference: unknown;
  try {
    preference = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Default extension preference is invalid");
  }
  if (!isRecord(preference)
      || !hasExactKeys(preference, ["schemaVersion", "enabled"])
      || preference.schemaVersion !== PREFERENCE_SCHEMA_VERSION
      || typeof preference.enabled !== "boolean"
      || canonicalizeReleaseJson(preference) !== text) {
    throw new Error("Default extension preference is invalid");
  }
  return preference.enabled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function safeAbsolutePath(value: string, description: string): string {
  if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(`${description} must be an absolute path without control characters`);
  }
  return path.resolve(value);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function packageSegments(name: string): string[] {
  if (!PACKAGE_NAME.test(name)) throw new Error("Default extension package name is invalid");
  return name.split("/");
}

function facadeSource(name: string): string {
  return `pihub/packages/${name}`;
}

function npmIdentity(source: string): string | null {
  if (!source.startsWith("npm:")) return null;
  const specification = source.slice(4);
  if (specification.startsWith("@")) {
    const slash = specification.indexOf("/");
    const marker = specification.indexOf("@", slash + 1);
    return marker < 0 ? specification : specification.slice(0, marker);
  }
  const marker = specification.indexOf("@");
  return marker < 0 ? specification : specification.slice(0, marker);
}

function packageSource(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.source === "string") return value.source;
  return null;
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Default extension storage contains an unsafe directory");
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);
  return realpath(directory);
}

async function ensurePrivateSubdirectory(root: string, segments: readonly string[]): Promise<string> {
  const rootReal = await ensurePrivateDirectory(root);
  let current = root;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
      throw new Error("Default extension storage path is invalid");
    }
    current = path.join(current, segment);
    const currentReal = await ensurePrivateDirectory(current);
    if (!isWithin(rootReal, currentReal)) throw new Error("Default extension storage escapes its private root");
  }
  return current;
}

async function readRegularFileBounded(file: string, maxBytes: number): Promise<Buffer | null> {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) {
    throw new Error("Default extension state file is invalid");
  }
  return readFile(file);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32" && !new Set(["EINVAL", "ENOTSUP", "EISDIR"]).has((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWritePrivate(file: string, contents: string | Buffer): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomBytes(16).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    if (process.platform !== "win32") await chmod(file, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function portableInventoryPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\\") || /[\0-\x1f\x7f]/.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return !value.startsWith("/") && segments.every((segment) => segment && segment !== "." && segment !== "..");
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    input.once("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("end", () => resolve(hash.digest("hex")));
  });
}

function expectedPackageContract(expected: ProvisionDefaultExtensionsOptions["expectedPackages"]): void {
  if (expected === undefined) return;
  if (expected.length !== DEFAULT_EXTENSIONS.length) throw new Error("Default extension contract does not match this signed release");
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index]?.name !== DEFAULT_EXTENSIONS[index].name || expected[index]?.version !== DEFAULT_EXTENSIONS[index].version) {
      throw new Error("Default extension contract does not match this signed release");
    }
  }
}

async function readInventory(extensionRoot: string): Promise<InventoryFile[]> {
  const raw = await readRegularFileBounded(path.join(extensionRoot, "inventory.json"), MAX_INVENTORY_BYTES);
  if (raw === null) throw new Error("Signed release does not contain the default extension inventory");
  const text = raw.toString("utf8");
  let inventory: unknown;
  try {
    inventory = JSON.parse(text);
  } catch {
    throw new Error("Default extension inventory is not valid JSON");
  }
  if (!isRecord(inventory)
      || !hasExactKeys(inventory, ["schemaVersion", "packages", "files", "totalBytes"])
      || inventory.schemaVersion !== INVENTORY_SCHEMA_VERSION
      || canonicalizeReleaseJson(inventory) !== text
      || !Array.isArray(inventory.packages)
      || !Array.isArray(inventory.files)
      || inventory.packages.length !== DEFAULT_EXTENSIONS.length
      || inventory.files.length === 0
      || inventory.files.length > MAX_FILES
      || !Number.isSafeInteger(inventory.totalBytes)
      || Number(inventory.totalBytes) < 0
      || Number(inventory.totalBytes) > MAX_TOTAL_BYTES) {
    throw new Error("Default extension inventory contract is invalid");
  }
  for (let index = 0; index < DEFAULT_EXTENSIONS.length; index += 1) {
    const entry = inventory.packages[index];
    const expected = DEFAULT_EXTENSIONS[index];
    if (!isRecord(entry) || !hasExactKeys(entry, ["name", "version"])
        || entry.name !== expected.name || entry.version !== expected.version) {
      throw new Error("Default extension inventory package list is invalid");
    }
  }
  let previous = "";
  let totalBytes = 0;
  const files: InventoryFile[] = [];
  for (const rawEntry of inventory.files) {
    if (!isRecord(rawEntry) || !hasExactKeys(rawEntry, ["path", "size", "sha256"])
        || !portableInventoryPath(rawEntry.path)
        || (rawEntry.path !== "package.json"
          && rawEntry.path !== "package-lock.json"
          && !rawEntry.path.startsWith("node_modules/"))
        || rawEntry.path <= previous
        || !Number.isSafeInteger(rawEntry.size) || Number(rawEntry.size) < 0
        || Number(rawEntry.size) > MAX_TOTAL_BYTES
        || typeof rawEntry.sha256 !== "string" || !SHA256.test(rawEntry.sha256)) {
      throw new Error("Default extension inventory file list is invalid");
    }
    previous = rawEntry.path;
    totalBytes += Number(rawEntry.size);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("Default extension inventory exceeds its size limit");
    }
    files.push({ path: rawEntry.path, size: Number(rawEntry.size), sha256: rawEntry.sha256 });
  }
  if (totalBytes !== inventory.totalBytes) throw new Error("Default extension inventory total is invalid");
  return files;
}

async function collectPhysicalFiles(extensionRoot: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, relative: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error("Default extension tree contains a symbolic link");
      if (info.isDirectory()) {
        await visit(child, childRelative);
      } else if (info.isFile() && info.nlink === 1) {
        if (childRelative !== "inventory.json") files.push(childRelative);
      } else {
        throw new Error("Default extension tree contains an unsupported filesystem entry");
      }
      if (files.length > MAX_FILES) throw new Error("Default extension tree contains too many files");
    }
  };
  await visit(extensionRoot, "");
  return files;
}

async function verifyInventoryFiles(extensionRoot: string, inventory: readonly InventoryFile[]): Promise<void> {
  const physical = await collectPhysicalFiles(extensionRoot);
  if (physical.length !== inventory.length || physical.some((file, index) => file !== inventory[index].path)) {
    throw new Error("Default extension tree does not match its signed inventory");
  }
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, inventory.length) }, async () => {
    while (cursor < inventory.length) {
      const index = cursor;
      cursor += 1;
      const entry = inventory[index];
      const file = path.join(extensionRoot, ...entry.path.split("/"));
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== entry.size) {
        throw new Error("Default extension file metadata does not match its signed inventory");
      }
      if (await sha256File(file) !== entry.sha256) {
        throw new Error("Default extension file digest does not match its signed inventory");
      }
    }
  });
  await Promise.all(workers);
}

async function validatePackageEntries(extensionRoot: string): Promise<void> {
  const nodeModules = await realpath(path.join(extensionRoot, "node_modules"));
  for (const extension of DEFAULT_EXTENSIONS) {
    const packageRoot = path.join(extensionRoot, "node_modules", ...packageSegments(extension.name));
    const packageReal = await realpath(packageRoot);
    if (!isWithin(nodeModules, packageReal)) throw new Error("Default extension package escapes node_modules");
    const metadataRaw = await readRegularFileBounded(path.join(packageRoot, "package.json"), MAX_PACKAGE_JSON_BYTES);
    if (metadataRaw === null) throw new Error("Default extension package metadata is missing");
    let metadata: unknown;
    try {
      metadata = JSON.parse(metadataRaw.toString("utf8"));
    } catch {
      throw new Error("Default extension package metadata is invalid");
    }
    if (!isRecord(metadata) || metadata.name !== extension.name || metadata.version !== extension.version) {
      throw new Error("Default extension package identity is invalid");
    }
    for (const relative of [...extension.extensions, ...(extension.skills ?? [])]) {
      const candidate = path.join(packageRoot, ...relative.split("/"));
      const info = await lstat(candidate);
      const candidateReal = await realpath(candidate);
      const expectedDirectory = extension.skills?.includes(relative) === true;
      if (!isWithin(packageReal, candidateReal) || info.isSymbolicLink()
          || (expectedDirectory ? !info.isDirectory() : (!info.isFile() || info.nlink !== 1))) {
        throw new Error("Default extension package entry is invalid");
      }
    }
  }
}

export async function validateDefaultExtensionBundle(
  packageRootValue: string,
  expectedPackages?: ProvisionDefaultExtensionsOptions["expectedPackages"],
): Promise<void> {
  expectedPackageContract(expectedPackages);
  const packageRoot = safeAbsolutePath(packageRootValue, "Signed release root");
  const packageRootReal = await realpath(packageRoot);
  const extensionRoot = path.join(packageRoot, "extensions");
  const extensionRootReal = await realpath(extensionRoot);
  if (!isWithin(packageRootReal, extensionRootReal)) throw new Error("Default extension tree escapes the signed release");
  const inventory = await readInventory(extensionRoot);
  await verifyInventoryFiles(extensionRoot, inventory);
  await validatePackageEntries(extensionRoot);
}

function configuredAgentDirectory(options: ProvisionDefaultExtensionsOptions): string {
  const environment = options.environment ?? process.env;
  const configured = options.agentDir ?? environment.PI_CODING_AGENT_DIR?.trim();
  if (configured) return safeAbsolutePath(configured, "Pi agent directory");
  return path.join(safeAbsolutePath(options.home ?? homedir(), "Home directory"), ".pi", "agent");
}

async function extensionStatus(packageRootValue: string, options: ProvisionDefaultExtensionsOptions): Promise<DefaultExtensionsStatus> {
  const packageRoot = safeAbsolutePath(packageRootValue, "Signed release root");
  const agentDir = configuredAgentDirectory(options);
  const settingsRaw = await readRegularFileBounded(path.join(agentDir, "settings.json"), MAX_SETTINGS_BYTES).catch(() => null);
  let configured = new Set<string>();
  if (settingsRaw !== null) {
    try {
      const settings = JSON.parse(settingsRaw.toString("utf8")) as { packages?: unknown };
      if (Array.isArray(settings.packages)) {
        configured = new Set(settings.packages.map(packageSource).filter((source): source is string => typeof source === "string"));
      }
    } catch { /* reported as not installed */ }
  }
  const packages = [];
  for (const extension of DEFAULT_EXTENSIONS) {
    let installed = configured.has(facadeSource(extension.name));
    try {
      const facade = path.join(agentDir, "pihub", "packages", ...packageSegments(extension.name), "package.json");
      const raw = await readRegularFileBounded(facade, MAX_PACKAGE_JSON_BYTES);
      const metadata = raw === null ? null : JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      if (!isRecord(metadata) || metadata.name !== extension.name || metadata.version !== extension.version || !isRecord(metadata.pi)) {
        installed = false;
      } else {
        const expectedRoot = path.join(packageRoot, "extensions", "node_modules", ...packageSegments(extension.name));
        const extensions = metadata.pi.extensions;
        const skills = metadata.pi.skills;
        installed = installed
          && Array.isArray(extensions)
          && extensions.length === extension.extensions.length
          && extensions.every((entry, index) => entry === path.join(expectedRoot, ...extension.extensions[index].split("/")))
          && (extension.skills === undefined
            ? skills === undefined
            : Array.isArray(skills)
              && skills.length === extension.skills.length
              && skills.every((entry, index) => entry === path.join(expectedRoot, ...extension.skills![index].split("/"))));
      }
    } catch {
      installed = false;
    }
    packages.push(Object.freeze({ name: extension.name, version: extension.version, installed }));
  }
  const installedCount = packages.filter((entry) => entry.installed).length;
  return Object.freeze({
    installed: installedCount === packages.length,
    installedCount,
    total: packages.length,
    source: "signed-release" as const,
    packages: Object.freeze(packages),
  });
}

export async function inspectDefaultExtensions(
  packageRoot: string,
  options: ProvisionDefaultExtensionsOptions = {},
): Promise<DefaultExtensionsStatus> {
  try {
    return await extensionStatus(packageRoot, options);
  } catch {
    return Object.freeze({
      installed: false,
      installedCount: 0,
      total: DEFAULT_EXTENSIONS.length,
      source: "signed-release" as const,
      packages: Object.freeze(DEFAULT_EXTENSIONS.map((extension) => Object.freeze({
        name: extension.name,
        version: extension.version,
        installed: false,
      }))),
    });
  }
}

export async function provisionDefaultExtensions(
  packageRootValue: string,
  options: ProvisionDefaultExtensionsOptions = {},
): Promise<{ rollback: () => Promise<void>; status: DefaultExtensionsStatus }> {
  await validateDefaultExtensionBundle(packageRootValue, options.expectedPackages);
  const packageRoot = safeAbsolutePath(packageRootValue, "Signed release root");
  const agentDir = configuredAgentDirectory(options);
  await ensurePrivateDirectory(agentDir);
  await ensurePrivateSubdirectory(agentDir, ["pihub", "packages"]);
  const snapshots: FileSnapshot[] = [];
  const snapshotted = new Set<string>();
  const snapshot = async (file: string, maxBytes: number): Promise<Buffer | null> => {
    if (snapshotted.has(file)) throw new Error("Default extension transaction contains a duplicate target");
    const contents = await readRegularFileBounded(file, maxBytes);
    snapshots.push({ file, contents });
    snapshotted.add(file);
    return contents;
  };
  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    const failures = [];
    for (const entry of snapshots.toReversed()) {
      try {
        if (entry.contents === null) {
          await unlink(entry.file).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        } else {
          await atomicWritePrivate(entry.file, entry.contents);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Default extension rollback was incomplete");
  };

  try {
    for (const extension of DEFAULT_EXTENSIONS) {
      const facadeDirectory = await ensurePrivateSubdirectory(
        path.join(agentDir, "pihub", "packages"),
        packageSegments(extension.name),
      );
      const facadeFile = path.join(facadeDirectory, "package.json");
      await snapshot(facadeFile, MAX_PACKAGE_JSON_BYTES);
      const sourceRoot = path.join(packageRoot, "extensions", "node_modules", ...packageSegments(extension.name));
      const pi: Record<string, string[]> = {
        extensions: extension.extensions.map((relative) => path.join(sourceRoot, ...relative.split("/"))),
      };
      if (extension.skills) {
        pi.skills = extension.skills.map((relative) => path.join(sourceRoot, ...relative.split("/")));
      }
      await atomicWritePrivate(facadeFile, `${JSON.stringify({
        name: extension.name,
        version: extension.version,
        private: true,
        pi,
      }, null, 2)}\n`);
    }

    const settingsFile = path.join(agentDir, "settings.json");
    const settingsRaw = await snapshot(settingsFile, MAX_SETTINGS_BYTES);
    let settings: Record<string, unknown> = {};
    if (settingsRaw !== null) {
      try {
        settings = JSON.parse(settingsRaw.toString("utf8")) as Record<string, unknown>;
      } catch {
        throw new Error("Pi settings.json is invalid");
      }
    }
    if (!isRecord(settings) || (settings.packages !== undefined && !Array.isArray(settings.packages))) {
      throw new Error("Pi settings.json package configuration is invalid");
    }
    const managedNames = new Set([...DEFAULT_EXTENSIONS.map((entry) => entry.name), LEGACY_MAGIC_CONTEXT]);
    const managedFacades = new Set([...DEFAULT_EXTENSIONS.map((entry) => facadeSource(entry.name)), facadeSource(LEGACY_MAGIC_CONTEXT)]);
    const retained = (settings.packages ?? []).filter((entry) => {
      const source = packageSource(entry);
      if (source === null || source.length > 4096 || /[\0\r\n]/.test(source)) {
        throw new Error("Pi settings.json contains an invalid package entry");
      }
      const normalized = source.replaceAll("\\", "/");
      const identity = npmIdentity(source);
      return !managedFacades.has(normalized) && (identity === null || !managedNames.has(identity));
    });
    retained.push(...DEFAULT_EXTENSIONS.map((entry) => facadeSource(entry.name)));
    await atomicWritePrivate(settingsFile, `${JSON.stringify({ ...settings, packages: retained }, null, 2)}\n`);

    const permissionDirectory = await ensurePrivateSubdirectory(agentDir, ["extensions", "pi-permission-system"]);
    const permissionFile = path.join(permissionDirectory, "config.json");
    const permissionRaw = await snapshot(permissionFile, MAX_CONFIG_BYTES);
    if (permissionRaw === null) {
      await atomicWritePrivate(permissionFile, `${JSON.stringify(DEFAULT_PERMISSION_CONFIG, null, 2)}\n`);
    }

    const legacyFacade = path.join(agentDir, "pihub", "packages", ...packageSegments(LEGACY_MAGIC_CONTEXT), "package.json");
    const legacyRaw = await snapshot(legacyFacade, MAX_PACKAGE_JSON_BYTES);
    if (legacyRaw !== null) await unlink(legacyFacade);

    return { rollback, status: await extensionStatus(packageRoot, options) };
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Default extension provisioning and rollback both failed");
    }
    throw error;
  }
}
