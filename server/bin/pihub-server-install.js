#!/usr/bin/env node
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SERVICE_LABEL = "dev.pihub.server";
const SYSTEMD_UNIT = "pihub-server.service";
const SERVER_PORT = "30141";
const HEALTH_URL = `http://127.0.0.1:${SERVER_PORT}/api/health`;
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SERVICE_RESULT_SCHEMA_VERSION = 1;
const SERVICE_COMMANDS = new Set(["install", "status", "repair", "logs", "uninstall"]);
const MAX_DEFINITION_BYTES = 1024 * 1024;
const MAX_HEALTH_BODY_BYTES = 8 * 1024;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_BACKUPS = 1;

function commandSucceeded(result) {
  return !result.error && result.status === 0;
}

function runCommand(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function commandError(result, description) {
  const detail = result.error?.message || result.stderr?.trim() || `exit status ${String(result.status)}`;
  return new Error(`${description}: ${detail}`);
}

function runRequired(runner, command, args, description) {
  const result = runner(command, args);
  if (!commandSucceeded(result)) throw commandError(result, description);
  return result;
}

function parseServiceCommand(argv = process.argv.slice(2)) {
  if (argv.length === 0) return "install";
  if (argv.length === 1 && (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h")) {
    return "help";
  }
  if (argv.length !== 1 || !SERVICE_COMMANDS.has(argv[0])) {
    throw new Error("Usage: pihub-server-service <install|status|repair|logs|uninstall>");
  }
  return argv[0];
}

function serviceUsage() {
  return [
    "Usage: pihub-server-service <install|status|repair|logs|uninstall>",
    "No command remains equivalent to install for bootstrap compatibility.",
    "uninstall removes only the service definition; PiHub data and credentials are retained.",
  ].join("\n");
}

function assertUnprivilegedUser(platform, uid) {
  // Root installs are permitted only when the desktop user explicitly confirmed
  // them; the bootstrap then exports PIHUB_ALLOW_ROOT=1.
  if ((platform === "darwin" || platform === "linux") && uid === 0 && process.env.PIHUB_ALLOW_ROOT !== "1") {
    throw new Error("PiHub must be installed and run as the signed-in user. Do not run this installer with sudo or as root. Root installs require PIHUB_ALLOW_ROOT=1 from an explicitly confirmed desktop bootstrap.");
  }
  if ((platform === "darwin" || platform === "linux") && (!Number.isInteger(uid) || uid < 0)) {
    throw new Error("Could not determine the current user id; refusing to install a persistent service.");
  }
}

function assertInstallFile(file, description) {
  if (!path.isAbsolute(file) || /[\0\r\n]/.test(file)) {
    throw new Error(`${description} must use an absolute path without control characters.`);
  }
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new Error(`${description} does not exist: ${file}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${description} must be a regular file: ${file}`);
  }
}

function readExpectedServerVersion(serverPath) {
  const packagePath = path.join(path.dirname(serverPath), "..", "package.json");
  assertInstallFile(packagePath, "PiHub server package metadata");
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error("PiHub server package metadata is not valid JSON.", { cause: error });
  }
  const version = metadata?.version;
  if (typeof version !== "string" || !RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error("PiHub server package metadata does not contain a valid release version.");
  }
  return version;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to use a non-directory or symbolic link: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

function ensurePrivateLogFile(file) {
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing to use a non-regular log file or symbolic link: ${file}`);
    }
  }
  const fd = fs.openSync(file, "a", 0o600);
  fs.closeSync(fd);
  fs.chmodSync(file, 0o600);
}

function snapshotFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_DEFINITION_BYTES) {
      throw new Error(`Refusing to replace a non-regular file or symbolic link: ${file}`);
    }
    return { exists: true, contents: fs.readFileSync(file), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

function inspectDefinition(file, expectedContents) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, safe: true, matches: false };
    return { exists: true, safe: false, matches: false };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_DEFINITION_BYTES) {
    return { exists: true, safe: false, matches: false };
  }
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.size > MAX_DEFINITION_BYTES
      || (
        process.platform !== "win32"
        && (opened.dev !== stat.dev || opened.ino !== stat.ino)
      )
    ) {
      return { exists: true, safe: false, matches: false };
    }
    const contents = fs.readFileSync(descriptor, "utf8");
    return { exists: true, safe: true, matches: contents === expectedContents };
  } catch {
    return { exists: true, safe: false, matches: false };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function temporarySibling(destination) {
  const extension = path.extname(destination);
  const basename = path.basename(destination, extension);
  return path.join(
    path.dirname(destination),
    `.${basename}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp${extension}`,
  );
}

function stageFile(destination, contents, mode = 0o600) {
  const temporary = temporarySibling(destination);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(temporary, mode);
    return temporary;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function replaceWithStagedFile(temporary, destination) {
  fs.renameSync(temporary, destination);
}

function restoreSnapshot(destination, snapshot) {
  if (!snapshot.exists) {
    try {
      const stat = fs.lstatSync(destination);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Refusing to remove a non-regular rollback target: ${destination}`);
      }
      fs.unlinkSync(destination);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return;
  }
  const temporary = stageFile(destination, snapshot.contents, snapshot.mode);
  replaceWithStagedFile(temporary, destination);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value, { escapeDollar = false } = {}) {
  let escaped = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += '\\"';
    else if (character === "%") escaped += "%%";
    else if (escapeDollar && character === "$") escaped += "$$";
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (code < 0x20 || code === 0x7f) escaped += `\\x${code.toString(16).padStart(2, "0")}`;
    else escaped += character;
  }
  return `"${escaped}"`;
}

// systemd < 245 treats the quotes in WorkingDirectory="..." as part of the
// path ("not absolute"); only quote when the value actually needs it.
function systemdPathDirective(value) {
  return /[\s"'\\$%]/.test(value) ? systemdQuote(value) : String(value);
}

function effectivePath(nodePath, environmentPath = "") {
  const values = [path.dirname(nodePath), ...environmentPath.split(path.delimiter), "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
  return [...new Set(values.filter((value) => path.isAbsolute(value) && !/[\0\r\n]/.test(value)))].join(path.delimiter);
}

function serverArguments(serverPath) {
  return [serverPath, "--no-open", "--hostname", "127.0.0.1", "--port", SERVER_PORT];
}

function renderLaunchAgent({ nodePath, serverPath, logDirectory, environmentPath }) {
  const argumentsXml = [nodePath, ...serverArguments(serverPath)]
    .map((argument) => `<string>${xmlEscape(argument)}</string>`)
    .join("");
  const workingDirectory = path.dirname(serverPath);
  const servicePath = effectivePath(nodePath, environmentPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string>
<key>EnvironmentVariables</key><dict>
<key>PIHUB_HEADLESS</key><string>1</string>
<key>PIHUB_LOG_DIRECTORY</key><string>${xmlEscape(logDirectory)}</string>
<key>PATH</key><string>${xmlEscape(servicePath)}</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>2</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}

function renderSystemdUnit({ nodePath, serverPath, logDirectory, environmentPath }) {
  const execStart = [nodePath, ...serverArguments(serverPath)]
    .map((argument) => systemdQuote(argument, { escapeDollar: true }))
    .join(" ");
  const servicePath = effectivePath(nodePath, environmentPath);
  return `[Unit]
Description=PiHub user server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=${systemdQuote("PIHUB_HEADLESS=1")}
Environment=${systemdQuote(`PIHUB_LOG_DIRECTORY=${logDirectory}`)}
Environment=${systemdQuote(`PATH=${servicePath}`)}
WorkingDirectory=${systemdPathDirective(path.dirname(serverPath))}
ExecStart=${execStart}
Restart=on-failure
RestartSec=2
StartLimitIntervalSec=0
UMask=0077
StandardOutput=journal
StandardError=journal
SyslogIdentifier=pihub-server

[Install]
WantedBy=default.target
`;
}

function unixServiceDescriptor({ platform, home, uid, nodePath, serverPath, environmentPath }) {
  const logDirectory = path.join(home, ".local", "state", "pihub");
  if (platform === "darwin") {
    const domain = `gui/${uid}`;
    const definitionPath = path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    return {
      definitionPath,
      expectedDefinition: renderLaunchAgent({ nodePath, serverPath, logDirectory, environmentPath }),
      logDirectory,
      service: SERVICE_LABEL,
      serviceTarget: `${domain}/${SERVICE_LABEL}`,
      domain,
    };
  }
  if (platform === "linux") {
    const definitionPath = path.join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
    return {
      definitionPath,
      expectedDefinition: renderSystemdUnit({ nodePath, serverPath, logDirectory, environmentPath }),
      logDirectory,
      service: SYSTEMD_UNIT,
    };
  }
  throw new Error(`Unsupported Unix service platform: ${platform}`);
}

function serviceState({ installed, ready }) {
  if (!installed) return "not-installed";
  return ready ? "ready" : "degraded";
}

function combineInstallAndRollbackError(error, rollbackErrors) {
  if (rollbackErrors.length === 0) return error;
  return new Error(`${error.message} Rollback also reported: ${rollbackErrors.map((item) => item.message).join("; ")}`, { cause: error });
}

async function readBoundedHealthBody(response, maxBytes = MAX_HEALTH_BODY_BYTES) {
  if (!response?.body || typeof response.body.getReader !== "function") {
    throw new Error("health endpoint did not return a readable body");
  }
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body.cancel?.().catch?.(() => undefined);
    throw new Error("health endpoint response is too large");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new Error("health endpoint response is too large");
      chunks.push(Buffer.from(chunk.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}

async function probeHealth({
  expectedVersion,
  fetchImpl = globalThis.fetch,
  healthUrl = HEALTH_URL,
  timeoutMs = 1_500,
} = {}) {
  if (typeof expectedVersion !== "string" || !RELEASE_VERSION_PATTERN.test(expectedVersion)) {
    throw new Error("A valid expected PiHub server version is required for the health probe.");
  }
  if (typeof fetchImpl !== "function") {
    return { healthy: false, reason: "fetch_unavailable", version: null };
  }
  try {
    const response = await fetchImpl(healthUrl, {
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json", "cache-control": "no-store" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { healthy: false, reason: "http_error", version: null };
    const body = await readBoundedHealthBody(response);
    const version = typeof body?.version === "string" && RELEASE_VERSION_PATTERN.test(body.version)
      ? body.version
      : null;
    if (body?.status !== "ok") return { healthy: false, reason: "invalid_status", version };
    if (version !== expectedVersion) return { healthy: false, reason: "version_mismatch", version };
    return { healthy: true, reason: null, version };
  } catch {
    return { healthy: false, reason: "unreachable", version: null };
  }
}

async function waitForHealth({
  expectedVersion,
  fetchImpl = globalThis.fetch,
  healthUrl = HEALTH_URL,
  // Small-memory hosts can take well over 20s from restart to a healthy Next
  // server; a slow boot is not a failure (round-7 rollback loop).
  timeoutMs = 90_000,
  retryDelayMs = 400,
} = {}) {
  if (typeof expectedVersion !== "string" || !RELEASE_VERSION_PATTERN.test(expectedVersion)) {
    throw new Error("A valid expected PiHub server version is required for the health check.");
  }
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch for the health check.");
  const deadline = Date.now() + timeoutMs;
  let lastError = new Error("health endpoint did not become ready");
  do {
    try {
      const response = await fetchImpl(healthUrl, {
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", "cache-control": "no-store" },
        signal: AbortSignal.timeout(Math.min(1_500, Math.max(1, deadline - Date.now()))),
      });
      if (response.ok) {
        const body = await readBoundedHealthBody(response);
        if (body?.status === "ok" && body?.version === expectedVersion) return;
        lastError = new Error("health endpoint did not report the expected PiHub server version");
      } else {
        lastError = new Error(`health endpoint returned HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  } while (Date.now() < deadline);
  throw new Error(`PiHub did not pass its local health check: ${lastError.message}`, { cause: lastError });
}

async function installLaunchAgent({ home, uid, nodePath, serverPath, environmentPath, runner, healthCheck }) {
  const agentsDirectory = path.join(home, "Library", "LaunchAgents");
  const logDirectory = path.join(home, ".local", "state", "pihub");
  ensurePrivateDirectory(agentsDirectory);
  ensurePrivateDirectory(logDirectory);
  ensurePrivateLogFile(path.join(logDirectory, "server.log"));
  ensurePrivateLogFile(path.join(logDirectory, "server-error.log"));

  const domain = `gui/${uid}`;
  runRequired(runner, "launchctl", ["print", domain], "The current user's launchd GUI domain is unavailable");

  const plistPath = path.join(agentsDirectory, `${SERVICE_LABEL}.plist`);
  const snapshot = snapshotFile(plistPath);
  const serviceTarget = `${domain}/${SERVICE_LABEL}`;
  const wasLoaded = commandSucceeded(runner("launchctl", ["print", serviceTarget]));
  if (wasLoaded && !snapshot.exists) {
    throw new Error(`A launchd service named ${SERVICE_LABEL} is already loaded from another location; refusing to replace it.`);
  }

  let candidate = stageFile(plistPath, renderLaunchAgent({ nodePath, serverPath, logDirectory, environmentPath }));
  try {
    runRequired(runner, "plutil", ["-lint", candidate], "The generated launchd configuration is invalid");
    replaceWithStagedFile(candidate, plistPath);
    candidate = undefined;
  } finally {
    if (candidate) {
      try { fs.unlinkSync(candidate); } catch { /* best-effort cleanup */ }
    }
  }

  let previousStopped = false;
  let candidateLoaded = false;
  try {
    if (wasLoaded) {
      runRequired(runner, "launchctl", ["bootout", serviceTarget], "Could not stop the previous PiHub launch agent");
      previousStopped = true;
    }
    runRequired(runner, "launchctl", ["bootstrap", domain, plistPath], "Could not register the PiHub launch agent");
    candidateLoaded = true;
    runRequired(runner, "launchctl", ["kickstart", "-k", serviceTarget], "Could not start the PiHub launch agent");
    runRequired(runner, "launchctl", ["print", serviceTarget], "The PiHub launch agent is not registered");
    await healthCheck();
    runRequired(runner, "launchctl", ["print", serviceTarget], "The PiHub launch agent exited during its health check");
  } catch (error) {
    const rollbackErrors = [];
    if (previousStopped || candidateLoaded) runner("launchctl", ["bootout", serviceTarget]);
    const serviceStillLoaded = commandSucceeded(runner("launchctl", ["print", serviceTarget]));
    const failedCandidateStillLoaded = (previousStopped || candidateLoaded) && serviceStillLoaded;
    if (failedCandidateStillLoaded) {
      rollbackErrors.push(new Error("The failed candidate launch agent could not be unloaded; its configuration was removed from disk but it remains active."));
    }
    try { restoreSnapshot(plistPath, snapshot); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (wasLoaded && snapshot.exists && !failedCandidateStillLoaded) {
      try {
        if (!serviceStillLoaded) {
          runRequired(runner, "launchctl", ["bootstrap", domain, plistPath], "Could not restore the previous launch agent");
        }
        runRequired(runner, "launchctl", ["kickstart", "-k", serviceTarget], "Could not restart the previous launch agent");
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    throw combineInstallAndRollbackError(error, rollbackErrors);
  }
}

function probeSystemdState(runner, args) {
  return commandSucceeded(runner("systemctl", ["--user", ...args]));
}

async function installSystemdUserService({ home, nodePath, serverPath, environmentPath, runner, healthCheck }) {
  runRequired(runner, "systemctl", ["--user", "show-environment"], "The current user's systemd manager is unavailable");

  const unitsDirectory = path.join(home, ".config", "systemd", "user");
  const logDirectory = path.join(home, ".local", "state", "pihub");
  ensurePrivateDirectory(unitsDirectory);
  ensurePrivateDirectory(logDirectory);
  ensurePrivateLogFile(path.join(logDirectory, "server.log"));
  ensurePrivateLogFile(path.join(logDirectory, "server-error.log"));

  const unitPath = path.join(unitsDirectory, SYSTEMD_UNIT);
  const snapshot = snapshotFile(unitPath);
  const wasEnabled = probeSystemdState(runner, ["is-enabled", "--quiet", SYSTEMD_UNIT]);
  const wasActive = probeSystemdState(runner, ["is-active", "--quiet", SYSTEMD_UNIT]);
  if ((wasEnabled || wasActive) && !snapshot.exists) {
    throw new Error(`A systemd user service named ${SYSTEMD_UNIT} is already loaded from another unit path; refusing to override it.`);
  }
  let candidate = stageFile(unitPath, renderSystemdUnit({ nodePath, serverPath, logDirectory, environmentPath }));
  try {
    replaceWithStagedFile(candidate, unitPath);
    candidate = undefined;
  } finally {
    if (candidate) {
      try { fs.unlinkSync(candidate); } catch { /* best-effort cleanup */ }
    }
  }

  try {
    runRequired(runner, "systemctl", ["--user", "daemon-reload"], "Could not reload the user systemd manager");
    runRequired(runner, "systemctl", ["--user", "enable", SYSTEMD_UNIT], "Could not enable the PiHub user service");
    runRequired(runner, "systemctl", ["--user", "restart", SYSTEMD_UNIT], "Could not start the PiHub user service");
    runRequired(runner, "systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT], "The PiHub user service is not active");
    await healthCheck();
    runRequired(runner, "systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT], "The PiHub user service exited during its health check");
  } catch (error) {
    const rollbackErrors = [];
    // Stop the failed candidate while systemd still knows its loaded unit.
    // A missing or already-dead candidate is an acceptable rollback state.
    runner("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
    try { restoreSnapshot(unitPath, snapshot); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    try { runRequired(runner, "systemctl", ["--user", "daemon-reload"], "Could not reload systemd during rollback"); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    try {
      const enableAction = wasEnabled ? "enable" : "disable";
      runRequired(runner, "systemctl", ["--user", enableAction, SYSTEMD_UNIT], `Could not ${enableAction} the previous user service state`);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (wasActive) {
      try {
        runRequired(runner, "systemctl", ["--user", "restart", SYSTEMD_UNIT], "Could not restart the previous user service state");
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    throw combineInstallAndRollbackError(error, rollbackErrors);
  }
}

function windowsOperationArguments({ nodePath, serverPath, expectedVersion, operation }) {
  const script = path.join(__dirname, "pihub-server-install-windows.ps1");
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-NodePath",
    nodePath,
    "-ServerPath",
    serverPath,
    "-ExpectedVersion",
    expectedVersion,
    "-Operation",
    operation,
  ];
}

function runWindowsOperation({ nodePath, serverPath, expectedVersion, operation, runner }) {
  const args = windowsOperationArguments({ nodePath, serverPath, expectedVersion, operation });
  return runner("powershell.exe", args);
}

function installWindowsTask({ nodePath, serverPath, expectedVersion, operation = "install", runner }) {
  runRequired(
    runner,
    "powershell.exe",
    windowsOperationArguments({ nodePath, serverPath, expectedVersion, operation }),
    "Could not register the PiHub current-user startup task",
  );
}

function parseWindowsServiceResult(result, allowedStatuses = new Set([0])) {
  if (result.error || !allowedStatuses.has(result.status)) {
    throw commandError(result, "The PiHub Windows service command failed");
  }
  const lines = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && value.schemaVersion === SERVICE_RESULT_SCHEMA_VERSION
      ) return value;
    } catch { /* stable markers and PowerShell host output are ignored */ }
  }
  throw new Error("The PiHub Windows service command did not return a valid status document.");
}

async function installPersistentService({
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
  home = os.homedir(),
  nodePath = process.execPath,
  serverPath = path.join(__dirname, "pihub-server.js"),
  environmentPath = process.env.PATH || "",
  runner = runCommand,
  healthCheck = waitForHealth,
  operation = "install",
} = {}) {
  if (operation !== "install" && operation !== "repair") {
    throw new Error("Persistent service installation requires install or repair.");
  }
  assertUnprivilegedUser(platform, uid);
  assertInstallFile(nodePath, "Node.js executable");
  assertInstallFile(serverPath, "PiHub server entry point");
  const expectedVersion = readExpectedServerVersion(serverPath);
  const verifyHealth = () => healthCheck({ expectedVersion });

  if (platform === "darwin") {
    await installLaunchAgent({ home, uid, nodePath, serverPath, environmentPath, runner, healthCheck: verifyHealth });
  } else if (platform === "linux") {
    await installSystemdUserService({ home, nodePath, serverPath, environmentPath, runner, healthCheck: verifyHealth });
  } else if (platform === "win32") {
    installWindowsTask({ nodePath, serverPath, expectedVersion, operation, runner });
  } else {
    throw new Error(`Unsupported platform for persistent service: ${platform}`);
  }
}

async function getPersistentServiceStatus({
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
  home = os.homedir(),
  nodePath = process.execPath,
  serverPath = path.join(__dirname, "pihub-server.js"),
  environmentPath = process.env.PATH || "",
  runner = runCommand,
  fetchImpl = globalThis.fetch,
} = {}) {
  assertUnprivilegedUser(platform, uid);
  assertInstallFile(nodePath, "Node.js executable");
  assertInstallFile(serverPath, "PiHub server entry point");
  const expectedVersion = readExpectedServerVersion(serverPath);

  if (platform === "win32") {
    return parseWindowsServiceResult(runWindowsOperation({
      nodePath,
      serverPath,
      expectedVersion,
      operation: "status",
      runner,
    }), new Set([0, 3]));
  }
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported platform for persistent service: ${platform}`);
  }

  const descriptor = unixServiceDescriptor({
    platform,
    home,
    uid,
    nodePath,
    serverPath,
    environmentPath,
  });
  const definition = inspectDefinition(descriptor.definitionPath, descriptor.expectedDefinition);
  let managerAvailable;
  let active;
  let enabled;
  if (platform === "darwin") {
    managerAvailable = commandSucceeded(runner("launchctl", ["print", descriptor.domain]));
    active = managerAvailable
      && commandSucceeded(runner("launchctl", ["print", descriptor.serviceTarget]));
    enabled = definition.exists;
  } else {
    managerAvailable = commandSucceeded(runner("systemctl", ["--user", "show-environment"]));
    active = managerAvailable && probeSystemdState(runner, ["is-active", "--quiet", SYSTEMD_UNIT]);
    enabled = managerAvailable && probeSystemdState(runner, ["is-enabled", "--quiet", SYSTEMD_UNIT]);
  }
  const installed = definition.exists || active || enabled;
  const health = active
    ? await probeHealth({ expectedVersion, fetchImpl })
    : { healthy: false, reason: "inactive", version: null };
  const configured = definition.safe && definition.matches;
  const ready = Boolean(managerAvailable && configured && active && enabled && health.healthy);
  return {
    schemaVersion: SERVICE_RESULT_SCHEMA_VERSION,
    command: "status",
    platform,
    service: descriptor.service,
    state: serviceState({ installed, ready }),
    installed: Boolean(installed),
    configured,
    definitionSafe: definition.safe,
    managerAvailable: Boolean(managerAvailable),
    active: Boolean(active),
    enabled: Boolean(enabled),
    healthy: health.healthy,
    healthReason: health.reason,
    version: health.version,
    expectedVersion,
    ready,
  };
}

async function uninstallLaunchAgent({ home, uid, runner }) {
  const descriptor = unixServiceDescriptor({
    platform: "darwin",
    home,
    uid,
    nodePath: process.execPath,
    serverPath: path.join(__dirname, "pihub-server.js"),
    environmentPath: process.env.PATH || "",
  });
  runRequired(runner, "launchctl", ["print", descriptor.domain], "The current user's launchd GUI domain is unavailable");
  const snapshot = snapshotFile(descriptor.definitionPath);
  const wasLoaded = commandSucceeded(runner("launchctl", ["print", descriptor.serviceTarget]));
  if (wasLoaded && !snapshot.exists) {
    throw new Error(`A launchd service named ${SERVICE_LABEL} is loaded from another location; refusing to remove it.`);
  }
  if (!wasLoaded && !snapshot.exists) return false;

  let stopped = false;
  let removed = false;
  try {
    if (wasLoaded) {
      runRequired(runner, "launchctl", ["bootout", descriptor.serviceTarget], "Could not stop the PiHub launch agent");
      stopped = true;
    }
    if (snapshot.exists) {
      fs.unlinkSync(descriptor.definitionPath);
      removed = true;
    }
    if (commandSucceeded(runner("launchctl", ["print", descriptor.serviceTarget]))) {
      throw new Error("The PiHub launch agent is still loaded after uninstall.");
    }
    if (fs.existsSync(descriptor.definitionPath)) {
      throw new Error("The PiHub launch agent definition still exists after uninstall.");
    }
    return true;
  } catch (error) {
    const rollbackErrors = [];
    if (removed) {
      try { restoreSnapshot(descriptor.definitionPath, snapshot); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (wasLoaded && stopped) {
      try {
        runRequired(runner, "launchctl", ["bootstrap", descriptor.domain, descriptor.definitionPath], "Could not restore the previous launch agent");
        runRequired(runner, "launchctl", ["kickstart", "-k", descriptor.serviceTarget], "Could not restart the previous launch agent");
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    throw combineInstallAndRollbackError(error, rollbackErrors);
  }
}

async function uninstallSystemdUserService({ home, runner }) {
  runRequired(runner, "systemctl", ["--user", "show-environment"], "The current user's systemd manager is unavailable");
  const descriptor = unixServiceDescriptor({
    platform: "linux",
    home,
    nodePath: process.execPath,
    serverPath: path.join(__dirname, "pihub-server.js"),
    environmentPath: process.env.PATH || "",
  });
  const snapshot = snapshotFile(descriptor.definitionPath);
  const wasEnabled = probeSystemdState(runner, ["is-enabled", "--quiet", SYSTEMD_UNIT]);
  const wasActive = probeSystemdState(runner, ["is-active", "--quiet", SYSTEMD_UNIT]);
  if ((wasEnabled || wasActive) && !snapshot.exists) {
    throw new Error(`A systemd user service named ${SYSTEMD_UNIT} is loaded from another unit path; refusing to remove it.`);
  }
  if (!snapshot.exists && !wasEnabled && !wasActive) return false;

  let stopped = false;
  let disabled = false;
  let removed = false;
  try {
    if (wasActive) {
      runRequired(runner, "systemctl", ["--user", "stop", SYSTEMD_UNIT], "Could not stop the PiHub user service");
      stopped = true;
    }
    if (wasEnabled) {
      runRequired(runner, "systemctl", ["--user", "disable", SYSTEMD_UNIT], "Could not disable the PiHub user service");
      disabled = true;
    }
    if (snapshot.exists) {
      fs.unlinkSync(descriptor.definitionPath);
      removed = true;
    }
    runRequired(runner, "systemctl", ["--user", "daemon-reload"], "Could not reload systemd after uninstall");
    if (probeSystemdState(runner, ["is-active", "--quiet", SYSTEMD_UNIT])) {
      throw new Error("The PiHub user service is still active after uninstall.");
    }
    if (probeSystemdState(runner, ["is-enabled", "--quiet", SYSTEMD_UNIT])) {
      throw new Error("The PiHub user service is still enabled after uninstall.");
    }
    if (fs.existsSync(descriptor.definitionPath)) {
      throw new Error("The PiHub systemd user unit still exists after uninstall.");
    }
    return true;
  } catch (error) {
    const rollbackErrors = [];
    if (removed) {
      try { restoreSnapshot(descriptor.definitionPath, snapshot); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    try {
      runRequired(runner, "systemctl", ["--user", "daemon-reload"], "Could not reload systemd during uninstall rollback");
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (wasEnabled && disabled) {
      try {
        runRequired(runner, "systemctl", ["--user", "enable", SYSTEMD_UNIT], "Could not restore the previous enabled state");
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (wasActive && stopped) {
      try {
        runRequired(runner, "systemctl", ["--user", "restart", SYSTEMD_UNIT], "Could not restart the previous user service");
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    throw combineInstallAndRollbackError(error, rollbackErrors);
  }
}

async function uninstallPersistentService({
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
  home = os.homedir(),
  nodePath = process.execPath,
  serverPath = path.join(__dirname, "pihub-server.js"),
  runner = runCommand,
} = {}) {
  assertUnprivilegedUser(platform, uid);
  if (platform === "darwin") return uninstallLaunchAgent({ home, uid, runner });
  if (platform === "linux") return uninstallSystemdUserService({ home, runner });
  if (platform === "win32") {
    assertInstallFile(nodePath, "Node.js executable");
    assertInstallFile(serverPath, "PiHub server entry point");
    const expectedVersion = readExpectedServerVersion(serverPath);
    const result = runWindowsOperation({
      nodePath,
      serverPath,
      expectedVersion,
      operation: "uninstall",
      runner,
    });
    return parseWindowsServiceResult(result).removed === true;
  }
  throw new Error(`Unsupported platform for persistent service: ${platform}`);
}

function unixLogResult({ platform, home }) {
  const logDirectory = path.join(home, ".local", "state", "pihub");
  return {
    schemaVersion: SERVICE_RESULT_SCHEMA_VERSION,
    command: "logs",
    platform,
    stdout: path.join(logDirectory, "server.log"),
    stderr: path.join(logDirectory, "server-error.log"),
    maxBytes: MAX_LOG_BYTES,
    backups: LOG_BACKUPS,
    retainedOnUninstall: true,
  };
}

async function getPersistentServiceLogs({
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
  home = os.homedir(),
  nodePath = process.execPath,
  serverPath = path.join(__dirname, "pihub-server.js"),
  runner = runCommand,
} = {}) {
  assertUnprivilegedUser(platform, uid);
  if (platform === "darwin" || platform === "linux") return unixLogResult({ platform, home });
  if (platform === "win32") {
    assertInstallFile(nodePath, "Node.js executable");
    assertInstallFile(serverPath, "PiHub server entry point");
    return parseWindowsServiceResult(runWindowsOperation({
      nodePath,
      serverPath,
      expectedVersion: readExpectedServerVersion(serverPath),
      operation: "logs",
      runner,
    }));
  }
  throw new Error(`Unsupported platform for persistent service: ${platform}`);
}

async function runPersistentServiceCommand({ command, ...options } = {}) {
  if (!SERVICE_COMMANDS.has(command)) throw new Error("Invalid PiHub service command.");
  if (command === "status") return getPersistentServiceStatus(options);
  if (command === "logs") return getPersistentServiceLogs(options);
  if (command === "uninstall") {
    const removed = await uninstallPersistentService(options);
    return {
      schemaVersion: SERVICE_RESULT_SCHEMA_VERSION,
      command,
      platform: options.platform ?? process.platform,
      state: "removed",
      removed,
      dataRetained: true,
    };
  }

  if (command === "install") {
    const current = await getPersistentServiceStatus(options);
    if (current.ready) return { ...current, command, changed: false };
  }
  await installPersistentService({ ...options, operation: command });
  const verified = await getPersistentServiceStatus(options);
  if (!verified.ready) throw new Error("PiHub service installation completed but verification did not report ready.");
  return { ...verified, command, changed: true };
}

async function main() {
  try {
    const command = parseServiceCommand();
    if (command === "help") {
      console.log(serviceUsage());
      return;
    }
    const result = await runPersistentServiceCommand({ command });
    console.log(JSON.stringify(result));
    if (command === "install" || command === "repair") console.log("PIHUB_SERVICE_READY");
    if (command === "status" && !result.ready) process.exitCode = 3;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  HEALTH_URL,
  LOG_BACKUPS,
  MAX_LOG_BYTES,
  SERVICE_LABEL,
  SERVICE_RESULT_SCHEMA_VERSION,
  SYSTEMD_UNIT,
  assertUnprivilegedUser,
  ensurePrivateDirectory,
  ensurePrivateLogFile,
  getPersistentServiceLogs,
  getPersistentServiceStatus,
  installPersistentService,
  inspectDefinition,
  parseServiceCommand,
  parseWindowsServiceResult,
  probeHealth,
  readExpectedServerVersion,
  renderLaunchAgent,
  renderSystemdUnit,
  restoreSnapshot,
  runPersistentServiceCommand,
  serviceUsage,
  snapshotFile,
  systemdQuote,
  uninstallPersistentService,
  waitForHealth,
  xmlEscape,
};
