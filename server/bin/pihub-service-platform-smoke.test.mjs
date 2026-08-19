import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const installer = require("./pihub-server-install.js");
const smoke = require("./pihub-service-platform-smoke.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-platform-smoke-test-"));
  const runtime = path.join(root, "runtime with spaces");
  fs.mkdirSync(runtime);
  const nodePath = path.join(runtime, "node executable");
  const serverPath = path.join(runtime, "pi web.js");
  fs.writeFileSync(nodePath, "node");
  fs.writeFileSync(serverPath, "server");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.0.1" }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, nodePath, serverPath };
}

function result(status = 0, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

test("macOS smoke uses plutil and verifies the decoded launchd contract", (t) => {
  const files = fixture(t);
  const logDirectory = path.join(files.root, "logs");
  const calls = [];
  const definition = {
    Label: installer.SERVICE_LABEL,
    ProgramArguments: [
      files.nodePath,
      files.serverPath,
      "--no-open",
      "--hostname",
      "127.0.0.1",
      "--port",
      "30141",
    ],
    WorkingDirectory: path.dirname(files.serverPath),
    EnvironmentVariables: {
      PIHUB_HEADLESS: "1",
      PIHUB_LOG_DIRECTORY: logDirectory,
      PATH: path.dirname(files.nodePath),
    },
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 2,
    Umask: 0o77,
    StandardOutPath: "/dev/null",
    StandardErrorPath: "/dev/null",
  };
  const runner = (command, args, options) => {
    calls.push({ args, command, input: options?.input });
    return args.includes("json") ? result(0, JSON.stringify(definition)) : result();
  };

  assert.equal(smoke.validateDarwinDefinition({
    nodePath: files.nodePath,
    serverPath: files.serverPath,
    logDirectory,
    environmentPath: path.dirname(files.nodePath),
    runner,
  }), "plutil");
  assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [
    ["plutil", "-lint", "-"],
    ["plutil", "-convert", "json", "-o", "-", "-"],
  ]);
  assert.equal(calls.every((call) => call.input.includes("dev.pihub.server")), true);
});

test("Linux smoke writes a private temporary unit and invokes systemd-analyze", (t) => {
  const files = fixture(t);
  const unitDirectory = path.join(files.root, "unit");
  let checked = false;
  const runner = (command, args) => {
    assert.equal(command, "systemd-analyze");
    assert.deepEqual(args.slice(0, 2), ["--user", "verify"]);
    const unitPath = args[2];
    const source = fs.readFileSync(unitPath, "utf8");
    assert.match(source, /WantedBy=default\.target/);
    assert.match(source, /UMask=0077/);
    assert.equal(fs.statSync(unitPath).mode & 0o777, 0o600);
    checked = true;
    return result();
  };

  assert.equal(smoke.validateLinuxDefinition({
    nodePath: files.nodePath,
    serverPath: files.serverPath,
    logDirectory: path.join(files.root, "logs"),
    environmentPath: path.dirname(files.nodePath),
    unitDirectory,
    runner,
  }), "systemd-analyze");
  assert.equal(checked, true);
});

test("Windows smoke executes only the production no-registration validation mode", (t) => {
  const files = fixture(t);
  let invocation;
  const runner = (command, args) => {
    invocation = { args, command };
    return result(0, `${JSON.stringify({
      schemaVersion: 1,
      command: "validate-definition",
      platform: "win32",
      definitionSafe: true,
      aclValidated: true,
      registered: false,
      runLevel: "Limited",
    })}\r\n`);
  };

  assert.equal(smoke.validateWindowsDefinition({
    nodePath: files.nodePath,
    serverPath: files.serverPath,
    expectedVersion: "0.0.1",
    runner,
  }), "Windows PowerShell ScheduledTasks");
  assert.equal(invocation.command, "powershell.exe");
  assert.ok(invocation.args.includes("-ValidateDefinition"));
  assert.equal(invocation.args.includes("-Operation"), false);
  assert.equal(invocation.args.some((argument) => /Register-ScheduledTask/.test(argument)), false);
});

test("read-only native status requires the manager and creates no isolated state", async (t) => {
  const files = fixture(t);
  const home = path.join(files.root, "missing-home");
  const runner = (command, args) => {
    if (command === "launchctl" && args[0] === "print" && args[1].startsWith("gui/")) {
      return result(args[1].endsWith(`/${installer.SERVICE_LABEL}`) ? 1 : 0);
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  assert.equal(await smoke.validateUnixManagerStatus({
    platform: "darwin",
    uid: 501,
    home,
    nodePath: files.nodePath,
    serverPath: files.serverPath,
    environmentPath: path.dirname(files.nodePath),
    runner,
  }), "not-installed");
  assert.equal(fs.existsSync(home), false);

  await assert.rejects(smoke.validateUnixManagerStatus({
    platform: "linux",
    uid: 1000,
    home,
    nodePath: files.nodePath,
    serverPath: files.serverPath,
    environmentPath: path.dirname(files.nodePath),
    runner: () => result(1, "", "no user bus"),
  }), /systemd user manager is unavailable/);
});

test("native validator rejects malformed output and unsupported platforms", async (t) => {
  const files = fixture(t);
  assert.throws(
    () => smoke.parseSingleJsonLine("{}\n{}\n", "test validator"),
    /exactly one JSON line/,
  );
  assert.throws(
    () => smoke.requireSuccessfulCommand(result(1, "", "native failure"), "validator"),
    /native failure/,
  );
  await assert.rejects(
    smoke.runNativeServiceSmoke({
      platform: "freebsd",
      nodePath: files.nodePath,
      serverPath: files.serverPath,
      expectedVersion: "0.0.1",
      runner: () => result(),
    }),
    /Unsupported native service smoke platform/,
  );
});
