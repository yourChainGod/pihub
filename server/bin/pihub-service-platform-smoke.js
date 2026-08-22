#!/usr/bin/env node
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const installer = require("./pihub-server-install.js");
const packageMetadata = require("../package.json");

const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;

function runNativeCommand(command, args, { input } = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    input,
    shell: false,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function requireSuccessfulCommand(result, description) {
  if (result?.error) throw new Error(`${description}: ${result.error.message}`);
  if (result?.status !== 0) {
    const detail = String(result?.stderr || result?.stdout || `exit status ${String(result?.status)}`)
      .trim()
      .slice(0, 4_000);
    throw new Error(`${description}: ${detail}`);
  }
  if (
    Buffer.byteLength(String(result.stdout || ""), "utf8") > MAX_TOOL_OUTPUT_BYTES
    || Buffer.byteLength(String(result.stderr || ""), "utf8") > MAX_TOOL_OUTPUT_BYTES
  ) {
    throw new Error(`${description}: native validator output exceeded its limit`);
  }
  return result;
}

function validateDarwinDefinition({
  nodePath,
  serverPath,
  logDirectory,
  environmentPath,
  runner = runNativeCommand,
}) {
  const plist = installer.renderLaunchAgent({
    nodePath,
    serverPath,
    logDirectory,
    environmentPath,
  });
  requireSuccessfulCommand(
    runner("plutil", ["-lint", "-"], { input: plist }),
    "plutil rejected the PiHub launch agent",
  );
  const converted = requireSuccessfulCommand(
    runner("plutil", ["-convert", "json", "-o", "-", "-"], { input: plist }),
    "plutil could not decode the PiHub launch agent",
  );
  let definition;
  try {
    definition = JSON.parse(converted.stdout);
  } catch (error) {
    throw new Error("plutil returned invalid JSON for the PiHub launch agent", { cause: error });
  }

  const expectedArguments = [
    nodePath,
    serverPath,
    "--no-open",
    "--hostname",
    "127.0.0.1",
    "--port",
    "30141",
  ];
  if (
    definition?.Label !== installer.SERVICE_LABEL
    || JSON.stringify(definition.ProgramArguments) !== JSON.stringify(expectedArguments)
    || definition.WorkingDirectory !== path.dirname(serverPath)
    || definition.EnvironmentVariables?.PIHUB_HEADLESS !== "1"
    || definition.EnvironmentVariables?.PIHUB_LOG_DIRECTORY !== logDirectory
    || typeof definition.EnvironmentVariables?.PATH !== "string"
    || definition.EnvironmentVariables.PATH.length === 0
    || definition.RunAtLoad !== true
    || definition.KeepAlive !== true
    || definition.ThrottleInterval !== 2
    || definition.Umask !== 0o77
    || definition.StandardOutPath !== "/dev/null"
    || definition.StandardErrorPath !== "/dev/null"
  ) {
    throw new Error("The native launchd parser returned an unexpected PiHub definition.");
  }
  return "plutil";
}

function validateLinuxDefinition({
  nodePath,
  serverPath,
  logDirectory,
  environmentPath,
  unitDirectory,
  runner = runNativeCommand,
}) {
  fs.mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
  const unitPath = path.join(unitDirectory, installer.SYSTEMD_UNIT);
  fs.writeFileSync(unitPath, installer.renderSystemdUnit({
    nodePath,
    serverPath,
    logDirectory,
    environmentPath,
  }), { flag: "wx", mode: 0o600 });
  requireSuccessfulCommand(
    runner("systemd-analyze", ["--user", "verify", unitPath]),
    "systemd-analyze rejected the PiHub user unit",
  );
  return "systemd-analyze";
}

function parseSingleJsonLine(stdout, description) {
  if (Buffer.byteLength(String(stdout || ""), "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    throw new Error(`${description} output exceeded its limit`);
  }
  const lines = String(stdout || "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) throw new Error(`${description} did not return exactly one JSON line`);
  try {
    return JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`${description} returned invalid JSON`, { cause: error });
  }
}

function validateWindowsDefinition({
  nodePath,
  serverPath,
  expectedVersion,
  runner = runNativeCommand,
}) {
  const scriptPath = path.join(__dirname, "pihub-server-install-windows.ps1");
  const result = requireSuccessfulCommand(runner("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-NodePath",
    nodePath,
    "-ServerPath",
    serverPath,
    "-ExpectedVersion",
    expectedVersion,
    "-ValidateDefinition",
  ]), "Windows PowerShell rejected the PiHub scheduled task definition");
  const definition = parseSingleJsonLine(result.stdout, "PiHub Windows definition validation");
  if (
    definition?.schemaVersion !== 1
    || definition.command !== "validate-definition"
    || definition.platform !== "win32"
    || definition.definitionSafe !== true
    || definition.aclValidated !== true
    || definition.registered !== false
    || definition.runLevel !== "Limited"
  ) {
    throw new Error("Windows PowerShell returned an unsafe PiHub scheduled task definition.");
  }
  return "Windows PowerShell ScheduledTasks";
}

async function validateUnixManagerStatus({
  platform,
  uid,
  home,
  nodePath,
  serverPath,
  environmentPath,
  runner = runNativeCommand,
}) {
  const status = await installer.getPersistentServiceStatus({
    platform,
    uid,
    home,
    nodePath,
    serverPath,
    environmentPath,
    runner,
    fetchImpl: async () => { throw new Error("native smoke does not contact a running service"); },
  });
  if (!status.managerAvailable) {
    throw new Error(`The ${platform === "darwin" ? "launchd GUI domain" : "systemd user manager"} is unavailable.`);
  }
  if (status.configured || status.ready || fs.existsSync(home)) {
    throw new Error("The read-only service status smoke unexpectedly created or matched persistent state.");
  }
  return status.state;
}

async function runNativeServiceSmoke({
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : undefined,
  nodePath = process.execPath,
  serverPath = path.join(__dirname, "pihub-server.js"),
  expectedVersion = packageMetadata.version,
  environmentPath = process.env.PATH || "",
  runner = runNativeCommand,
} = {}) {
  if (!new Set(["darwin", "linux", "win32"]).has(platform)) {
    throw new Error(`Unsupported native service smoke platform: ${platform}`);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-service-smoke-"));
  try {
    if (platform === "win32") {
      const validator = validateWindowsDefinition({
        nodePath,
        serverPath,
        expectedVersion,
        runner,
      });
      return {
        schemaVersion: 1,
        platform,
        validator,
        managerAvailable: true,
        persistentChanges: false,
      };
    }

    const logDirectory = path.join(scratch, "uncreated-logs");
    const statusHome = path.join(scratch, "uncreated-status-home");
    const validator = platform === "darwin"
      ? validateDarwinDefinition({
          nodePath,
          serverPath,
          logDirectory,
          environmentPath,
          runner,
        })
      : validateLinuxDefinition({
          nodePath,
          serverPath,
          logDirectory,
          environmentPath,
          unitDirectory: path.join(scratch, "unit"),
          runner,
        });
    const state = await validateUnixManagerStatus({
      platform,
      uid,
      home: statusHome,
      nodePath,
      serverPath,
      environmentPath,
      runner,
    });
    return {
      schemaVersion: 1,
      platform,
      validator,
      managerAvailable: true,
      observedState: state,
      persistentChanges: false,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const result = await runNativeServiceSmoke();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  parseSingleJsonLine,
  requireSuccessfulCommand,
  runNativeServiceSmoke,
  validateDarwinDefinition,
  validateLinuxDefinition,
  validateUnixManagerStatus,
  validateWindowsDefinition,
};
