#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

import { scanArchiveContent, scanPaths, scanTextContent } from "./privacy-scan.mjs";
import {
  isAuditedServerStagingArchiveFinding,
  isAuditedServerStagingPrivacyFinding,
} from "./server-resource-privacy.mjs";
import { verifyServerReleaseSbom } from "./server-release-sbom.mjs";
import {
  createDefaultExtensionNotices,
  DEFAULT_EXTENSION_HOST_PI_PACKAGES,
  DEFAULT_EXTENSION_NOTICE_FILE,
  DEFAULT_EXTENSION_PACKAGES,
  isAuditedDefaultExtensionPrivacyFinding,
  verifyDefaultExtensionBundle,
} from "./default-extension-bundle.mjs";

const root = path.resolve(import.meta.dirname, "..");
const serverDirectory = path.join(root, "server");
const require = createRequire(import.meta.url);
const tar = require(require.resolve("tar", { paths: [serverDirectory] }));

export const SERVER_RELEASE_SCAN_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 50_000,
  maxExpandedBytes: 2048 * 1024 * 1024,
  maxMemberBytes: 128 * 1024 * 1024,
  maxNestedArchiveBytes: 16 * 1024 * 1024,
  maxPathBytes: 1_024,
  maxPathDepth: 32,
  maxCompressionRatio: 100,
  maxTotalFileBytes: 2048 * 1024 * 1024,
});

const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;
const WINDOWS_INVALID_PATH_CHARACTERS = /[<>:"|?*]/;
const CONTROL_CHARACTERS = /\p{Cc}/u;
const CONTENT_OVERLAP_BYTES = 1_024;
const MAX_FINDINGS = 100;
const SEMANTIC_CAPTURE_FILES = new Set([
  "package.json",
  DEFAULT_EXTENSION_NOTICE_FILE,
  ...DEFAULT_EXTENSION_HOST_PI_PACKAGES.map((name) => `node_modules/${name}/package.json`),
]);

function shouldCaptureSemanticFile(relative) {
  return relative.startsWith("extensions/") || SEMANTIC_CAPTURE_FILES.has(relative);
}

function normalizedLimits(overrides = {}) {
  const limits = { ...SERVER_RELEASE_SCAN_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid Server release scan limit: ${name}`);
  }
  if (limits.maxMemberBytes > limits.maxTotalFileBytes || limits.maxNestedArchiveBytes > limits.maxMemberBytes) {
    throw new Error("Invalid Server release scan limit relationship");
  }
  return limits;
}

function normalizedRelative(value) {
  return value.split(path.sep).join("/");
}

function assertPortablePath(value, limits) {
  if (
    typeof value !== "string"
    || !value
    || value.normalize("NFC") !== value
    || CONTROL_CHARACTERS.test(value)
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)
    || Buffer.byteLength(value, "utf8") > limits.maxPathBytes
  ) {
    throw new Error("Server release contains an unsafe archive path");
  }
  const candidate = value.endsWith("/") ? value.replace(/\/+$/, "") : value;
  const segments = candidate.split("/");
  if (
    !candidate
    || segments.length > limits.maxPathDepth
    || segments.some((segment) => (
      !segment
      || segment === "."
      || segment === ".."
      || segment.normalize("NFC") !== segment
      || Buffer.byteLength(segment, "utf8") > 255
      || WINDOWS_INVALID_PATH_CHARACTERS.test(segment)
      || /[. ]$/.test(segment)
      || WINDOWS_RESERVED_STEM.test(segment.split(".", 1)[0])
    ))
  ) {
    throw new Error("Server release contains a non-portable archive path");
  }
  return candidate;
}

function regularFileInfo(filename, description) {
  const metadata = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`${description} must be a regular, unlinked file`);
  }
  return metadata;
}

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = fs.createReadStream(filename);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function createServerStagingInventory(stagingDirectory, options = {}) {
  const directory = path.resolve(stagingDirectory);
  const limits = normalizedLimits(options.limits);
  const rootInfo = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Server release staging directory is invalid");
  }
  const files = [];
  let totalBytes = 0;
  const visit = (current, relative) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const metadata = fs.lstatSync(child);
      if (metadata.isSymbolicLink()) throw new Error("Server release staging contains a symbolic link");
      if (metadata.isDirectory()) visit(child, childRelative);
      else if (metadata.isFile() && metadata.nlink === 1) {
        const portablePath = assertPortablePath(normalizedRelative(childRelative), limits);
        if (metadata.size > limits.maxMemberBytes) throw new Error("Server release staging contains an oversized file");
        totalBytes += metadata.size;
        if (totalBytes > limits.maxTotalFileBytes) throw new Error("Server release staging exceeds its expanded-size limit");
        files.push({ path: portablePath, size: metadata.size, source: child });
        if (files.length > limits.maxEntries) throw new Error("Server release staging contains too many files");
      } else {
        throw new Error("Server release staging contains a hard link or special entry");
      }
    }
  };
  visit(directory, "");
  if (files.length === 0) throw new Error("Server release staging is empty");
  const inventory = [];
  for (const file of files) {
    inventory.push({ path: file.path, size: file.size, sha256: await sha256File(file.source) });
  }
  return { files: inventory, totalBytes };
}

function isNestedArchive(filename) {
  const lower = filename.toLowerCase();
  return lower.endsWith(".tgz") || lower.endsWith(".tar.gz") || lower.endsWith(".zip");
}

function scanChunk(chunk, carry, location, findings) {
  const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
  for (const finding of scanTextContent(combined.toString("latin1"), { path: location })) {
    const key = `${finding.rule}|${finding.path}`;
    if (!findings.has(key) && findings.size < MAX_FINDINGS) findings.set(key, finding);
  }
  return combined.subarray(Math.max(0, combined.length - CONTENT_OVERLAP_BYTES));
}

function compareInventories(actual, expected) {
  const expectedFiles = Array.isArray(expected?.files) ? expected.files : expected;
  if (!Array.isArray(expectedFiles)) return;
  const normalize = (files) => files
    .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const left = normalize(actual);
  const right = normalize(expectedFiles);
  if (left.length !== right.length) throw new Error("Server release archive does not match the staging inventory");
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].path !== right[index].path
      || left[index].size !== right[index].size
      || left[index].sha256 !== right[index].sha256
    ) {
      throw new Error("Server release archive does not match the staging inventory");
    }
  }
}

async function scanServerReleaseArchive(archivePath, options, semanticRoot) {
  const archive = path.resolve(archivePath);
  const limits = normalizedLimits(options.limits);
  const archiveInfo = regularFileInfo(archive, "Server release archive");
  if (archiveInfo.size <= 0 || archiveInfo.size > limits.maxArchiveBytes) {
    throw new Error("Server release archive exceeds its compressed-size limit");
  }

  const inventory = [];
  const portablePaths = new Set();
  const findings = new Map();
  const captureHandles = new Set();
  let entryCount = 0;
  let expandedBytes = 0;
  let totalFileBytes = 0;
  let failure;

  const fail = (error) => {
    if (!failure) failure = error instanceof Error ? error : new Error(String(error));
  };
  const parser = new tar.Parser({
    strict: true,
    onReadEntry: (entry) => {
      entryCount += 1;
      if (entryCount > limits.maxEntries) fail(new Error("Server release archive contains too many entries"));
      const kind = entry.type === "File" || entry.type === "OldFile" || entry.type === "ContiguousFile"
        ? "file"
        : entry.type === "Directory" ? "directory" : "unsupported";
      let entryPath;
      try {
        entryPath = assertPortablePath(entry.path, limits);
      } catch (error) {
        fail(error);
        entryPath = `<invalid-entry-${entryCount}>`;
      }
      const portableKey = entryPath.toLowerCase();
      if (portablePaths.has(portableKey)) fail(new Error("Server release archive contains colliding paths"));
      portablePaths.add(portableKey);
      if (kind !== "file") {
        fail(new Error("Server release archive must contain only regular files"));
        entry.resume();
        return;
      }
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxMemberBytes) {
        fail(new Error("Server release archive contains an oversized or invalid member"));
      }
      totalFileBytes += entry.size;
      if (!Number.isSafeInteger(totalFileBytes) || totalFileBytes > limits.maxTotalFileBytes) {
        fail(new Error("Server release archive exceeds its expanded file-size limit"));
      }

      const nameFindings = scanTextContent(entryPath, { path: `archive!${entryPath}` });
      for (const finding of nameFindings) findings.set(`${finding.rule}|${finding.path}`, finding);
      const hash = createHash("sha256");
      const nested = isNestedArchive(entryPath);
      const nestedChunks = [];
      let memberBytes = 0;
      let carry = Buffer.alloc(0);
      let captureFile;
      const closeCapture = () => {
        if (captureFile === undefined) return;
        try {
          fs.closeSync(captureFile);
        } catch (error) {
          fail(error);
        }
        captureHandles.delete(captureFile);
        captureFile = undefined;
      };
      if (shouldCaptureSemanticFile(entryPath)) {
        try {
          const destination = path.join(semanticRoot, ...entryPath.split("/"));
          fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
          captureFile = fs.openSync(destination, "wx", 0o600);
          captureHandles.add(captureFile);
        } catch (error) {
          fail(error);
        }
      }
      entry.on("data", (chunk) => {
        memberBytes += chunk.length;
        hash.update(chunk);
        carry = scanChunk(chunk, carry, `archive!${entryPath}`, findings);
        if (nested && memberBytes <= limits.maxNestedArchiveBytes) nestedChunks.push(Buffer.from(chunk));
        if (captureFile !== undefined) {
          try {
            if (fs.writeSync(captureFile, chunk) !== chunk.length) {
              throw new Error("Server release semantic capture was incomplete");
            }
          } catch (error) {
            fail(error);
            closeCapture();
          }
        }
      });
      entry.on("end", () => {
        closeCapture();
        if (memberBytes !== entry.size) fail(new Error("Server release archive member size changed while reading"));
        if (nested) {
          if (memberBytes > limits.maxNestedArchiveBytes) {
            fail(new Error("Server release contains an oversized nested archive"));
          } else {
            const nestedResult = scanArchiveContent(Buffer.concat(nestedChunks), {
              name: entryPath,
              path: `archive!${entryPath}`,
              limits: {
                maxArchiveDepth: 2,
                maxArchiveEntries: 2_000,
                maxArchiveExpandedBytes: 64 * 1024 * 1024,
                maxArchiveMemberBytes: 8 * 1024 * 1024,
                maxArchiveScanBytes: 64 * 1024 * 1024,
              },
            });
            for (const finding of nestedResult.findings) {
              findings.set(`${finding.rule}|${finding.path}`, finding);
            }
          }
        }
        inventory.push({ path: entryPath, size: memberBytes, sha256: hash.digest("hex") });
      });
      entry.on("error", (error) => {
        closeCapture();
        fail(error);
      });
    },
  });
  const expandedLimiter = new Transform({
    transform(chunk, _encoding, callback) {
      expandedBytes += chunk.length;
      if (expandedBytes > limits.maxExpandedBytes) {
        callback(new Error("Server release archive exceeds its streamed expansion limit"));
      } else {
        callback(null, chunk);
      }
    },
  });

  try {
    await pipeline(fs.createReadStream(archive), createGunzip(), expandedLimiter, parser);
  } catch (error) {
    throw new Error(`Server release archive could not be scanned safely: ${error instanceof Error ? error.message : "invalid archive"}`);
  } finally {
    for (const descriptor of captureHandles) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The primary parser/capture failure is reported below.
      }
    }
    captureHandles.clear();
  }
  if (failure) throw failure;
  if (inventory.length === 0 || inventory.length !== entryCount) {
    throw new Error("Server release archive inventory is incomplete");
  }
  if (totalFileBytes / archiveInfo.size > limits.maxCompressionRatio) {
    throw new Error("Server release archive exceeds its compression-ratio limit");
  }
  const archiveSha256ByPath = new Map(inventory.map((entry) => [entry.path, entry.sha256]));
  const unreviewedPrivacyFindings = [...findings.values()].filter(
    (finding) => !isAuditedDefaultExtensionPrivacyFinding(
      path.join(semanticRoot, "extensions"),
      finding,
    ) && !isAuditedServerStagingPrivacyFinding(semanticRoot, finding)
      && !isAuditedServerStagingArchiveFinding(
        finding,
        archiveSha256ByPath.get(finding.path.replace(/^archive!/, "")),
      ),
  );
  if (unreviewedPrivacyFindings.length > 0) {
    const [finding] = unreviewedPrivacyFindings;
    throw new Error(`Server release privacy scan failed (${finding.rule} at ${finding.path})`);
  }
  compareInventories(inventory, options.expectedInventory);
  inventory.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const serverManifest = readJson(path.join(semanticRoot, "package.json"), "Captured Server package manifest");
  const extensionVerification = await verifyDefaultExtensionBundle(
    path.join(semanticRoot, "extensions"),
    { expectedVersion: serverManifest.version, serverRoot: semanticRoot },
  );
  const noticePath = path.join(semanticRoot, DEFAULT_EXTENSION_NOTICE_FILE);
  regularFileInfo(noticePath, "Default extension notices");
  if (fs.readFileSync(noticePath, "utf8") !== createDefaultExtensionNotices(extensionVerification)) {
    throw new Error("Default extension notices do not match the physical extension packages");
  }
  return {
    archiveBytes: archiveInfo.size,
    entries: entryCount,
    expandedBytes,
    files: inventory,
    extensions: {
      inventorySha256: await sha256File(path.join(semanticRoot, "extensions", "inventory.json")),
      lockSha256: await sha256File(path.join(semanticRoot, "extensions", "package-lock.json")),
      packages: DEFAULT_EXTENSION_PACKAGES.map(({ name, version }) => ({ name, version })),
    },
    totalFileBytes,
  };
}

export async function verifyServerReleaseArchive(archivePath, options = {}) {
  const semanticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-server-release-verify-"));
  fs.chmodSync(semanticRoot, 0o700);
  try {
    return await scanServerReleaseArchive(archivePath, options, semanticRoot);
  } finally {
    fs.rmSync(semanticRoot, { recursive: true, force: true });
  }
}

function readJson(filename, description) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    throw new Error(`${description} is not valid JSON`);
  }
}

function safeAssetName(value, description) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._+-]+$/.test(value) || path.basename(value) !== value) {
    throw new Error(`${description} has an unsafe filename`);
  }
  return value;
}

export async function verifyServerReleaseDirectory(releaseDirectory, options = {}) {
  const directory = path.resolve(releaseDirectory);
  const directoryInfo = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("Server release directory is invalid");
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Server release directory contains a non-regular entry");
  }
  const metadataNames = entries.map((entry) => entry.name).filter((name) => name.endsWith(".asset.json"));
  if (metadataNames.length !== 1) throw new Error("Server release directory must contain one asset manifest");
  const metadataPath = path.join(directory, metadataNames[0]);
  const metadata = readJson(metadataPath, "Server asset manifest");
  if (
    metadata?.schemaVersion !== 1
    || typeof metadata.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version)
    || !new Set(["darwin", "linux", "win32"]).has(metadata.platform)
    || !new Set(["arm64", "x64"]).has(metadata.arch)
    || !/^[a-f0-9]{64}$/.test(metadata.sha256)
    || !/^[a-f0-9]{64}$/.test(metadata.sbomSha256)
    || !Number.isSafeInteger(metadata.size)
    || metadata.size <= 0
  ) {
    throw new Error("Server asset manifest is invalid");
  }
  const baseName = `pihub-server-${metadata.version}-${metadata.platform}-${metadata.arch}`;
  if (metadataNames[0] !== `${baseName}.asset.json`) {
    throw new Error("Server asset manifest filename is inconsistent");
  }
  const archiveName = safeAssetName(metadata.filename, "Server archive");
  const sbomName = safeAssetName(metadata.sbom, "Server SBOM");
  if (archiveName !== `${baseName}.tar.gz` || sbomName !== `${baseName}.cdx.json`) {
    throw new Error("Server asset filenames are inconsistent");
  }
  const checksumName = `${archiveName}.sha256`;
  const expectedNames = [metadataNames[0], archiveName, sbomName, checksumName].sort();
  const actualNames = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Server release directory contains an incomplete or unexpected asset set");
  }

  const archivePath = path.join(directory, archiveName);
  const sbomPath = path.join(directory, sbomName);
  if (regularFileInfo(archivePath, "Server archive").size !== metadata.size) {
    throw new Error("Server archive size does not match its asset manifest");
  }
  const [archiveSha256, sbomSha256] = await Promise.all([sha256File(archivePath), sha256File(sbomPath)]);
  if (archiveSha256 !== metadata.sha256 || sbomSha256 !== metadata.sbomSha256) {
    throw new Error("Server release hash does not match its asset manifest");
  }
  const checksum = fs.readFileSync(path.join(directory, checksumName), "utf8");
  if (checksum !== `${archiveSha256}  ${archiveName}\n`) {
    throw new Error("Server archive checksum file is inconsistent");
  }
  const archive = await verifyServerReleaseArchive(archivePath, options);
  const sbom = readJson(sbomPath, "Server SBOM");
  verifyServerReleaseSbom(sbom, {
    arch: metadata.arch,
    archiveInventory: archive.files,
    archiveName,
    archiveSha256,
    archiveSize: metadata.size,
    packageName: "@pihub/server",
    platform: metadata.platform,
    version: metadata.version,
  });
  const privacy = await scanPaths([metadataPath, sbomPath, path.join(directory, checksumName)], {
    root: directory,
  });
  if (privacy.findings.length > 0) {
    throw new Error(`Server release metadata failed privacy review (${privacy.findings[0].rule})`);
  }
  return { archive, metadata, privacy };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.at(-1) === "--json";
  if (json) args.pop();
  let result;
  if (args.length === 2 && args[0] === "--directory") {
    result = (await verifyServerReleaseDirectory(args[1])).archive;
  } else if (args.length === 1) {
    result = await verifyServerReleaseArchive(args[0]);
  } else {
    throw new Error("Usage: node scripts/verify-server-release.mjs [--directory] <path> [--json]");
  }
  const summary = {
    archiveBytes: result.archiveBytes,
    entries: result.entries,
    expandedBytes: result.expandedBytes,
    totalFileBytes: result.totalFileBytes,
  };
  console.log(json ? JSON.stringify(summary) : `Verified Server release archive (${result.entries} files)`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Server release verification failed");
    process.exitCode = 1;
  });
}
