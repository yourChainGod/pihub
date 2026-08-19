import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  assertTreeDoesNotContainPaths,
  normalizePortableNextBuildPaths,
  pruneServerBuildMetadata,
  scanServerStagingTree,
} from "./server-resource-privacy.mjs";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");
const BUILD_DIRECTORY_NAME = "pihub-portable-build";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const SOURCE_EXCLUSIONS = new Set([
  ".git",
  ".next",
  "node_modules",
  "next-env.d.ts",
  "tsconfig.tsbuildinfo",
]);

function readServerVersion(serverDirectory) {
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(path.join(serverDirectory, "package.json"), "utf8"));
  } catch {
    throw new Error("server/package.json is not valid JSON");
  }
  if (metadata?.name !== "@pihub/server" || !VERSION_PATTERN.test(metadata.version)) {
    throw new Error("Server package identity or version is invalid");
  }
  return metadata.version;
}

function containsPrivateUserDirectory(value) {
  const normalized = value.replaceAll("\\", "/");
  return /\/(?:Users|home)\/[^/]+(?:\/|$)/i.test(normalized);
}

function resolvePortableBuildRoot(options = {}) {
  if (options.buildRoot) return path.resolve(options.buildRoot);
  const configured = process.env.PIHUB_PORTABLE_BUILD_ROOT?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === "win32") {
    return path.join(path.parse(process.cwd()).root, BUILD_DIRECTORY_NAME);
  }
  return path.join(path.parse(process.cwd()).root, "tmp", BUILD_DIRECTORY_NAME);
}

function assertPortableBuildRoot(buildRoot) {
  if (!path.isAbsolute(buildRoot) || /[\0\r\n]/.test(buildRoot) || containsPrivateUserDirectory(buildRoot)) {
    throw new Error("Portable Server build root must be absolute and must not contain a private user directory");
  }
  const filesystemRoot = path.parse(buildRoot).root;
  if (path.resolve(buildRoot) === path.resolve(filesystemRoot)) {
    throw new Error("Portable Server build root must not be a filesystem root");
  }
}

function copySourceTree(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (sourcePath) => {
      const metadata = fs.lstatSync(sourcePath);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new Error("Portable Server source tree contains a link or special filesystem entry");
      }
      const relative = path.relative(source, sourcePath);
      if (!relative) return true;
      return !SOURCE_EXCLUSIONS.has(relative.split(path.sep)[0]);
    },
  });
}

function assertNoPrivateBuildInputs(serverDirectory) {
  for (const entry of fs.readdirSync(serverDirectory, { withFileTypes: true })) {
    if (entry.name.startsWith(".env") && entry.name !== ".env.example") {
      throw new Error("Portable Server build refuses private .env inputs");
    }
  }
}

function copyDependencyTree(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    mode: fs.constants.COPYFILE_FICLONE,
  });
}

export function createPortableBuildEnvironment(buildRoot, {
  execPath = process.execPath,
  platform = process.platform,
  sourceEnvironment = process.env,
} = {}) {
  const home = path.join(buildRoot, "home");
  const temporary = path.join(buildRoot, "tmp");
  const environment = {
    CI: "1",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: "production",
    NO_COLOR: "1",
    PATH: platform === "win32"
      ? [path.dirname(execPath), path.join(sourceEnvironment.SystemRoot ?? sourceEnvironment.WINDIR ?? "C:\\Windows", "System32")].join(path.delimiter)
      : [path.dirname(execPath), "/usr/bin", "/bin"].join(path.delimiter),
    SOURCE_DATE_EPOCH: "0",
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    TZ: "UTC",
    XDG_CACHE_HOME: path.join(buildRoot, "cache"),
    XDG_CONFIG_HOME: path.join(buildRoot, "config"),
  };
  if (platform === "win32") {
    const systemRoot = sourceEnvironment.SystemRoot ?? sourceEnvironment.WINDIR ?? "C:\\Windows";
    environment.ComSpec = path.join(systemRoot, "System32", "cmd.exe");
    environment.PATHEXT = sourceEnvironment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    environment.SystemRoot = systemRoot;
    environment.WINDIR = systemRoot;
  }
  return environment;
}

function runNextBuild(serverDirectory, options = {}) {
  const nextCli = path.join(serverDirectory, "node_modules", "next", "dist", "bin", "next");
  if (!fs.statSync(nextCli, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Server dependencies are missing; run npm install in server first");
  }
  const buildRoot = path.dirname(serverDirectory);
  const environment = createPortableBuildEnvironment(buildRoot);
  for (const directory of [environment.HOME, environment.TMPDIR, environment.XDG_CACHE_HOME, environment.XDG_CONFIG_HOME]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const result = spawnSync(process.execPath, [nextCli, "build", "--webpack"], {
    cwd: serverDirectory,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (options.forwardOutput !== false) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "next build failed").slice(0, 16_384);
    throw new Error(`Portable Server build failed: ${detail}`);
  }
}

function publishBuild(sourceNextDirectory, destinationNextDirectory) {
  const parent = path.dirname(destinationNextDirectory);
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 });
  const candidate = fs.mkdtempSync(path.join(parent, ".next-portable-"));
  const backup = path.join(parent, `.next-backup-${process.pid}`);
  let backedUp = false;
  try {
    fs.cpSync(sourceNextDirectory, candidate, { recursive: true, verbatimSymlinks: true });
    if (fs.lstatSync(backup, { throwIfNoEntry: false })) throw new Error("Portable Server build backup path already exists");
    if (fs.lstatSync(destinationNextDirectory, { throwIfNoEntry: false })) {
      fs.renameSync(destinationNextDirectory, backup);
      backedUp = true;
    }
    fs.renameSync(candidate, destinationNextDirectory);
    if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(candidate, { recursive: true, force: true });
    if (backedUp && !fs.lstatSync(destinationNextDirectory, { throwIfNoEntry: false })) {
      fs.renameSync(backup, destinationNextDirectory);
    }
    throw error;
  }
}

export async function buildPortableServer(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const sourceServerDirectory = path.join(root, "server");
  const version = readServerVersion(sourceServerDirectory);
  const buildRoot = resolvePortableBuildRoot(options);
  assertPortableBuildRoot(buildRoot);
  assertNoPrivateBuildInputs(sourceServerDirectory);

  try {
    fs.mkdirSync(buildRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Portable Server build root already exists: ${buildRoot}`);
    throw error;
  }

  try {
    const buildRootInfo = fs.lstatSync(buildRoot);
    if (!buildRootInfo.isDirectory() || buildRootInfo.isSymbolicLink()) {
      throw new Error("Portable Server build root is not a trusted directory");
    }
    const stagingServerDirectory = path.join(buildRoot, "server");
    copySourceTree(sourceServerDirectory, stagingServerDirectory);
    copyDependencyTree(path.join(sourceServerDirectory, "node_modules"), path.join(stagingServerDirectory, "node_modules"));
    runNextBuild(stagingServerDirectory, options);
    const pruning = pruneServerBuildMetadata(stagingServerDirectory);
    const stagedNextDirectory = path.join(stagingServerDirectory, ".next");
    const normalization = normalizePortableNextBuildPaths(stagingServerDirectory, [
      stagingServerDirectory,
      fs.realpathSync.native(stagingServerDirectory),
      buildRoot,
      fs.realpathSync.native(buildRoot),
    ]);
    assertTreeDoesNotContainPaths(stagedNextDirectory, [
      sourceServerDirectory,
      fs.realpathSync.native(sourceServerDirectory),
      path.dirname(sourceServerDirectory),
      stagingServerDirectory,
      fs.realpathSync.native(stagingServerDirectory),
      buildRoot,
      fs.realpathSync.native(buildRoot),
    ], { limits: { maxFileBytes: 128 * 1024 * 1024 } });
    const scan = await scanServerStagingTree(stagedNextDirectory, {
      limits: { maxFileBytes: 128 * 1024 * 1024 },
    });
    if (scan.findings.length > 0) {
      throw new Error(`Portable Server build failed privacy review (${scan.findings[0].rule})`);
    }
    const buildId = fs.readFileSync(path.join(stagingServerDirectory, ".next", "BUILD_ID"), "utf8").trim();
    if (buildId !== `pihub-${version}`) throw new Error("Portable Server build ID is not deterministic");

    const output = path.join(sourceServerDirectory, ".next");
    if (options.publish !== false) publishBuild(stagedNextDirectory, output);
    return { buildId, buildRoot, normalization, output, pruning, scan, stagingServerDirectory, version };
  } finally {
    if (options.keepBuildRoot !== true) fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}

async function main() {
  const result = await buildPortableServer();
  console.log(`Portable Server build prepared (${result.buildId}; ${result.scan.inspection.files.length} files privacy-scanned)`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
