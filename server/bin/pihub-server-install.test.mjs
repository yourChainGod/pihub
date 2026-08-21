import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const installer = require("./pihub-server-install.js");
const thisFile = fileURLToPath(import.meta.url);

function commandResult(status = 0, stderr = "", stdout = "") {
  return { status, stderr, stdout };
}

function healthResponse(version = "0.0.1", status = "ok") {
  return new Response(JSON.stringify({ status, version }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function createFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-installer-"));
  const runtimeDirectory = path.join(home, "runtime with spaces");
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const nodePath = path.join(runtimeDirectory, "node");
  const serverPath = path.join(runtimeDirectory, "pi web.js");
  fs.writeFileSync(nodePath, "node");
  fs.writeFileSync(serverPath, "server");
  fs.writeFileSync(path.join(home, "package.json"), JSON.stringify({ version: "0.0.1" }));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { expectedVersion: "0.0.1", home, nodePath, serverPath };
}

test("importing the installer exposes helpers without executing installation", () => {
  assert.equal(typeof installer.installPersistentService, "function");
  assert.equal(typeof installer.renderSystemdUnit, "function");
});

test("root is rejected before the installer creates files or runs commands", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-installer-root-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let commandCount = 0;

  await assert.rejects(
    installer.installPersistentService({
      platform: "linux",
      uid: 0,
      home,
      nodePath: process.execPath,
      serverPath: thisFile,
      runner: () => {
        commandCount += 1;
        return commandResult();
      },
    }),
    /Do not run this installer with sudo or as root/,
  );

  assert.equal(commandCount, 0);
  assert.equal(fs.existsSync(path.join(home, ".config")), false);
  assert.equal(fs.existsSync(path.join(home, ".local")), false);

  // The explicit desktop-confirmed gate lifts the rejection.
  process.env.PIHUB_ALLOW_ROOT = "1";
  t.after(() => { delete process.env.PIHUB_ALLOW_ROOT; });
  const fixture = createFixture(t);
  let activeProbeCount = 0;
  const runner = (command, args) => {
    if (command === "systemctl" && args.includes("is-enabled")) return commandResult(1);
    if (command === "systemctl" && args.includes("is-active")) {
      activeProbeCount += 1;
      return commandResult(activeProbeCount === 1 ? 1 : 0);
    }
    return commandResult();
  };
  await installer.installPersistentService({
    platform: "linux",
    uid: 0,
    ...fixture,
    runner,
    healthCheck: async () => {},
  });
  assert.ok(fs.existsSync(path.join(fixture.home, ".config", "systemd", "user")), "root install with the gate should create the user unit directory");
});

test("launchd XML escapes every dynamic value and applies a private umask", () => {
  const plist = installer.renderLaunchAgent({
    nodePath: "/Users/a & b/<node>",
    serverPath: "/Users/a & b/pi \"server\".js",
    logDirectory: "/Users/a & b/logs",
    environmentPath: "/tmp/a&b:/usr/bin",
  });

  assert.match(plist, /a &amp; b/);
  assert.match(plist, /&lt;node&gt;/);
  assert.match(plist, /pi &quot;server&quot;\.js/);
  assert.doesNotMatch(plist, /<string>\/Users\/a & b/);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.match(plist, /<string>--hostname<\/string><string>127\.0\.0\.1<\/string>/);
  assert.match(plist, /<key>PIHUB_LOG_DIRECTORY<\/key><string>\/Users\/a &amp; b\/logs<\/string>/);
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/dev\/null<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key><string>\/dev\/null<\/string>/);
  if (process.platform === "darwin") {
    const lint = spawnSync("plutil", ["-lint", "-"], { input: plist, encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stderr);
  }
});

test("systemd unit quotes paths without allowing directive or specifier injection", () => {
  const unit = installer.renderSystemdUnit({
    nodePath: "/home/pi user/$runtime/%n/node",
    serverPath: "/home/pi user/app\nUser=root/pi \"web\".js",
    logDirectory: "/home/pi user/logs",
    environmentPath: ".:relative:/safe\nbad:/home/pi user/bin:/usr/bin",
  });

  const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
  assert.match(execStart, /\$\$runtime/);
  assert.match(execStart, /%%n/);
  assert.match(execStart, /\\nUser=root/);
  assert.match(execStart, /\\"web\\"/);
  assert.doesNotMatch(unit, /\nUser=root\n/);
  assert.doesNotMatch(unit, /WantedBy=multi-user\.target/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /Environment="PIHUB_LOG_DIRECTORY=\/home\/pi user\/logs"/);
  assert.match(unit, /StandardOutput=journal/);
  assert.match(unit, /StandardError=journal/);
  assert.match(unit, /SyslogIdentifier=pihub-server/);
  assert.doesNotMatch(unit, /append:/);
  assert.doesNotMatch(unit, /relative|safe\\nbad/);
});

test("private installer directories and logs are tightened on existing paths", (t) => {
  if (process.platform === "win32") t.skip("POSIX mode bits are not meaningful on Windows");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-installer-mode-"));
  const log = path.join(directory, "server.log");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.chmodSync(directory, 0o755);
  fs.writeFileSync(log, "old", { mode: 0o644 });

  installer.ensurePrivateDirectory(directory);
  installer.ensurePrivateLogFile(log);

  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
});

test("launchd validation failure leaves the loaded old service and plist untouched", async (t) => {
  const fixture = createFixture(t);
  const agents = path.join(fixture.home, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const plistPath = path.join(agents, `${installer.SERVICE_LABEL}.plist`);
  fs.writeFileSync(plistPath, "old plist", { mode: 0o600 });
  const calls = [];

  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === "plutil") return commandResult(1, "invalid candidate");
    return commandResult();
  };

  await assert.rejects(
    installer.installPersistentService({
      platform: "darwin",
      uid: 501,
      ...fixture,
      runner,
      healthCheck: async () => {},
    }),
    /generated launchd configuration is invalid/,
  );

  assert.equal(fs.readFileSync(plistPath, "utf8"), "old plist");
  assert.equal(calls.some((call) => call.includes("bootout")), false);
  assert.equal(calls.some((call) => call.includes("bootstrap")), false);
});

test("launchd registration failure atomically restores and restarts the old service", async (t) => {
  const fixture = createFixture(t);
  const agents = path.join(fixture.home, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const plistPath = path.join(agents, `${installer.SERVICE_LABEL}.plist`);
  fs.writeFileSync(plistPath, "old plist", { mode: 0o640 });
  const calls = [];
  let bootstrapCount = 0;
  let serviceLoaded = true;

  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === "launchctl" && args[0] === "print" && args[1].endsWith(`/${installer.SERVICE_LABEL}`)) {
      return commandResult(serviceLoaded ? 0 : 1);
    }
    if (command === "launchctl" && args[0] === "bootout") {
      serviceLoaded = false;
      return commandResult();
    }
    if (command === "launchctl" && args[0] === "bootstrap") {
      bootstrapCount += 1;
      if (bootstrapCount === 1) return commandResult(1, "candidate rejected");
      serviceLoaded = true;
      return commandResult();
    }
    return commandResult();
  };

  await assert.rejects(
    installer.installPersistentService({
      platform: "darwin",
      uid: 501,
      ...fixture,
      runner,
      healthCheck: async () => {},
    }),
    /Could not register the PiHub launch agent/,
  );

  assert.equal(fs.readFileSync(plistPath, "utf8"), "old plist");
  assert.equal(fs.statSync(plistPath).mode & 0o777, 0o640);
  assert.equal(bootstrapCount, 2);
  const validationIndex = calls.findIndex((call) => call[0] === "plutil");
  const stopIndex = calls.findIndex((call) => call.includes("bootout"));
  assert.ok(validationIndex >= 0 && stopIndex > validationIndex);
});

test("launchd stop failure restores the plist without double-registering the still-loaded old service", async (t) => {
  const fixture = createFixture(t);
  const agents = path.join(fixture.home, "Library", "LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  const plistPath = path.join(agents, `${installer.SERVICE_LABEL}.plist`);
  fs.writeFileSync(plistPath, "old plist", { mode: 0o600 });
  let bootstrapCount = 0;

  const runner = (command, args) => {
    if (command === "launchctl" && args[0] === "bootout") return commandResult(1, "still loaded");
    if (command === "launchctl" && args[0] === "bootstrap") bootstrapCount += 1;
    return commandResult();
  };

  await assert.rejects(
    installer.installPersistentService({
      platform: "darwin",
      uid: 501,
      ...fixture,
      runner,
      healthCheck: async () => {},
    }),
    /Could not stop the previous PiHub launch agent/,
  );

  assert.equal(fs.readFileSync(plistPath, "utf8"), "old plist");
  assert.equal(bootstrapCount, 0);
});

test("a fresh launchd candidate that cannot be unloaded is reported as an incomplete rollback", async (t) => {
  const fixture = createFixture(t);
  let serviceLoaded = false;

  const runner = (command, args) => {
    if (command === "launchctl" && args[0] === "print" && args[1].endsWith(`/${installer.SERVICE_LABEL}`)) {
      return commandResult(serviceLoaded ? 0 : 1);
    }
    if (command === "launchctl" && args[0] === "bootstrap") {
      serviceLoaded = true;
      return commandResult();
    }
    if (command === "launchctl" && args[0] === "kickstart") return commandResult(1, "start failed");
    if (command === "launchctl" && args[0] === "bootout") return commandResult(1, "still loaded");
    return commandResult();
  };

  await assert.rejects(
    installer.installPersistentService({
      platform: "darwin",
      uid: 501,
      ...fixture,
      runner,
      healthCheck: async () => {},
    }),
    /Rollback also reported: The failed candidate launch agent could not be unloaded/,
  );

  const plistPath = path.join(fixture.home, "Library", "LaunchAgents", `${installer.SERVICE_LABEL}.plist`);
  assert.equal(fs.existsSync(plistPath), false);
});

test("systemd health failure restores the prior unit and service state", async (t) => {
  const fixture = createFixture(t);
  const units = path.join(fixture.home, ".config", "systemd", "user");
  fs.mkdirSync(units, { recursive: true });
  const unitPath = path.join(units, installer.SYSTEMD_UNIT);
  fs.writeFileSync(unitPath, "old unit", { mode: 0o640 });
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    return commandResult();
  };

  await assert.rejects(
    installer.installPersistentService({
      platform: "linux",
      uid: 1000,
      ...fixture,
      runner,
      healthCheck: async () => { throw new Error("health failed"); },
    }),
    /health failed/,
  );

  assert.equal(fs.readFileSync(unitPath, "utf8"), "old unit");
  assert.equal(fs.statSync(unitPath).mode & 0o777, 0o640);
  assert.equal(calls.filter((call) => call.includes("daemon-reload")).length, 2);
  assert.equal(calls.filter((call) => call.includes("enable")).length, 2);
  assert.equal(calls.filter((call) => call.includes("restart")).length, 2);
  assert.equal(calls.filter((call) => call.includes("stop")).length, 1);
  assert.equal(calls.every((call) => call.includes("--user")), true);
});

test("a successful Linux install writes only a private current-user unit", async (t) => {
  const fixture = createFixture(t);
  let activeProbeCount = 0;
  const runner = (command, args) => {
    if (command === "systemctl" && args.includes("is-enabled")) return commandResult(1);
    if (command === "systemctl" && args.includes("is-active")) {
      activeProbeCount += 1;
      return commandResult(activeProbeCount === 1 ? 1 : 0);
    }
    return commandResult();
  };

  await installer.installPersistentService({
    platform: "linux",
    uid: 1000,
    ...fixture,
    runner,
    healthCheck: async () => {},
  });

  const unitPath = path.join(fixture.home, ".config", "systemd", "user", installer.SYSTEMD_UNIT);
  const unit = fs.readFileSync(unitPath, "utf8");
  assert.equal(fs.statSync(unitPath).mode & 0o777, 0o600);
  assert.doesNotMatch(unit, /User=root|multi-user\.target|\/etc\/systemd/);
  assert.match(unit, /--hostname" "127\.0\.0\.1" "--port" "30141"/);
});

test("systemd refuses to shadow an active or enabled unit from another search path", async (t) => {
  const fixture = createFixture(t);
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === "systemctl" && args.includes("is-enabled")) return commandResult();
    if (command === "systemctl" && args.includes("is-active")) return commandResult(1);
    return commandResult();
  };

  await assert.rejects(
    installer.installPersistentService({
      platform: "linux",
      uid: 1000,
      ...fixture,
      runner,
      healthCheck: async () => {},
    }),
    /already loaded from another unit path/,
  );

  const mutatingActions = new Set(["daemon-reload", "enable", "restart", "stop"]);
  assert.equal(calls.some((call) => mutatingActions.has(call[2])), false);
  const unitPath = path.join(fixture.home, ".config", "systemd", "user", installer.SYSTEMD_UNIT);
  assert.equal(fs.existsSync(unitPath), false);
});

test("Windows dispatch uses a structured PowerShell argv", async (t) => {
  const fixture = createFixture(t);
  const calls = [];
  await installer.installPersistentService({
    platform: "win32",
    uid: undefined,
    ...fixture,
    runner: (command, args) => {
      calls.push({ command, args });
      return commandResult();
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(calls[0].args.slice(-8), [
    "-NodePath",
    fixture.nodePath,
    "-ServerPath",
    fixture.serverPath,
    "-ExpectedVersion",
    fixture.expectedVersion,
    "-Operation",
    "install",
  ]);
  assert.equal(calls[0].args.includes("cmd.exe"), false);
});

test("Windows task script validates a candidate and can restore exported XML", () => {
  const source = fs.readFileSync(new URL("./pihub-server-install-windows.ps1", import.meta.url), "utf8");
  assert.match(source, /ConvertTo-WindowsCommandLineArgument/);
  assert.match(source, /\$isDriveAbsolute/);
  assert.match(source, /\$isUncAbsolute/);
  assert.match(source, /\$isExtendedDriveAbsolute/);
  assert.match(source, /\$isExtendedUncAbsolute/);
  assert.match(source, /-not \(\$isDriveAbsolute -or \$isUncAbsolute -or \$isExtendedDriveAbsolute -or \$isExtendedUncAbsolute\)/);
  assert.doesNotMatch(source, /IsPathRooted/);
  assert.doesNotMatch(source, /IsPathFullyQualified/);
  assert.match(source, /-LogonType Interactive -RunLevel Limited/);
  assert.match(source, /\[switch\]\$ValidateDefinition/);
  assert.match(source, /command = "validate-definition"/);
  assert.match(source, /aclValidated = \$true/);
  assert.match(source, /registered = \$false/);
  assert.match(source, /New-PiHubTaskComponents/);
  assert.match(source, /Register-ScheduledTask -TaskName \$validationTaskName -InputObject \$validationDefinition/);
  assert.match(source, /Export-ScheduledTask -TaskName \$taskName/);
  assert.match(source, /Register-ScheduledTask -TaskName \$taskName -Xml \$previousXml -Force/);
  assert.match(source, /ValidateSet\("install", "status", "repair", "logs", "uninstall"\)/);
  assert.match(source, /\$Operation -eq "status"/);
  assert.match(source, /\$Operation -eq "logs"/);
  assert.match(source, /\$Operation -eq "uninstall"/);
  assert.match(source, /Unregister-ScheduledTask -TaskName \$taskName -Confirm:\$false/);
  assert.match(source, /dataRetained = \$true/);
  assert.match(source, /ConvertTo-Json -Compress/);
  assert.match(source, /& \$nodeFile @serverArguments/);
  assert.match(source, /\$env:PIHUB_LOG_DIRECTORY = \$logDirectory/);
  assert.match(source, /1>\$null 2>\$null/);
  assert.doesNotMatch(source, /Rotate-PrivateLog|1>>|2>>/);
  assert.match(source, /\$version -ne \$ExpectedVersion/);
  assert.doesNotMatch(source, /cmd\.exe|schtasks\.exe/i);
});

test("service CLI accepts the five lifecycle commands and preserves no-argument install", () => {
  assert.equal(installer.parseServiceCommand([]), "install");
  for (const command of ["install", "status", "repair", "logs", "uninstall"]) {
    assert.equal(installer.parseServiceCommand([command]), command);
  }
  assert.equal(installer.parseServiceCommand(["--help"]), "help");
  assert.throws(() => installer.parseServiceCommand(["delete-data"]), /Usage:/);
  assert.throws(() => installer.parseServiceCommand(["status", "extra"]), /Usage:/);
  assert.match(installer.serviceUsage(), /data and credentials are retained/);
});

test("macOS status is structured and repeated install is a no-op when the exact service is ready", async (t) => {
  const fixture = createFixture(t);
  const environmentPath = "/usr/bin";
  const agents = path.join(fixture.home, "Library", "LaunchAgents");
  const logDirectory = path.join(fixture.home, ".local", "state", "pihub");
  fs.mkdirSync(agents, { recursive: true });
  const definitionPath = path.join(agents, `${installer.SERVICE_LABEL}.plist`);
  fs.writeFileSync(definitionPath, installer.renderLaunchAgent({
    nodePath: fixture.nodePath,
    serverPath: fixture.serverPath,
    logDirectory,
    environmentPath,
  }));
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    return commandResult();
  };
  const options = {
    platform: "darwin",
    uid: 501,
    ...fixture,
    environmentPath,
    runner,
    fetchImpl: async () => healthResponse(),
  };

  const status = await installer.getPersistentServiceStatus(options);
  assert.deepEqual(status, {
    schemaVersion: 1,
    command: "status",
    platform: "darwin",
    service: installer.SERVICE_LABEL,
    state: "ready",
    installed: true,
    configured: true,
    definitionSafe: true,
    managerAvailable: true,
    active: true,
    enabled: true,
    healthy: true,
    healthReason: null,
    version: fixture.expectedVersion,
    expectedVersion: fixture.expectedVersion,
    ready: true,
  });

  const result = await installer.runPersistentServiceCommand({ command: "install", ...options });
  assert.equal(result.changed, false);
  assert.equal(calls.some((call) => call.includes("bootout") || call.includes("bootstrap")), false);
});

test("repair replaces a ready macOS definition and verifies the restarted service", async (t) => {
  const fixture = createFixture(t);
  const environmentPath = "/usr/bin";
  const agents = path.join(fixture.home, "Library", "LaunchAgents");
  const logDirectory = path.join(fixture.home, ".local", "state", "pihub");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, `${installer.SERVICE_LABEL}.plist`), installer.renderLaunchAgent({
    nodePath: fixture.nodePath,
    serverPath: fixture.serverPath,
    logDirectory,
    environmentPath,
  }));
  let loaded = true;
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (command === "launchctl" && args[0] === "print" && args[1].endsWith(`/${installer.SERVICE_LABEL}`)) {
      return commandResult(loaded ? 0 : 1);
    }
    if (command === "launchctl" && args[0] === "bootout") loaded = false;
    if (command === "launchctl" && args[0] === "bootstrap") loaded = true;
    return commandResult();
  };

  const result = await installer.runPersistentServiceCommand({
    command: "repair",
    platform: "darwin",
    uid: 501,
    ...fixture,
    environmentPath,
    runner,
    healthCheck: async () => {},
    fetchImpl: async () => healthResponse(),
  });

  assert.equal(result.changed, true);
  assert.equal(result.ready, true);
  assert.ok(calls.some((call) => call.includes("bootout")));
  assert.ok(calls.some((call) => call.includes("bootstrap")));
});

test("Linux status and logs report only bounded current-user service metadata", async (t) => {
  const fixture = createFixture(t);
  const environmentPath = "/usr/bin";
  const units = path.join(fixture.home, ".config", "systemd", "user");
  const logDirectory = path.join(fixture.home, ".local", "state", "pihub");
  fs.mkdirSync(units, { recursive: true });
  fs.writeFileSync(path.join(units, installer.SYSTEMD_UNIT), installer.renderSystemdUnit({
    nodePath: fixture.nodePath,
    serverPath: fixture.serverPath,
    logDirectory,
    environmentPath,
  }));
  const status = await installer.getPersistentServiceStatus({
    platform: "linux",
    uid: 1000,
    ...fixture,
    environmentPath,
    runner: () => commandResult(),
    fetchImpl: async () => healthResponse(),
  });
  assert.equal(status.ready, true);
  assert.equal(status.service, installer.SYSTEMD_UNIT);
  assert.equal(Object.hasOwn(status, "definitionPath"), false);

  const logs = await installer.getPersistentServiceLogs({
    platform: "linux",
    uid: 1000,
    home: fixture.home,
  });
  assert.deepEqual(logs, {
    schemaVersion: 1,
    command: "logs",
    platform: "linux",
    stdout: path.join(logDirectory, "server.log"),
    stderr: path.join(logDirectory, "server-error.log"),
    maxBytes: 5 * 1024 * 1024,
    backups: 1,
    retainedOnUninstall: true,
  });
  assert.equal(fs.existsSync(logDirectory), false, "logs is read-only and must not create state");
});

test("macOS uninstall is idempotent and retains logs and user data", async (t) => {
  const fixture = createFixture(t);
  const agents = path.join(fixture.home, "Library", "LaunchAgents");
  const definitionPath = path.join(agents, `${installer.SERVICE_LABEL}.plist`);
  const stateDirectory = path.join(fixture.home, ".local", "state", "pihub");
  fs.mkdirSync(agents, { recursive: true });
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(definitionPath, "installed definition");
  fs.writeFileSync(path.join(stateDirectory, "user-data"), "retain");
  let loaded = true;
  const runner = (command, args) => {
    if (command === "launchctl" && args[0] === "print" && args[1].endsWith(`/${installer.SERVICE_LABEL}`)) {
      return commandResult(loaded ? 0 : 1);
    }
    if (command === "launchctl" && args[0] === "bootout") loaded = false;
    return commandResult();
  };

  assert.equal(await installer.uninstallPersistentService({
    platform: "darwin",
    uid: 501,
    home: fixture.home,
    runner,
  }), true);
  assert.equal(fs.existsSync(definitionPath), false);
  assert.equal(fs.readFileSync(path.join(stateDirectory, "user-data"), "utf8"), "retain");
  assert.equal(await installer.uninstallPersistentService({
    platform: "darwin",
    uid: 501,
    home: fixture.home,
    runner,
  }), false);
});

test("macOS uninstall restores the definition and running service on post-remove failure", async (t) => {
  const fixture = createFixture(t);
  const agents = path.join(fixture.home, "Library", "LaunchAgents");
  const definitionPath = path.join(agents, `${installer.SERVICE_LABEL}.plist`);
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(definitionPath, "previous definition", { mode: 0o640 });
  let serviceProbe = 0;
  let bootstrapCount = 0;
  const runner = (command, args) => {
    if (command === "launchctl" && args[0] === "print" && args[1].endsWith(`/${installer.SERVICE_LABEL}`)) {
      serviceProbe += 1;
      return commandResult(serviceProbe <= 2 ? 0 : 1);
    }
    if (command === "launchctl" && args[0] === "bootstrap") bootstrapCount += 1;
    return commandResult();
  };

  await assert.rejects(installer.uninstallPersistentService({
    platform: "darwin",
    uid: 501,
    home: fixture.home,
    runner,
  }), /still loaded after uninstall/);
  assert.equal(fs.readFileSync(definitionPath, "utf8"), "previous definition");
  assert.equal(fs.statSync(definitionPath).mode & 0o777, 0o640);
  assert.equal(bootstrapCount, 1);
});

test("Linux uninstall removes only the user unit and restores it if daemon reload fails", async (t) => {
  const fixture = createFixture(t);
  const units = path.join(fixture.home, ".config", "systemd", "user");
  const definitionPath = path.join(units, installer.SYSTEMD_UNIT);
  const retained = path.join(fixture.home, ".local", "share", "pihub", "credentials-retained");
  fs.mkdirSync(units, { recursive: true });
  fs.mkdirSync(path.dirname(retained), { recursive: true });
  fs.writeFileSync(definitionPath, "previous unit", { mode: 0o640 });
  fs.writeFileSync(retained, "retain");
  let active = true;
  let enabled = true;
  let reloadCount = 0;
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args.includes("is-active")) return commandResult(active ? 0 : 1);
    if (args.includes("is-enabled")) return commandResult(enabled ? 0 : 1);
    if (args.includes("stop")) active = false;
    if (args.includes("disable")) enabled = false;
    if (args.includes("enable")) enabled = true;
    if (args.includes("restart")) active = true;
    if (args.includes("daemon-reload")) {
      reloadCount += 1;
      if (reloadCount === 1) return commandResult(1, "reload failed");
    }
    return commandResult();
  };

  await assert.rejects(installer.uninstallPersistentService({
    platform: "linux",
    uid: 1000,
    home: fixture.home,
    runner,
  }), /reload systemd after uninstall/);
  assert.equal(fs.readFileSync(definitionPath, "utf8"), "previous unit");
  assert.equal(fs.statSync(definitionPath).mode & 0o777, 0o640);
  assert.equal(active, true);
  assert.equal(enabled, true);
  assert.equal(fs.readFileSync(retained, "utf8"), "retain");
  assert.ok(calls.some((call) => call.includes("restart")));
});

test("Windows lifecycle operations use structured PowerShell results", async (t) => {
  const fixture = createFixture(t);
  const operations = [];
  const runner = (command, args) => {
    assert.equal(command, "powershell.exe");
    const operation = args[args.indexOf("-Operation") + 1];
    operations.push(operation);
    const body = operation === "status"
      ? {
          schemaVersion: 1,
          command: "status",
          platform: "win32",
          state: "not-installed",
          installed: false,
          ready: false,
        }
      : operation === "logs"
        ? { schemaVersion: 1, command: "logs", platform: "win32", retainedOnUninstall: true }
        : { schemaVersion: 1, command: "uninstall", platform: "win32", state: "removed", removed: false, dataRetained: true };
    return commandResult(operation === "status" ? 3 : 0, "", `${JSON.stringify(body)}\r\n`);
  };

  const status = await installer.getPersistentServiceStatus({ platform: "win32", ...fixture, runner });
  const logs = await installer.getPersistentServiceLogs({ platform: "win32", ...fixture, runner });
  const removed = await installer.uninstallPersistentService({ platform: "win32", ...fixture, runner });
  assert.equal(status.ready, false);
  assert.equal(logs.retainedOnUninstall, true);
  assert.equal(removed, false);
  assert.deepEqual(operations, ["status", "logs", "uninstall"]);
});

test("health check accepts only the expected bounded local contract", async () => {
  let requestedUrl;
  await installer.waitForHealth({
    expectedVersion: "0.0.1",
    timeoutMs: 50,
    retryDelayMs: 1,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return healthResponse();
    },
  });
  assert.equal(requestedUrl, installer.HEALTH_URL);

  await assert.rejects(
    installer.waitForHealth({
      expectedVersion: "0.0.1",
      timeoutMs: 5,
      retryDelayMs: 1,
      fetchImpl: async () => healthResponse("0.0.1", "wrong"),
    }),
    /did not pass its local health check/,
  );

  await assert.rejects(
    installer.waitForHealth({
      expectedVersion: "0.0.1",
      timeoutMs: 5,
      retryDelayMs: 1,
      fetchImpl: async () => healthResponse("0.0.2"),
    }),
    /expected PiHub server version/,
  );

  const oversized = await installer.probeHealth({
    expectedVersion: "0.0.1",
    fetchImpl: async () => new Response(JSON.stringify({
      status: "ok",
      version: "0.0.1",
      padding: "x".repeat(8 * 1024),
    }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  });
  assert.deepEqual(oversized, {
    healthy: false,
    reason: "unreachable",
    version: null,
  });
});

test("installer reads an exact release version from regular package metadata", (t) => {
  const fixture = createFixture(t);
  assert.equal(installer.readExpectedServerVersion(fixture.serverPath), fixture.expectedVersion);

  fs.writeFileSync(path.join(fixture.home, "package.json"), JSON.stringify({ version: "private/path" }));
  assert.throws(
    () => installer.readExpectedServerVersion(fixture.serverPath),
    /valid release version/,
  );
});
