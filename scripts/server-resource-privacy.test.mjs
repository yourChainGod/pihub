import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { scanTextContent } from "./privacy-scan.mjs";
import {
  assertTreeDoesNotContainPaths,
  normalizePortableNextBuildPaths,
  pruneServerBuildMetadata,
  pruneServerDependencyTree,
  scanServerStagingTree,
  stripWasmCustomSections,
} from "./server-resource-privacy.mjs";

const require = createRequire(import.meta.url);
const { minify_sync: minifySync } = require(require.resolve("next/dist/compiled/terser", {
  paths: [path.resolve(import.meta.dirname, "..", "server")],
}));
const { parse: parseJavaScript } = require(require.resolve("next/dist/compiled/acorn", {
  paths: [path.resolve(import.meta.dirname, "..", "server")],
}));

async function temporaryDirectory(t, prefix = "pihub-server-resource-") {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function pathExists(filename) {
  return stat(filename).then(() => true, () => false);
}

function wasmCustomSection(name, payload) {
  const nameBuffer = Buffer.from(name);
  const payloadBuffer = Buffer.from(payload);
  const bodyLength = 1 + nameBuffer.length + payloadBuffer.length;
  assert.ok(nameBuffer.length < 128 && bodyLength < 128);
  return Buffer.concat([
    Buffer.from([0, bodyLength, nameBuffer.length]),
    nameBuffer,
    payloadBuffer,
  ]);
}

function wasmSection(id, payload) {
  const payloadBuffer = Buffer.from(payload);
  assert.ok(payloadBuffer.length < 128);
  return Buffer.concat([Buffer.from([id, payloadBuffer.length]), payloadBuffer]);
}

function wasmFixture(privatePath) {
  const windowsPrivatePath = ["C:", "Users", ["private", "builder"].join("-"), "photon", "src", "lib.rs"].join("\\");
  const data = Buffer.from(`${privatePath}\0${windowsPrivatePath}`);
  return Buffer.concat([
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    wasmCustomSection("name", privatePath),
    wasmCustomSection("producers", "rustc fixture"),
    wasmSection(5, Buffer.from([1, 0, 1])),
    wasmSection(11, Buffer.concat([
      Buffer.from([1, 0, 0x41, 0, 0x0b, data.length]),
      data,
    ])),
    wasmCustomSection("keep", "runtime metadata"),
  ]);
}

test("Next build pruning removes only non-runtime metadata", async (t) => {
  const root = await temporaryDirectory(t);
  const nextDirectory = path.join(root, ".next");
  const privateUser = ["private", "builder"].join("-");
  const unixRoot = ["", "Users", privateUser, "work", "pihub", "server"].join("/");
  const windowsRoot = ["C:", "Users", privateUser, "work", "pihub", "server"].join("\\");
  await mkdir(path.join(nextDirectory, "server"), { recursive: true });
  await mkdir(path.join(nextDirectory, "types"), { recursive: true });
  await mkdir(path.join(nextDirectory, "cache"), { recursive: true });
  await mkdir(path.join(nextDirectory, "diagnostics"), { recursive: true });
  await writeFile(path.join(nextDirectory, "BUILD_ID"), "fixture-build\n");
  await writeFile(path.join(nextDirectory, "trace"), unixRoot);
  await writeFile(path.join(nextDirectory, "trace-build"), windowsRoot);
  await writeFile(path.join(nextDirectory, "types", "validator.ts"), unixRoot);
  await writeFile(path.join(nextDirectory, "cache", "index.pack"), windowsRoot);
  await writeFile(path.join(nextDirectory, "diagnostics", "build.json"), unixRoot);
  const runtimeText = JSON.stringify({ unix: `${unixRoot}/app/api/health/route.ts`, windows: `${windowsRoot}\\app\\api\\health\\route.ts` });
  await writeFile(path.join(nextDirectory, "server", "route.json"), runtimeText);
  await writeFile(path.join(nextDirectory, "server", "route.js.map"), unixRoot);

  const originalFindings = scanTextContent(`${unixRoot}\n${windowsRoot}`, { path: "fixture" });
  assert.equal(originalFindings.filter((finding) => finding.rule === "absolute-user-path").length, 2);
  const result = pruneServerBuildMetadata(root);
  assert.equal(await readFile(path.join(nextDirectory, "server", "route.json"), "utf8"), runtimeText);
  assert.equal(result.sourceMaps, 1);
  for (const omitted of ["trace", "trace-build", "types", "cache", "diagnostics"]) {
    assert.equal(await pathExists(path.join(nextDirectory, omitted)), false, omitted);
  }
  assert.equal(await pathExists(path.join(nextDirectory, "server", "route.js.map")), false);
});

test("portable path normalization rewrites only structured JSON and JavaScript string literals", async (t) => {
  const root = await temporaryDirectory(t);
  const buildRoot = path.join(path.parse(root).root, "neutral-build", "server");
  const windowsBuildRoot = "Q:\\neutral-build\\server";
  const nextDirectory = path.join(root, ".next");
  const routeDirectory = path.join(nextDirectory, "server", "app", "api", "health");
  await mkdir(routeDirectory, { recursive: true });
  await writeFile(path.join(nextDirectory, "required-server-files.json"), JSON.stringify({
    version: 1,
    config: { outputFileTracingRoot: buildRoot, repoRoot: buildRoot },
    appDir: buildRoot,
    files: [],
    ignore: [],
  }));
  const routeFile = path.join(routeDirectory, "route.js");
  await writeFile(
    routeFile,
    `const route={resolvedPagePath:${JSON.stringify(path.join(buildRoot, "app", "api", "health", "route.ts"))},windows:${JSON.stringify(`${windowsBuildRoot}\\app\\api\\health\\route.ts`)}};\n`,
  );
  const manifestFile = path.join(routeDirectory, "route_client-reference-manifest.js");
  await writeFile(
    manifestFile,
    `globalThis.manifest={entryCSSFiles:{${JSON.stringify(path.join(buildRoot, "app", "api", "health", "route"))}:[]}};\n`,
  );

  const result = normalizePortableNextBuildPaths(root, [buildRoot, windowsBuildRoot], { parse: parseJavaScript });

  assert.deepEqual(result, { rewrittenJavaScriptFiles: 2, rewrittenLiterals: 3 });
  const required = JSON.parse(await readFile(path.join(nextDirectory, "required-server-files.json"), "utf8"));
  assert.equal(required.config.outputFileTracingRoot, ".");
  assert.equal(required.config.repoRoot, ".");
  assert.equal(required.appDir, ".");
  assert.equal((await readFile(routeFile, "utf8")).includes('"./app/api/health/route.ts"'), true);
  assert.equal((await readFile(routeFile, "utf8")).includes(windowsBuildRoot), false);
  assert.equal((await readFile(manifestFile, "utf8")).includes('"./app/api/health/route"'), true);
  assertTreeDoesNotContainPaths(nextDirectory, [buildRoot]);
});

test("portable path normalization rejects build roots outside recognized generated literals", async (t) => {
  const root = await temporaryDirectory(t);
  const buildRoot = path.join(path.parse(root).root, "neutral-build", "server");
  const nextDirectory = path.join(root, ".next");
  await mkdir(nextDirectory, { recursive: true });
  await writeFile(path.join(nextDirectory, "required-server-files.json"), JSON.stringify({ files: [], ignore: [] }));
  await writeFile(path.join(nextDirectory, "unexpected.js"), `// ${buildRoot}\nmodule.exports = 1;\n`);

  assert.throws(
    () => normalizePortableNextBuildPaths(root, [buildRoot], { parse: parseJavaScript }),
    /outside a recognized string literal/,
  );
});

test("dependency pruning and staging scan cover every remaining regular file", async (t) => {
  const root = await temporaryDirectory(t);
  const dependencies = path.join(root, "node_modules");
  const privateUser = ["private", "builder"].join("-");
  const privateHome = ["", "Users", privateUser].join("/");
  const linuxHome = ["", "home", privateUser].join("/");
  await mkdir(path.join(dependencies, ".bin"), { recursive: true });
  await mkdir(path.join(dependencies, "runtime"), { recursive: true });
  await mkdir(path.join(dependencies, "runtime", "docs"), { recursive: true });
  await mkdir(path.join(dependencies, "runtime", "examples"), { recursive: true });
  await mkdir(path.join(dependencies, "runtime", "tests"), { recursive: true });
  await mkdir(path.join(dependencies, "runtime", "dist", "doc"), { recursive: true });
  await mkdir(path.join(dependencies, "next", "dist", "server"), { recursive: true });
  await writeFile(path.join(dependencies, ".bin", "tool"), "binary shim");
  await writeFile(path.join(dependencies, "runtime", "index.js"), "module.exports = 1;\n");
  await writeFile(path.join(dependencies, "runtime", "changelog.js"), "module.exports = 'runtime changelog helper';\n");
  await writeFile(path.join(dependencies, "runtime", "index.js.map"), "source map");
  await writeFile(path.join(dependencies, "runtime", "index.d.ts"), "declaration");
  await writeFile(path.join(dependencies, "runtime", "state.tsbuildinfo"), "metadata");
  await writeFile(path.join(dependencies, "runtime", "CHANGELOG.md"), `${privateHome}/work\n`);
  await writeFile(path.join(dependencies, "runtime", ".jekyll-metadata"), `${privateHome}/site\n`);
  await writeFile(path.join(dependencies, "runtime", "native.rs"), `${linuxHome}/src\n`);
  await writeFile(path.join(dependencies, "runtime", "docs", "guide.md"), `${privateHome}/docs\n`);
  await writeFile(path.join(dependencies, "runtime", "examples", "demo.js"), `${privateHome}/demo\n`);
  await writeFile(path.join(dependencies, "runtime", "tests", "jwt.txt"), "fixture only\n");
  await writeFile(path.join(dependencies, "runtime", "dist", "doc", "directives.js"), "module.exports = 'runtime doc module';\n");
  const privatePath = `${privateHome}/photon/src/lib.rs`;
  await writeFile(path.join(dependencies, "runtime", "module.wasm"), wasmFixture(privatePath));
  const nextRuntime = path.join(dependencies, "next", "dist", "server", "patch-error-inspect.js");
  await writeFile(nextRuntime, `// e.g. ${privatePath}\nmodule.exports = function runtime() { return 1; };\n`);

  const pruning = pruneServerDependencyTree(dependencies, { minifySync });
  assert.equal(pruning.removedBins, 1);
  assert.equal(pruning.removedDirectories, 3);
  assert.equal(pruning.removedFiles, 9);
  assert.equal(pruning.removedWasmSections, 2);
  assert.equal(pruning.redactedWasmDataPaths, 2);
  assert.equal(pruning.rewrittenJavaScriptFiles, 1);
  assert.equal((await readFile(nextRuntime, "utf8")).includes(privatePath), false);
  const wasm = await readFile(path.join(dependencies, "runtime", "module.wasm"));
  assert.equal(WebAssembly.validate(wasm), true);
  const module = new WebAssembly.Module(wasm);
  assert.equal(WebAssembly.Module.customSections(module, "name").length, 0);
  assert.equal(WebAssembly.Module.customSections(module, "producers").length, 0);
  assert.equal(WebAssembly.Module.customSections(module, "keep").length, 1);
  const scanned = await scanServerStagingTree(root);
  assert.deepEqual(scanned.findings, []);
  assert.deepEqual(scanned.inspection.files, [
    "node_modules/next/dist/server/patch-error-inspect.js",
    "node_modules/runtime/changelog.js",
    "node_modules/runtime/dist/doc/directives.js",
    "node_modules/runtime/index.js",
    "node_modules/runtime/module.wasm",
  ]);
  assert.equal(scanned.stats.files, 5);
});

test("WASM pruning rejects malformed input and preserves non-debug custom sections", () => {
  const privatePath = ["", "Users", ["private", "builder"].join("-"), "source", "lib.rs"].join("/");
  const original = wasmFixture(privatePath);
  const result = stripWasmCustomSections(original);
  assert.equal(result.removedSections, 2);
  assert.equal(result.redactedDataPaths, 2);
  assert.equal(result.buffer.includes(Buffer.from(privatePath)), false);
  assert.equal(result.buffer.includes(Buffer.from("runtime metadata")), true);
  assert.equal(WebAssembly.validate(result.buffer), true);
  assert.throws(() => stripWasmCustomSections(Buffer.from("not-wasm")), /unsupported header/);
  const truncated = Buffer.concat([original, Buffer.from([0, 128])]);
  assert.throws(() => stripWasmCustomSections(truncated), /valid module|truncated/);
});

test("source-root assertion does not allow known CI placeholder usernames", async (t) => {
  const root = await temporaryDirectory(t);
  const runnerRoot = ["", "home", "runner", "work", "pihub", "server"].join("/");
  await writeFile(path.join(root, "chunk.js"), `module.exports = ${JSON.stringify(`${runnerRoot}/app/page.tsx`)};\n`);
  assert.throws(
    () => assertTreeDoesNotContainPaths(root, [runnerRoot]),
    /forbidden build path/,
  );
});
