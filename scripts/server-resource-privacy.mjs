import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { scanPaths, scanTextContent } from "./privacy-scan.mjs";

export const SERVER_BUILD_OMISSIONS = Object.freeze([
  ".next/cache",
  ".next/dev",
  ".next/diagnostics",
  ".next/trace",
  ".next/trace-build",
  ".next/types",
]);

const DEFAULT_TREE_LIMITS = Object.freeze({
  maxFiles: 100_000,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
});

const NON_RUNTIME_DIRECTORY_NAMES = new Set([
  "__tests__",
  "benchmark",
  "benchmarks",
  "doc",
  "docs",
  "example",
  "examples",
  "next-devtools",
  "test",
  "tests",
]);

const COMMENT_ONLY_PRIVATE_PATH_FILES = new Set([
  "next/dist/esm/server/patch-error-inspect.js",
  "next/dist/esm/shared/lib/page-path/absolute-path-to-page.js",
  "next/dist/server/patch-error-inspect.js",
  "next/dist/shared/lib/page-path/absolute-path-to-page.js",
]);

const REMOVABLE_WASM_CUSTOM_SECTIONS = new Set([
  "name",
  "producers",
]);

const require = createRequire(import.meta.url);

function normalizeRelative(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function isPathAtOrBelow(relativePath, prefix) {
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

function removeRegularFile(filename) {
  const metadata = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!metadata) return false;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Refusing to prune a non-regular file: ${filename}`);
  }
  fs.unlinkSync(filename);
  return true;
}

function walkTree(directory, visitor, pruneEmptyDirectories = false) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Server staging tree contains a symbolic link: ${absolutePath}`);
    if (entry.isDirectory()) {
      walkTree(absolutePath, visitor, pruneEmptyDirectories);
      if (pruneEmptyDirectories && fs.readdirSync(absolutePath).length === 0) fs.rmdirSync(absolutePath);
    } else if (entry.isFile()) {
      visitor(absolutePath);
    } else {
      throw new Error(`Server staging tree contains an unsupported filesystem entry: ${absolutePath}`);
    }
  }
}

export function pruneServerBuildMetadata(serverDirectory) {
  const root = path.resolve(serverDirectory);
  for (const relativePath of SERVER_BUILD_OMISSIONS) {
    const target = path.join(root, ...relativePath.split("/"));
    const metadata = fs.lstatSync(target, { throwIfNoEntry: false });
    if (metadata?.isSymbolicLink()) throw new Error(`Server build metadata is a symbolic link: ${relativePath}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  let sourceMaps = 0;
  const nextDirectory = path.join(root, ".next");
  if (fs.statSync(nextDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    walkTree(nextDirectory, (filename) => {
      if (filename.endsWith(".map") && removeRegularFile(filename)) sourceMaps += 1;
    }, true);
  }
  if (!fs.statSync(path.join(nextDirectory, "BUILD_ID"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Pruned Server build is missing .next/BUILD_ID");
  }
  return { sourceMaps };
}

function normalizedBuildRoots(buildPaths) {
  const roots = [];
  for (const value of buildPaths) {
    if (typeof value !== "string"
        || (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value))
        || /[\0\r\n]/.test(value)) {
      throw new Error("Portable Server build path normalization received an invalid root");
    }
    const normalized = value.replace(/[\\/]+$/, "");
    for (const variant of [normalized, normalized.replaceAll("\\", "/")]) {
      if (variant && !roots.includes(variant)) roots.push(variant);
    }
  }
  return roots.sort((left, right) => right.length - left.length);
}

function portableBuildPath(value, roots) {
  if (typeof value !== "string") return value;
  const comparableValue = /^[A-Za-z]:[\\/]/.test(value) ? value.toLowerCase() : value;
  for (const root of roots) {
    const comparableRoot = /^[A-Za-z]:[\\/]/.test(root) ? root.toLowerCase() : root;
    if (comparableValue === comparableRoot) return ".";
    const separator = value[root.length];
    if (comparableValue.startsWith(comparableRoot) && (separator === "/" || separator === "\\")) {
      return `./${value.slice(root.length + 1).replaceAll("\\", "/")}`;
    }
  }
  return value;
}

function normalizeJsonBuildPaths(value, roots) {
  if (typeof value === "string") return portableBuildPath(value, roots);
  if (Array.isArray(value)) return value.map((entry) => normalizeJsonBuildPaths(entry, roots));
  if (!value || typeof value !== "object") return value;
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = portableBuildPath(key, roots);
    if (Object.hasOwn(normalized, normalizedKey)) {
      throw new Error("Portable Server JSON path normalization produced a duplicate key");
    }
    normalized[normalizedKey] = normalizeJsonBuildPaths(entry, roots);
  }
  return normalized;
}

function defaultJavaScriptParser(serverDirectory) {
  const parserPath = path.join(serverDirectory, "node_modules", "next", "dist", "compiled", "acorn");
  let parser;
  try {
    parser = require(parserPath);
  } catch {
    throw new Error("Portable Server build is missing the pinned Next JavaScript parser");
  }
  if (typeof parser?.parse !== "function") {
    throw new Error("Pinned Next JavaScript parser does not expose parse");
  }
  return parser.parse;
}

function stringLiteralReplacements(source, parse, roots, relativePath) {
  let ast;
  try {
    ast = parse(source, {
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
      ecmaVersion: "latest",
      sourceType: "script",
    });
  } catch {
    throw new Error(`Generated Server JavaScript could not be parsed: ${relativePath}`);
  }
  const replacements = [];
  const stack = [ast];
  const seen = new Set();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (node.type === "Literal" && typeof node.value === "string"
        && Number.isSafeInteger(node.start) && Number.isSafeInteger(node.end)) {
      const normalized = portableBuildPath(node.value, roots);
      if (normalized !== node.value) replacements.push({ start: node.start, end: node.end, value: normalized });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value === "object") stack.push(value);
    }
  }
  let output = source;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${JSON.stringify(replacement.value)}${output.slice(replacement.end)}`;
  }
  try {
    parse(output, {
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
      ecmaVersion: "latest",
      sourceType: "script",
    });
  } catch {
    throw new Error(`Normalized Server JavaScript is invalid: ${relativePath}`);
  }
  return { output, replacements: replacements.length };
}

export function normalizePortableNextBuildPaths(serverDirectory, buildPaths, options = {}) {
  const serverRoot = path.resolve(serverDirectory);
  const nextRoot = path.join(serverRoot, ".next");
  const roots = normalizedBuildRoots(buildPaths);
  const requiredFiles = path.join(nextRoot, "required-server-files.json");
  const requiredInfo = fs.lstatSync(requiredFiles, { throwIfNoEntry: false });
  if (!requiredInfo?.isFile() || requiredInfo.isSymbolicLink() || requiredInfo.size > 4 * 1024 * 1024) {
    throw new Error("Portable Server build is missing valid required-server-files.json metadata");
  }
  let required;
  try {
    required = JSON.parse(fs.readFileSync(requiredFiles, "utf8"));
  } catch {
    throw new Error("Portable Server required-server-files.json is invalid");
  }
  fs.writeFileSync(requiredFiles, `${JSON.stringify(normalizeJsonBuildPaths(required, roots), null, 2)}\n`, "utf8");

  const parse = options.parse ?? defaultJavaScriptParser(serverRoot);
  const encodedRoots = [...new Set(roots.flatMap((root) => [...forbiddenPathVariants(root)]))];
  let rewrittenJavaScriptFiles = 0;
  let rewrittenLiterals = 0;
  walkTree(nextRoot, (filename) => {
    if (!filename.endsWith(".js")) return;
    const info = fs.statSync(filename);
    if (info.size > 128 * 1024 * 1024) throw new Error("Generated Server JavaScript exceeds the normalization limit");
    const source = fs.readFileSync(filename, "utf8");
    if (!encodedRoots.some((root) => source.includes(root))) return;
    const relativePath = normalizeRelative(path.relative(nextRoot, filename));
    const normalized = stringLiteralReplacements(source, parse, roots, relativePath);
    if (normalized.replacements === 0 || encodedRoots.some((root) => normalized.output.includes(root))) {
      if (process.env.PIHUB_PRIVACY_DEBUG === "1") {
        const hit = encodedRoots.find((root) => normalized.output.includes(root));
        const at = hit ? normalized.output.indexOf(hit) : -1;
        console.error(`[privacy-debug] ${relativePath} @${at}: ${JSON.stringify(normalized.output.slice(Math.max(0, at - 160), at + 160))}`);
      }
      throw new Error(`Generated Server JavaScript contains a build path outside a recognized string literal: ${relativePath}`);
    }
    fs.writeFileSync(filename, normalized.output, "utf8");
    rewrittenJavaScriptFiles += 1;
    rewrittenLiterals += normalized.replacements;
  });
  assertTreeDoesNotContainPaths(nextRoot, roots, {
    limits: { maxFileBytes: 128 * 1024 * 1024 },
  });
  return { rewrittenJavaScriptFiles, rewrittenLiterals };
}

function isDeclarationFile(filename) {
  return filename.endsWith(".d.ts") || filename.endsWith(".d.mts") || filename.endsWith(".d.cts");
}

function readVarUint32(buffer, offset, limit) {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 5; index += 1) {
    if (offset >= limit) throw new Error("WASM section contains a truncated unsigned LEB128 value");
    const byte = buffer[offset];
    offset += 1;
    if (index === 4 && (byte & 0xf0) !== 0) throw new Error("WASM section length exceeds uint32");
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return { offset, value };
    shift += 7;
  }
  throw new Error("WASM section contains an invalid unsigned LEB128 value");
}

function redactWasmDataPaths(payload) {
  const output = Buffer.from(payload);
  let replacements = 0;
  let spanStart = -1;
  const redactSpan = (start, end) => {
    if (start < 0 || end - start < 8) return;
    const original = output.subarray(start, end).toString("ascii");
    const redacted = original
      .replace(/\/Users\/([A-Za-z0-9._& -]{1,64})(?=\/)/g, (_match, username) => {
        replacements += 1;
        return `/build/${"x".repeat(username.length)}`;
      })
      .replace(/\/home\/([A-Za-z0-9._& -]{1,64})(?=\/)/g, (_match, username) => {
        replacements += 1;
        return `/work/${"x".repeat(username.length)}`;
      })
      .replace(/([A-Za-z]):([\\/]+)Users([\\/]+)([^\\/\r\n]{1,64})(?=[\\/])/gi,
        (_match, drive, beforeUsers, afterUsers, username) => {
          replacements += 1;
          return `${drive}:${beforeUsers}Build${afterUsers}${"x".repeat(username.length)}`;
      });
    if (redacted.length !== original.length) throw new Error("WASM build-path redaction changed a data segment length");
    output.write(redacted, start, redacted.length, "ascii");
  };

  for (let index = 0; index <= output.length; index += 1) {
    const byte = output[index];
    const printable = index < output.length && byte >= 0x20 && byte <= 0x7e;
    if (printable && spanStart < 0) spanStart = index;
    if (!printable && spanStart >= 0) {
      redactSpan(spanStart, index);
      spanStart = -1;
    }
  }
  return { buffer: output, replacements };
}

export function stripWasmCustomSections(input, removableSections = REMOVABLE_WASM_CUSTOM_SECTIONS) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
    throw new Error("Dependency WASM file has an unsupported header");
  }
  if (!WebAssembly.validate(buffer)) throw new Error("Dependency WASM file is not a valid module");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks = [buffer.subarray(0, 8)];
  let cursor = 8;
  let redactedDataPaths = 0;
  let removedSections = 0;
  while (cursor < buffer.length) {
    const sectionStart = cursor;
    const sectionId = buffer[cursor];
    cursor += 1;
    const sectionLength = readVarUint32(buffer, cursor, buffer.length);
    const payloadStart = sectionLength.offset;
    const payloadEnd = payloadStart + sectionLength.value;
    if (payloadEnd > buffer.length) throw new Error("Dependency WASM file contains a truncated section");

    let remove = false;
    if (sectionId === 0) {
      const nameLength = readVarUint32(buffer, payloadStart, payloadEnd);
      const nameEnd = nameLength.offset + nameLength.value;
      if (nameEnd > payloadEnd) throw new Error("Dependency WASM custom section has a truncated name");
      let sectionName;
      try {
        sectionName = decoder.decode(buffer.subarray(nameLength.offset, nameEnd));
      } catch {
        throw new Error("Dependency WASM custom section name is not valid UTF-8");
      }
      remove = removableSections.has(sectionName);
    }

    if (remove) {
      removedSections += 1;
    } else if (sectionId === 11) {
      const redacted = redactWasmDataPaths(buffer.subarray(payloadStart, payloadEnd));
      redactedDataPaths += redacted.replacements;
      chunks.push(buffer.subarray(sectionStart, payloadStart), redacted.buffer);
    } else {
      chunks.push(buffer.subarray(sectionStart, payloadEnd));
    }
    cursor = payloadEnd;
  }

  if (removedSections === 0 && redactedDataPaths === 0) return { buffer, redactedDataPaths, removedSections };
  const stripped = Buffer.concat(chunks);
  if (!WebAssembly.validate(stripped)) throw new Error("Pruned dependency WASM file is not a valid module");
  return { buffer: stripped, redactedDataPaths, removedSections };
}

export function stripJavaScriptComments(source, options = {}) {
  if (typeof options.minifySync !== "function") throw new Error("A JavaScript AST minifier is required");
  const result = options.minifySync(String(source), {
    compress: false,
    mangle: false,
    module: options.module === true,
    sourceMap: false,
    format: {
      comments: false,
    },
  });
  if (result?.error) throw result.error;
  if (typeof result?.code !== "string" || result.code.length === 0) {
    throw new Error("JavaScript AST minifier returned empty output");
  }
  return `${result.code}\n`;
}

function shouldPruneDependencyFile(name) {
  return name === ".jekyll-metadata"
    || /^(?:changelog|changes)(?:\.(?:adoc|md|markdown|rst|txt))?$/i.test(name)
    || name.endsWith(".rs")
    || name.endsWith(".map")
    || name.endsWith(".tsbuildinfo")
    || isDeclarationFile(name);
}

function inspectDirectoryBeforeRemoval(directory) {
  let files = 0;
  const visit = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Server dependency tree contains a symbolic link: ${child}`);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files += 1;
      else throw new Error(`Server dependency tree contains an unsupported entry: ${child}`);
    }
  };
  visit(directory);
  return files;
}

function dependencyMinifier(root) {
  const minifierPath = path.join(root, "next", "dist", "compiled", "terser");
  let minifier;
  try {
    minifier = require(minifierPath);
  } catch {
    throw new Error("Server dependency tree is missing the pinned Next JavaScript minifier");
  }
  if (typeof minifier?.minify_sync !== "function") {
    throw new Error("Pinned Next JavaScript minifier does not expose minify_sync");
  }
  return minifier.minify_sync;
}

export function pruneServerDependencyTree(nodeModulesDirectory, options = {}) {
  const root = path.resolve(nodeModulesDirectory);
  const metadata = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Server dependency tree is missing or invalid");
  }
  let removedBins = 0;
  let removedDirectories = 0;
  let removedFiles = 0;
  let removedWasmSections = 0;
  let redactedWasmDataPaths = 0;
  let rewrittenJavaScriptFiles = 0;
  let minifySync = options.minifySync;
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.name === ".bin") {
        fs.rmSync(child, { recursive: true, force: true });
        removedBins += 1;
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error(`Server dependency tree contains a symbolic link: ${child}`);
      if (entry.isDirectory()) {
        const directoryName = entry.name.toLowerCase();
        const runtimeDistributionDoc = directoryName === "doc"
          && path.basename(directory).toLowerCase() === "dist";
        if (NON_RUNTIME_DIRECTORY_NAMES.has(directoryName) && !runtimeDistributionDoc) {
          removedFiles += inspectDirectoryBeforeRemoval(child);
          fs.rmSync(child, { recursive: true, force: true });
          removedDirectories += 1;
          continue;
        }
        visit(child);
        if (fs.readdirSync(child).length === 0) fs.rmdirSync(child);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Server dependency tree contains an unsupported entry: ${child}`);
      const relativePath = normalizeRelative(path.relative(root, child));
      if (shouldPruneDependencyFile(entry.name)) {
        fs.unlinkSync(child);
        removedFiles += 1;
      } else if (entry.name.endsWith(".wasm")) {
        const original = fs.readFileSync(child);
        const stripped = stripWasmCustomSections(original);
        if (stripped.removedSections > 0 || stripped.redactedDataPaths > 0) {
          fs.writeFileSync(child, stripped.buffer);
          removedWasmSections += stripped.removedSections;
          redactedWasmDataPaths += stripped.redactedDataPaths;
        }
      } else if (COMMENT_ONLY_PRIVATE_PATH_FILES.has(relativePath)) {
        const source = fs.readFileSync(child, "utf8");
        const originalFindings = scanTextContent(source, { path: relativePath })
          .filter((finding) => finding.rule === "absolute-user-path");
        if (originalFindings.length > 0) {
          minifySync ??= dependencyMinifier(root);
          const output = stripJavaScriptComments(source, {
            minifySync,
            module: relativePath.includes("/dist/esm/"),
          });
          const remainingFindings = scanTextContent(output, { path: relativePath })
            .filter((finding) => finding.rule === "absolute-user-path");
          if (remainingFindings.length > 0) {
            throw new Error(`Dependency JavaScript contains a non-comment private path: ${relativePath}`);
          }
          fs.writeFileSync(child, output, "utf8");
          rewrittenJavaScriptFiles += 1;
        }
      }
    }
  };
  visit(root);
  return {
    removedBins,
    removedDirectories,
    removedFiles,
    removedWasmSections,
    redactedWasmDataPaths,
    rewrittenJavaScriptFiles,
  };
}

/**
 * Remove native/binary payload that can never run on the target platform.
 *
 * The staged tree comes from `npm ci --omit=peer` inside
 * stageDefaultExtensionBundle, which materializes every optional platform
 * variant. Rules (extension tree, rooted at the directory containing
 * node_modules):
 *
 * - onnxruntime-web: browser-only backend, never loaded under Node.
 * - onnxruntime-node/bin/napi-v6/<platform>/<arch>: keep only the target.
 * - @img/sharp*: keep only the target variant (glibc build for linux);
 *   @huggingface/transformers imports sharp at module load, so the target
 *   package itself must stay loadable.
 * - @ff-labs/fff-bin-*: keep only the target variant (glibc for linux).
 */
export function pruneExtensionPlatformModules(extensionsRoot, { platform, arch }) {
  const root = path.resolve(extensionsRoot);
  const removed = [];
  const removeIfPresent = (relative) => {
    const target = path.join(root, ...relative.split("/"));
    const info = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Refusing to prune a symlink: ${relative}`);
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(relative);
  };
  const keepUnder = (relative, keep) => {
    const target = path.join(root, ...relative.split("/"));
    const info = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (!keep(entry.name)) removeIfPresent(`${relative}/${entry.name}`);
    }
  };

  removeIfPresent("node_modules/onnxruntime-web");
  keepUnder("node_modules/onnxruntime-node/bin/napi-v6", (name) => name === platform);
  keepUnder(`node_modules/onnxruntime-node/bin/napi-v6/${platform}`, (name) => name === arch);
  const imgKeep = targetImgPackageNames(platform, arch);
  keepUnder("node_modules/@img", (name) => imgKeep.has(name));
  const fffKeep = `fff-bin-${platform}-${arch}${platform === "linux" ? "-gnu" : ""}`;
  keepUnder("node_modules/@ff-labs", (name) => !name.startsWith("fff-bin-") || name === fffKeep);
  return removed;
}

/**
 * Server runtime tree pruning: @next/swc-* is the build-time compiler and is
 * never loaded by `next start`; @img/sharp serves next/image, which the
 * headless device server does not use — the whole @img scope goes.
 */
export function pruneServerRuntimePlatformModules(stageDirectory, { platform, arch }) {
  const root = path.resolve(stageDirectory);
  const removed = [];
  const removeIfPresent = (relative) => {
    const target = path.join(root, ...relative.split("/"));
    const info = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Refusing to prune a symlink: ${relative}`);
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(relative);
  };
  const keepUnder = (relative, keep) => {
    const target = path.join(root, ...relative.split("/"));
    const info = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (!keep(entry.name)) removeIfPresent(`${relative}/${entry.name}`);
    }
  };

  keepUnder("node_modules/@next", (name) => !name.startsWith("swc-"));
  const imgKeep = targetImgPackageNames(platform, arch);
  keepUnder("node_modules/@img", (name) => imgKeep.has(name));
  return removed;
}

function targetImgPackageNames(platform, arch) {
  if (platform === "linux") {
    return new Set([`sharp-linux-${arch}`, `sharp-libvips-linux-${arch}`]);
  }
  if (platform === "darwin") {
    return new Set([`sharp-darwin-${arch}`, `sharp-libvips-darwin-${arch}`]);
  }
  return new Set([`sharp-win32-${arch}`]);
}

export function inspectServerStagingTree(stagingDirectory, options = {}) {
  const root = path.resolve(stagingDirectory);
  const limits = { ...DEFAULT_TREE_LIMITS, ...(options.limits ?? {}) };
  const files = [];
  let totalBytes = 0;
  walkTree(root, (filename) => {
    if (files.length >= limits.maxFiles) throw new Error("Server staging tree exceeds the file-count limit");
    const metadata = fs.statSync(filename);
    if (metadata.size > limits.maxFileBytes) throw new Error("Server staging tree contains a file above the per-file limit");
    if (totalBytes + metadata.size > limits.maxTotalBytes) throw new Error("Server staging tree exceeds the total-byte limit");
    totalBytes += metadata.size;
    files.push(normalizeRelative(path.relative(root, filename)));
  });
  if (files.length === 0) throw new Error("Server staging tree is empty");
  return { files, totalBytes };
}

export async function scanServerStagingTree(stagingDirectory, options = {}) {
  const root = path.resolve(stagingDirectory);
  const inspection = inspectServerStagingTree(root, options);
  const result = await scanPaths(inspection.files.map((filename) => path.join(root, ...filename.split("/"))), {
    root,
    limits: {
      largeFileBytes: options.scanLimits?.largeFileBytes ?? options.limits?.maxFileBytes ?? DEFAULT_TREE_LIMITS.maxFileBytes,
      maxFileBytes: options.scanLimits?.maxFileBytes ?? options.limits?.maxFileBytes ?? DEFAULT_TREE_LIMITS.maxFileBytes,
      ...options.scanLimits,
    },
  });
  return { ...result, inspection };
}

// Upstream win32 native binaries embed their CI build-machine paths (the
// swc/node-pty/clipboard native modules have no linux counterpart in the
// staged tree). Same audit contract as the extension bundle's
// AUDITED_PRIVACY_FINDINGS: pinned by sha256, build paths only, no user data.
const AUDITED_SERVER_STAGING_PRIVACY_FINDINGS = new Map([
  [
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "2b75a71676a9054323a223c7853570fa44bf73a701d6c3160219ec0971052fd5",
    }),
  ],
  [
    "node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty.pdb",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "9275fecdca50f646579134e44604ba0ce81b184cea8edfc7c9fa53e59b475013",
    }),
  ],
  [
    "node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty_console_list.pdb",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "eedbd0fb50293fff4532465ac6e7d765c0d543923ae11e6b1a05b5ae55fe3476",
    }),
  ],
  [
    "node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node",
    Object.freeze({
      rules: new Set(["absolute-user-path"]),
      sha256: "1589d4ef2398a4076f34cd03bf59bc7c164e6b03b1badbca27e3dbf111208555",
    }),
  ],
]);

function auditedServerStagingFinding(relative, rule) {
  if (relative.startsWith("extensions/")) return undefined;
  const audited = AUDITED_SERVER_STAGING_PRIVACY_FINDINGS.get(relative);
  return audited?.rules.has(rule) ? audited : undefined;
}

export function isAuditedServerStagingPrivacyFinding(stagingDirectory, finding) {
  if (!finding || typeof finding.path !== "string" || typeof finding.rule !== "string") return false;
  const relative = finding.path.replace(/^archive!/, "");
  const audited = auditedServerStagingFinding(relative, finding.rule);
  if (!audited) return false;
  const filename = path.join(stagingDirectory, ...relative.split("/"));
  const info = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) return false;
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex") === audited.sha256;
}

// Archive-level scans do not materialize every member on disk; the streamed
// member hash takes the place of the on-disk re-hash.
export function isAuditedServerStagingArchiveFinding(finding, streamedSha256) {
  if (!finding || typeof finding.path !== "string" || typeof finding.rule !== "string") return false;
  const relative = finding.path.replace(/^archive!/, "");
  const audited = auditedServerStagingFinding(relative, finding.rule);
  return Boolean(audited) && streamedSha256 === audited.sha256;
}

function forbiddenPathVariants(value) {
  const normalized = String(value).replace(/[\\/]+$/, "");
  return new Set([
    normalized,
    normalized.replaceAll("\\", "/"),
    normalized.replaceAll("/", "\\"),
    normalized.replaceAll("\\", "\\\\"),
    normalized.replaceAll("/", "\\/"),
  ].filter(Boolean));
}

export function assertTreeDoesNotContainPaths(stagingDirectory, forbiddenPaths, options = {}) {
  const root = path.resolve(stagingDirectory);
  const inspection = inspectServerStagingTree(root, options);
  const needles = [...new Set(forbiddenPaths.flatMap((value) => [...forbiddenPathVariants(value)]))]
    .map((value) => Buffer.from(value));
  for (const relativePath of inspection.files) {
    const filename = path.join(root, ...relativePath.split("/"));
    const buffer = fs.readFileSync(filename);
    if (needles.some((needle) => needle.length > 0 && buffer.includes(needle))) {
      throw new Error(`Server staging tree contains a forbidden build path in ${relativePath}`);
    }
  }
  return inspection;
}

function shouldCopyServerPath(sourceServerDirectory, sourcePath) {
  const relativePath = normalizeRelative(path.relative(sourceServerDirectory, sourcePath));
  if (!relativePath || relativePath === ".") return true;
  if ([".git", "node_modules"].some((prefix) => isPathAtOrBelow(relativePath, prefix))) return false;
  if (SERVER_BUILD_OMISSIONS.some((prefix) => isPathAtOrBelow(relativePath, prefix))) return false;
  if (relativePath.startsWith(".next/") && relativePath.endsWith(".map")) return false;
  return true;
}

export function stageServerDirectory(sourceServerDirectory, stagingServerDirectory) {
  const source = path.resolve(sourceServerDirectory);
  const destination = path.resolve(stagingServerDirectory);
  if (!fs.statSync(path.join(source, ".next", "BUILD_ID"), { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Server production build is missing; run npm run server:build first");
  }
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
    throw new Error("Server staging directory already exists");
  }
  fs.cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (sourcePath) => shouldCopyServerPath(source, sourcePath),
  });
  return { destination, pruning: pruneServerBuildMetadata(destination) };
}
