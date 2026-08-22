import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import {
  isAuditedServerStagingPrivacyFinding,
  pruneServerRuntimePlatformModules,
  pruneServerDependencyTree,
  scanServerStagingTree,
} from "./server-resource-privacy.mjs";
import {
  createServerStagingInventory,
  verifyServerReleaseArchive,
} from "./verify-server-release.mjs";
import { normalizeServerReleaseSbom } from "./server-release-sbom.mjs";
import {
  assertExtensionBuildToolchain,
  DEFAULT_EXTENSION_NOTICE_FILE,
  DEFAULT_EXTENSION_PACKAGES,
  isAuditedDefaultExtensionPrivacyFinding,
  stageDefaultExtensionBundle,
} from "./default-extension-bundle.mjs";
import { npmSpawnInvocation, prepareSecureNpmEnvironment } from "./secure-npm-environment.mjs";

const root = path.resolve(import.meta.dirname, "..");
const serverDirectory = path.join(root, "server");
const require = createRequire(import.meta.url);
const tar = require(require.resolve("tar", { paths: [serverDirectory] }));

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function runNpm(args, cwd, maxBuffer = 64 * 1024 * 1024) {
  const prepared = prepareSecureNpmEnvironment("pihub-server-npm-");
  try {
    const invocation = npmSpawnInvocation(args);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd,
      encoding: "utf8",
      env: prepared.environment,
      maxBuffer,
      windowsHide: true,
    });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "npm failed").slice(0, 16_384);
      throw new Error(`npm ${args[0]} failed: ${detail}`);
    }
    return result.stdout;
  } finally {
    prepared.cleanup();
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}


function platformName() {
  if (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") {
    return process.platform;
  }
  throw new Error(`Unsupported Server release platform: ${process.platform}`);
}

function architectureName() {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch;
  throw new Error(`Unsupported Server release architecture: ${process.arch}`);
}

function collectRegularFiles(directory) {
  const files = [];
  const visit = (current, relative) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      const info = fs.lstatSync(child);
      if (info.isSymbolicLink()) throw new Error(`Server release contains a symbolic link: ${childRelative}`);
      if (info.isDirectory()) {
        visit(child, childRelative);
      } else if (info.isFile() && info.nlink === 1) {
        files.push(childRelative);
      } else {
        throw new Error(`Server release contains an unsupported filesystem entry: ${childRelative}`);
      }
    }
  };
  visit(directory, "");
  if (files.length === 0) throw new Error("Server release staging directory is empty");
  return files;
}

const platform = platformName();
const arch = architectureName();
const expectedPlatform = argument("--platform", platform);
const expectedArch = argument("--arch", arch);
if (expectedPlatform !== platform || expectedArch !== arch) {
  throw new Error(`Runner identity mismatch: expected ${expectedPlatform}/${expectedArch}, got ${platform}/${arch}`);
}

const outputDirectory = path.resolve(argument("--output", path.join(root, "release-artifacts")));
const serverPackage = JSON.parse(fs.readFileSync(path.join(serverDirectory, "package.json"), "utf8"));
const version = serverPackage.version;
if (serverPackage.name !== "@pihub/server" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Server package identity or version is invalid");
}
const piAgentVersion = serverPackage.dependencies?.["@earendil-works/pi-coding-agent"];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(piAgentVersion ?? "")) {
  throw new Error("Server release requires a pinned @earendil-works/pi-coding-agent version");
}
if (!fs.statSync(path.join(serverDirectory, ".next", "BUILD_ID"), { throwIfNoEntry: false })?.isFile()) {
  throw new Error("Server production build is missing; run npm run server:build first");
}
assertExtensionBuildToolchain();

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-server-release-"));
try {
  const packDirectory = path.join(temporaryDirectory, "pack");
  const stageDirectory = path.join(temporaryDirectory, "stage");
  fs.mkdirSync(packDirectory, { mode: 0o700 });
  fs.mkdirSync(stageDirectory, { mode: 0o700 });

  const packOutput = runNpm([
    "pack",
    serverDirectory,
    "--pack-destination",
    packDirectory,
    "--ignore-scripts",
    "--json",
  ], packDirectory);
  let packResult;
  try {
    packResult = JSON.parse(packOutput);
  } catch {
    throw new Error("npm pack returned invalid JSON");
  }
  if (!Array.isArray(packResult) || packResult.length !== 1 || typeof packResult[0]?.filename !== "string") {
    throw new Error("npm pack returned an unexpected result");
  }

  const npmArchive = path.join(packDirectory, packResult[0].filename);
  await tar.extract({
    file: npmArchive,
    cwd: stageDirectory,
    strip: 1,
    strict: true,
    preservePaths: false,
  });
  fs.copyFileSync(path.join(serverDirectory, "package-lock.json"), path.join(stageDirectory, "package-lock.json"));
  runNpm([
    "ci",
    "--omit=dev",
    "--include=optional",
    "--ignore-scripts",
    "--engine-strict=true",
    "--no-bin-links",
    "--legacy-peer-deps=false",
    "--force=false",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org/",
  ], stageDirectory, 128 * 1024 * 1024);

  const dependencyPruning = pruneServerDependencyTree(path.join(stageDirectory, "node_modules"));
  for (const requiredFile of [
    "package.json",
    ".next/BUILD_ID",
    "node_modules/next/package.json",
    "node_modules/next/dist/bin/next",
  ]) {
    if (!fs.statSync(path.join(stageDirectory, ...requiredFile.split("/")), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Runnable Server release is missing ${requiredFile}`);
    }
  }

  const stagedPackage = JSON.parse(fs.readFileSync(path.join(stageDirectory, "package.json"), "utf8"));
  if (stagedPackage.name !== serverPackage.name || stagedPackage.version !== version) {
    throw new Error("Runnable Server release package identity changed during staging");
  }

  const extensionBundle = await stageDefaultExtensionBundle({
    destinationDirectory: path.join(stageDirectory, "extensions"),
    expectedVersion: version,
    serverRoot: stageDirectory,
    platform,
    arch,
  });
  fs.writeFileSync(
    path.join(stageDirectory, DEFAULT_EXTENSION_NOTICE_FILE),
    extensionBundle.notices,
    { encoding: "utf8", flag: "wx", mode: 0o644 },
  );

  // The staged server tree contains every platform's optional native binaries;
  // a release archive runs on exactly one platform/arch.
  const platformPruning = pruneServerRuntimePlatformModules(stageDirectory, { platform, arch });

  const stagingScan = await scanServerStagingTree(stageDirectory, {
    limits: {
      maxFiles: 50_000,
      maxFileBytes: 128 * 1024 * 1024,
      // The pinned extension tree includes onnxruntime + sharp native deps
      // (~500MB); the scan limit bounds review work, not package size.
      maxTotalBytes: 2048 * 1024 * 1024,
    },
  });
  const unreviewedPrivacyFindings = stagingScan.findings.filter(
    (finding) => !isAuditedDefaultExtensionPrivacyFinding(
      path.join(stageDirectory, "extensions"),
      finding,
    ) && !isAuditedServerStagingPrivacyFinding(stageDirectory, finding),
  );
  if (unreviewedPrivacyFindings.length > 0) {
    const finding = unreviewedPrivacyFindings[0];
    throw new Error(`Server release staging failed privacy review (${finding.rule} at ${finding.path})`);
  }
  const stagingInventory = await createServerStagingInventory(stageDirectory);
  const regularFiles = collectRegularFiles(stageDirectory);
  if (
    regularFiles.length !== stagingInventory.files.length
    || regularFiles.some((filename, index) => filename !== stagingInventory.files[index]?.path)
  ) {
    throw new Error("Server release staging inventory changed before archiving");
  }
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  const baseName = `pihub-server-${version}-${platform}-${arch}`;
  const archiveName = `${baseName}.tar.gz`;
  const archive = path.join(outputDirectory, archiveName);
  await tar.create({
    file: archive,
    cwd: stageDirectory,
    gzip: { level: 9 },
    portable: true,
    noMtime: true,
    noDirRecurse: true,
    strict: true,
  }, regularFiles);

  const archiveInfo = fs.lstatSync(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size <= 0) {
    throw new Error("Server release archive is not a non-empty regular file");
  }
  const archiveVerification = await verifyServerReleaseArchive(archive, {
    expectedInventory: stagingInventory,
  });
  const archiveSha256 = await sha256File(archive);

  // Self-hosted local builds set PIHUB_LOCAL_BUILD=1: the intentional peer
  // range exception for pi-magic-context makes `npm sbom` fail with
  // ESBOMPROBLEMS, and local installs never consume the SBOM.
  const skipSbom = process.env.PIHUB_LOCAL_BUILD === "1";
  let sbomName = null;
  let sbomSha256 = null;
  if (!skipSbom) {
    sbomName = `${baseName}.cdx.json`;
    const sbom = path.join(outputDirectory, sbomName);
    const serverSbomText = runNpm([
      "sbom",
      "--omit=dev",
      "--package-lock-only",
      "--sbom-format=cyclonedx",
      "--sbom-type=application",
    ], stageDirectory, 128 * 1024 * 1024);
    const extensionSbomText = runNpm([
      "sbom",
      "--omit=dev",
      "--omit=peer",
      "--package-lock-only",
      "--sbom-format=cyclonedx",
      "--sbom-type=application",
    ], path.join(stageDirectory, "extensions"), 128 * 1024 * 1024);
    const sbomDocument = normalizeServerReleaseSbom(
      JSON.parse(serverSbomText),
      JSON.parse(extensionSbomText),
      {
      arch,
      archiveName,
      archiveSha256,
      archiveSize: archiveInfo.size,
      packageName: serverPackage.name,
      platform,
      stagingDirectory: stageDirectory,
      version,
      },
    );
    fs.writeFileSync(sbom, `${JSON.stringify(sbomDocument, null, 2)}\n`, { mode: 0o644 });
    sbomSha256 = await sha256File(sbom);
  }

  fs.writeFileSync(
    path.join(outputDirectory, `${archiveName}.sha256`),
    `${archiveSha256}  ${archiveName}\n`,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(outputDirectory, `${baseName}.asset.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      version,
      platform,
      arch,
      filename: archiveName,
      sha256: archiveSha256,
      size: archiveInfo.size,
      pi: { name: "@earendil-works/pi-coding-agent", version: piAgentVersion },
      extensions: DEFAULT_EXTENSION_PACKAGES.map((entry) => ({ name: entry.name, version: entry.version })),
      ...(sbomName ? { sbom: sbomName, sbomSha256 } : {}),
    }, null, 2)}\n`,
    { mode: 0o644 },
  );

  console.log(
    `Prepared ${archiveName} (${archiveInfo.size} bytes, ${archiveVerification.entries} files; `
    + `${extensionBundle.physicalPackages} locked extension packages; `
    + `${stagingScan.findings.length - unreviewedPrivacyFindings.length} audited upstream privacy findings; `
    + `${dependencyPruning.removedFiles} non-runtime files and `
    + `${dependencyPruning.removedDirectories} directories pruned; `
    + `${platformPruning.length} non-target native payloads removed; `
    + `${dependencyPruning.removedWasmSections} WASM debug sections removed; `
    + `${dependencyPruning.redactedWasmDataPaths} WASM build paths redacted; `
    + `${dependencyPruning.rewrittenJavaScriptFiles} JavaScript files comment-stripped)`,
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
