import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_EXTENSION_PACKAGES,
  DEFAULT_EXTENSION_RESOURCE_LAYOUT,
  verifyDefaultExtensionBundle,
} from "./default-extension-bundle.mjs";

const root = path.resolve(import.meta.dirname, "..");
const serverDirectory = path.join(root, "server");
const require = createRequire(import.meta.url);
const tar = require(require.resolve("tar", { paths: [serverDirectory] }));
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const HOST_PI_PACKAGE = "@earendil-works/pi-coding-agent";
const HOST_PI_VERSION = "0.84.2";
const EXTENSION_PROBE_MARKER = "PIHUB_DEFAULT_EXTENSION_PROBE=";
const REPRESENTATIVE_EXTENSION_RESOURCES = Object.freeze({
  "@ff-labs/pi-fff": Object.freeze({
    commands: Object.freeze(["fff-mode"]),
    tools: Object.freeze(["ffgrep", "fffind"]),
  }),
  "pi-simplify": Object.freeze({
    commands: Object.freeze(["simplify"]),
    tools: Object.freeze([]),
  }),
  "@gotgenes/pi-permission-system": Object.freeze({
    commands: Object.freeze(["permission-system"]),
    tools: Object.freeze([]),
  }),
  "@eko24ive/pi-ask": Object.freeze({
    commands: Object.freeze(["ask-settings"]),
    tools: Object.freeze(["ask_user"]),
  }),
  "@gotgenes/pi-subagents": Object.freeze({
    commands: Object.freeze(["subagents:settings"]),
    tools: Object.freeze(["subagent", "get_subagent_result", "steer_subagent"]),
  }),
});

function appendBounded(chunks, state, chunk) {
  if (state.bytes >= MAX_PROCESS_OUTPUT_BYTES) return;
  const buffer = Buffer.from(chunk);
  const accepted = buffer.subarray(0, MAX_PROCESS_OUTPUT_BYTES - state.bytes);
  chunks.push(accepted);
  state.bytes += accepted.length;
}

function runRequired(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Smoke setup command failed").slice(0, 8_192));
  }
  return result.stdout;
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function portablePathKey(filename) {
  const resolved = path.resolve(filename);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertDirectory(filename, description) {
  const info = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${description} must be a real directory`);
  }
  return fs.realpathSync.native(filename);
}

function assertRegularFile(filename, description) {
  const info = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error(`${description} must be a non-empty regular file`);
  }
  return fs.realpathSync.native(filename);
}

function assertContainedRealPath(rootRealPath, filename, description) {
  const candidateRealPath = fs.realpathSync.native(filename);
  if (!isPathInside(rootRealPath, candidateRealPath)) {
    throw new Error(`${description} resolves outside the relocated Server`);
  }
  return candidateRealPath;
}

function readPackageMetadata(filename, description) {
  assertRegularFile(filename, description);
  const source = fs.readFileSync(filename, "utf8");
  if (Buffer.byteLength(source) > 256 * 1024) throw new Error(`${description} is too large`);
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${description} is invalid JSON`);
  }
}

export function assertRelocatedDependencyTree(packageRoot) {
  const packageRootRealPath = assertDirectory(packageRoot, "Relocated Server root");
  const dependencies = path.join(packageRoot, "node_modules");
  const dependenciesInfo = fs.lstatSync(dependencies, { throwIfNoEntry: false });
  if (!dependenciesInfo) {
    throw new Error("Relocated Server archive must include its own node_modules; workspace fallback is forbidden");
  }
  const dependenciesRealPath = assertDirectory(dependencies, "Relocated Server dependency tree");
  if (!isPathInside(packageRootRealPath, dependenciesRealPath)) {
    throw new Error("Relocated Server dependency tree resolves outside the archive");
  }

  const nextRuntime = path.join(dependencies, "next", "dist", "bin", "next");
  assertRegularFile(nextRuntime, "Relocated Server Next runtime");
  assertContainedRealPath(dependenciesRealPath, nextRuntime, "Relocated Server Next runtime");

  const piPackageRoot = path.join(dependencies, ...HOST_PI_PACKAGE.split("/"));
  const piPackageRealPath = assertDirectory(piPackageRoot, "Relocated Server Pi package");
  if (!isPathInside(dependenciesRealPath, piPackageRealPath)) {
    throw new Error("Relocated Server Pi package resolves outside the archive");
  }
  const piMetadata = readPackageMetadata(
    path.join(piPackageRoot, "package.json"),
    "Relocated Server Pi package manifest",
  );
  if (piMetadata.name !== HOST_PI_PACKAGE || piMetadata.version !== HOST_PI_VERSION) {
    throw new Error(`Relocated Server must contain ${HOST_PI_PACKAGE}@${HOST_PI_VERSION}`);
  }
  const piEntry = path.join(piPackageRoot, "dist", "index.js");
  assertRegularFile(piEntry, "Relocated Server Pi loader entry");
  assertContainedRealPath(dependenciesRealPath, piEntry, "Relocated Server Pi loader entry");

  return { dependencies, nextRuntime, packageRootRealPath, piEntry };
}

function relocatedExtensionResources(packageRoot) {
  const extensionRoot = path.join(packageRoot, "extensions");
  const extensionRootRealPath = assertDirectory(extensionRoot, "Relocated default extension bundle");
  const extensions = [];
  const skills = [];
  for (const extension of DEFAULT_EXTENSION_PACKAGES) {
    const layout = DEFAULT_EXTENSION_RESOURCE_LAYOUT[extension.name];
    if (!layout || layout.extensions.length !== 1) {
      throw new Error(`Default extension smoke layout is invalid: ${extension.name}`);
    }
    const packageRootPath = path.join(extensionRoot, "node_modules", ...extension.name.split("/"));
    for (const relative of layout.extensions) {
      const resource = path.join(packageRootPath, ...relative.split("/"));
      assertRegularFile(resource, `Default extension entry ${extension.name}/${relative}`);
      assertContainedRealPath(extensionRootRealPath, resource, `Default extension entry ${extension.name}/${relative}`);
      extensions.push({ name: extension.name, path: resource });
    }
    for (const relative of layout.skills ?? []) {
      const resource = path.join(packageRootPath, ...relative.split("/"));
      const resourceRealPath = assertDirectory(resource, `Default extension skill ${extension.name}/${relative}`);
      if (!isPathInside(extensionRootRealPath, resourceRealPath)) {
        throw new Error(`Default extension skill resolves outside the bundle: ${extension.name}/${relative}`);
      }
      skills.push(resource);
    }
  }
  if (extensions.length !== 5 || skills.length !== 1) {
    throw new Error("Default extension smoke must load exactly five entries and one skill root");
  }
  return { extensionRoot, extensions, skills };
}

export async function loadRelocatedPiApi(packageRoot) {
  const { piEntry } = assertRelocatedDependencyTree(packageRoot);
  const piApi = await import(pathToFileURL(piEntry).href);
  if (
    piApi.VERSION !== HOST_PI_VERSION
    || typeof piApi.DefaultResourceLoader !== "function"
    || typeof piApi.SettingsManager?.inMemory !== "function"
  ) {
    throw new Error(`Relocated ${HOST_PI_PACKAGE}@${HOST_PI_VERSION} loader API is invalid`);
  }
  return piApi;
}

function assertRegisteredResources(extension, packageName) {
  const expected = REPRESENTATIVE_EXTENSION_RESOURCES[packageName];
  if (!expected || typeof extension.tools?.has !== "function" || typeof extension.commands?.has !== "function") {
    throw new Error(`Loaded extension API is invalid: ${packageName}`);
  }
  for (const tool of expected.tools) {
    if (!extension.tools.has(tool)) throw new Error(`${packageName} did not register required tool ${tool}`);
  }
  for (const command of expected.commands) {
    if (!extension.commands.has(command)) {
      throw new Error(`${packageName} did not register required command ${command}`);
    }
  }
}

export async function smokeRelocatedDefaultExtensions(packageRoot, {
  expectedVersion,
  loadPiApi = loadRelocatedPiApi,
  verifyBundle = verifyDefaultExtensionBundle,
} = {}) {
  assertRelocatedDependencyTree(packageRoot);
  const resources = relocatedExtensionResources(packageRoot);
  await verifyBundle(resources.extensionRoot, {
    expectedVersion,
    serverRoot: packageRoot,
  });

  const piApi = await loadPiApi(packageRoot);
  const probeWorkspace = process.cwd();
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? path.resolve(process.env.PI_CODING_AGENT_DIR)
    : path.join(probeWorkspace, ".pi-agent");
  const loader = new piApi.DefaultResourceLoader({
    cwd: probeWorkspace,
    agentDir,
    settingsManager: piApi.SettingsManager.inMemory({}, { projectTrusted: false }),
    additionalExtensionPaths: resources.extensions.map((entry) => entry.path),
    additionalSkillPaths: resources.skills,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const extensionResult = loader.getExtensions();
  if (!Array.isArray(extensionResult?.errors) || extensionResult.errors.length !== 0) {
    const detail = extensionResult?.errors?.[0]?.error ?? "unknown loader error";
    throw new Error(`Default extension loader reported an error: ${detail}`);
  }
  if (!Array.isArray(extensionResult.extensions) || extensionResult.extensions.length !== resources.extensions.length) {
    throw new Error("Default extension loader did not return exactly five extensions");
  }
  const expectedByPath = new Map(resources.extensions.map((entry) => [portablePathKey(entry.path), entry]));
  const loadedNames = [];
  const commandNames = new Set();
  const toolNames = new Set();
  for (const loaded of extensionResult.extensions) {
    const resolvedPath = typeof loaded.resolvedPath === "string" ? loaded.resolvedPath : loaded.path;
    if (typeof resolvedPath !== "string") throw new Error("Loaded extension path is invalid");
    const expected = expectedByPath.get(portablePathKey(resolvedPath));
    if (!expected) throw new Error(`Default extension loader returned an unexpected path: ${resolvedPath}`);
    expectedByPath.delete(portablePathKey(resolvedPath));
    assertRegisteredResources(loaded, expected.name);
    loadedNames.push(expected.name);
    for (const name of loaded.commands.keys()) commandNames.add(name);
    for (const name of loaded.tools.keys()) toolNames.add(name);
  }
  if (expectedByPath.size !== 0) throw new Error("Default extension loader omitted a fixed entry");

  const skillResult = loader.getSkills();
  if (!Array.isArray(skillResult?.diagnostics) || skillResult.diagnostics.length !== 0) {
    const detail = skillResult?.diagnostics?.[0]?.message ?? "unknown skill diagnostic";
    throw new Error(`Default extension skill loader reported a diagnostic: ${detail}`);
  }
  if (!Array.isArray(skillResult.skills) || skillResult.skills.length !== 1 || skillResult.skills[0]?.name !== "ask-user") {
    throw new Error("Default extension loader did not load the ask-user skill exactly once");
  }
  const skillFile = assertRegularFile(skillResult.skills[0].filePath, "Loaded ask-user skill");
  const askSkillRoot = fs.realpathSync.native(resources.skills[0]);
  if (!isPathInside(askSkillRoot, skillFile)) {
    throw new Error("Loaded ask-user skill resolves outside the relocated extension bundle");
  }

  return {
    commands: [...commandNames].sort(),
    extensions: loadedNames,
    skills: ["ask-user"],
    tools: [...toolNames].sort(),
  };
}

function relocatedRuntimeEnvironment(home, overrides = {}) {
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    ...overrides,
  };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return environment;
}

function extensionProbeEnvironment(home, agentDir) {
  return relocatedRuntimeEnvironment(home, {
    PI_CODING_AGENT_DIR: agentDir,
    PI_FFF_MODE: "tools-and-ui",
    PI_FFF_MULTIGREP: "0",
    FFF_FRECENCY_DB: path.join(home, "fff", "frecency.sqlite3"),
    FFF_HISTORY_DB: path.join(home, "fff", "history.sqlite3"),
  });
}

function runRelocatedExtensionProbe(packageRoot, home, expectedVersion) {
  const probeWorkspace = path.join(home, "extension-probe-workspace");
  const agentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(probeWorkspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const output = runRequired(process.execPath, [
    fileURLToPath(import.meta.url),
    "--extension-probe",
    packageRoot,
    expectedVersion,
  ], {
    cwd: probeWorkspace,
    env: extensionProbeEnvironment(home, agentDir),
  });
  const resultLines = output.split(/\r?\n/).filter((line) => line.startsWith(EXTENSION_PROBE_MARKER));
  if (resultLines.length !== 1) throw new Error("Relocated default extension probe returned invalid output");
  try {
    return JSON.parse(resultLines[0].slice(EXTENSION_PROBE_MARKER.length));
  } catch {
    throw new Error("Relocated default extension probe returned invalid JSON");
  }
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!Number.isInteger(port) || port <= 0) throw new Error("Could not reserve a loopback smoke-test port");
  return port;
}

function createAuthorization(input) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(18).toString("base64url");
  const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const payload = [
    "pihub-request-v3",
    input.method,
    input.target,
    emptyDigest,
    String(timestamp),
    nonce,
    input.epoch,
    input.deviceId,
  ].join("\n");
  const signature = createHmac("sha256", input.secret).update(payload, "utf8").digest("base64url");
  return "PiHub-HMAC-SHA256 "
    + [input.deviceId, timestamp, nonce, input.epoch, signature].join(":");
}

async function fetchUntilReady(url, child, deadline = Date.now() + 30_000) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Relocated Server exited before becoming healthy");
    }
    try {
      const response = await fetch(url + "/api/health", {
        cache: "no-store",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return response.json();
    } catch {
      // Startup polling is bounded by the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Relocated Server did not become healthy in time");
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

async function inspectArchiveLayout(archive) {
  let hasNpmPackageRoot = false;
  let hasStandaloneRoot = false;
  await tar.list({
    file: archive,
    strict: true,
    onReadEntry: (entry) => {
      if (entry.path === "package/package.json") hasNpmPackageRoot = true;
      if (entry.path === "package.json") hasStandaloneRoot = true;
    },
  });
  if (hasNpmPackageRoot === hasStandaloneRoot) {
    throw new Error("Server smoke archive has an ambiguous or unsupported layout");
  }
  return hasStandaloneRoot
    ? { name: "standalone", strip: 0 }
    : { name: "npm-package", strip: 1 };
}

export async function smokeServerResource(options = {}) {
  const packageMetadata = JSON.parse(
    fs.readFileSync(path.join(serverDirectory, "package.json"), "utf8"),
  );
  const version = options.version ?? packageMetadata.version;
  const archive = path.resolve(
    options.archive
      ?? path.join(root, "src-tauri", "resources", "pihub-server-" + version + ".tgz"),
  );
  const archiveInfo = fs.lstatSync(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) {
    throw new Error("Server smoke archive is invalid");
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-relocated-smoke-"));
  fs.chmodSync(temporaryDirectory, 0o700);
  const packageRoot = path.join(temporaryDirectory, "relocated", "server");
  const home = path.join(temporaryDirectory, "home");
  const authState = path.join(temporaryDirectory, "auth", "state.json");
  const issueInput = path.join(temporaryDirectory, "issue.json");
  const issueOutput = path.join(temporaryDirectory, "issue-output.json");
  let child;
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  try {
    const archiveLayout = await inspectArchiveLayout(archive);
    fs.mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    await tar.extract({
      file: archive,
      cwd: packageRoot,
      strip: archiveLayout.strip,
      strict: true,
      preservePaths: false,
    });
    if (
      path.resolve(packageRoot) === path.resolve(serverDirectory)
      || packageRoot.includes("pihub-portable-build")
    ) {
      throw new Error("Server smoke test did not relocate the package");
    }
    const relocatedMetadata = readPackageMetadata(
      path.join(packageRoot, "package.json"),
      "Relocated Server package manifest",
    );
    if (relocatedMetadata.name !== "@pihub/server" || relocatedMetadata.version !== version) {
      throw new Error("Relocated Server package identity does not match the smoke target");
    }
    assertRelocatedDependencyTree(packageRoot);
    const defaultExtensions = runRelocatedExtensionProbe(packageRoot, home, version);

    fs.writeFileSync(issueInput, JSON.stringify({
      label: "release smoke device",
      capabilities: ["workspaces:read"],
      ttlSeconds: 300,
    }) + "\n", { mode: 0o600 });
    runRequired(process.execPath, [
      path.join(packageRoot, "bin", "pihub-auth-admin.js"),
      "issue",
      "--state", authState,
      "--input", issueInput,
      "--output", issueOutput,
    ], {
      cwd: packageRoot,
      env: relocatedRuntimeEnvironment(home),
    });
    const pairingCode = JSON.parse(fs.readFileSync(issueOutput, "utf8")).code;
    if (typeof pairingCode !== "string") throw new Error("Smoke pairing code was not issued");

    const port = await reserveLoopbackPort();
    const origin = "http://127.0.0.1:" + port;
    child = spawn(
      process.execPath,
      [path.join(packageRoot, "bin", "pi-web.js"), "--no-open", "--port", String(port)],
      {
        cwd: packageRoot,
        env: relocatedRuntimeEnvironment(home, {
          PIHUB_AUTH_STATE_PATH: authState,
          PIHUB_HEADLESS: "1",
          PI_WEB_NO_OPEN: "1",
        }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdout.on("data", (chunk) => appendBounded(stdoutChunks, stdoutState, chunk));
    child.stderr.on("data", (chunk) => appendBounded(stderrChunks, stderrState, chunk));

    const health = await fetchUntilReady(origin, child);
    if (
      health?.status !== "ok"
      || health?.version !== version
      || typeof health?.authentication?.epoch !== "string"
    ) {
      throw new Error("Relocated Server health metadata is invalid");
    }

    const unauthorized = await fetch(origin + "/api/home", {
      signal: AbortSignal.timeout(5_000),
    });
    if (unauthorized.status !== 401) {
      throw new Error("Protected dynamic API did not reject an unsigned request");
    }

    const claim = await fetch(origin + "/api/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
      signal: AbortSignal.timeout(5_000),
    });
    if (claim.status !== 201) throw new Error("Relocated Server pairing claim failed");
    const claimed = await claim.json();
    const deviceId = claimed?.device?.id;
    const secret = claimed?.device?.secret;
    const epoch = claimed?.authentication?.epoch;
    if (![deviceId, secret, epoch].every((value) => typeof value === "string")) {
      throw new Error("Relocated Server pairing response is invalid");
    }

    const authorization = createAuthorization({
      deviceId,
      secret,
      epoch,
      method: "GET",
      target: "/api/home",
    });
    const authenticated = await fetch(origin + "/api/home", {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5_000),
    });
    if (!authenticated.ok) throw new Error("Authenticated dynamic API smoke request failed");
    const body = await authenticated.json();
    if (body?.home !== home) throw new Error("Relocated dynamic API returned unexpected data");

    const replay = await fetch(origin + "/api/home", {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5_000),
    });
    if (replay.status !== 401) {
      throw new Error("Authenticated dynamic API did not reject a replayed nonce");
    }

    return {
      archive,
      archiveLayout: archiveLayout.name,
      defaultExtensions,
      dependencySource: "archive",
      packageRoot,
      port,
      testedRoute: "/api/home",
      version,
    };
  } catch (error) {
    const stdout = Buffer.concat(stdoutChunks).toString("utf8").slice(-4_096);
    const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(-4_096);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error((message + "\n" + stdout + "\n" + stderr).trim());
  } finally {
    if (child) await stopChild(child);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv[2] === "--extension-probe") {
    const packageRoot = process.argv[3];
    const expectedVersion = process.argv[4];
    if (!packageRoot || !expectedVersion || process.argv.length !== 5) {
      throw new Error("--extension-probe requires an exact Server root and version");
    }
    const result = await smokeRelocatedDefaultExtensions(path.resolve(packageRoot), { expectedVersion });
    console.log(`${EXTENSION_PROBE_MARKER}${JSON.stringify(result)}`);
    return;
  }
  const archiveIndex = process.argv.indexOf("--archive");
  const archive = archiveIndex >= 0 ? process.argv[archiveIndex + 1] : undefined;
  if (archiveIndex >= 0 && (!archive || archive.startsWith("--"))) {
    throw new Error("--archive requires a path");
  }
  const result = await smokeServerResource({ archive });
  console.log(
    "Relocated Server smoke passed ("
      + result.version
      + "; "
      + result.archiveLayout
      + "; archive dependencies; "
      + result.defaultExtensions.extensions.length
      + " default extensions and ask-user skill"
      + "; authenticated "
      + result.testedRoute
      + ")",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
