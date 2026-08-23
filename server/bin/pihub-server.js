#!/usr/bin/env node
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createJiti } = require("jiti");
const { createBoundedLogStream } = require("./bounded-log");
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");
const { parseLaunchOptions } = require("./pi-web-options");
const { createServerRuntimeEnvironment } = require("./server-runtime-environment");
const { StableServerSupervisor } = require("./server-supervisor");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

const packageRoot = path.join(__dirname, "..");

function readPackageVersion() {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata?.name !== "@pihub/server" || typeof metadata.version !== "string") {
    throw new Error("PiHub Server package metadata is invalid");
  }
  return metadata.version;
}

function releaseTarget() {
  if (!new Set(["darwin", "linux", "win32"]).has(process.platform)) {
    throw new Error(`PiHub Server updates do not support platform ${process.platform}`);
  }
  if (!new Set(["arm64", "x64"]).has(process.arch)) {
    throw new Error(`PiHub Server updates do not support architecture ${process.arch}`);
  }
  return { platform: process.platform, arch: process.arch };
}

function discoverTailnetHostname(environment) {
  try {
    const status = JSON.parse(execFileSync("tailscale", ["status", "--json"], {
      encoding: "utf8",
      env: environment,
      timeout: 3_000,
      windowsHide: true,
    }));
    return String(status?.Self?.DNSName || "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

function createSupervisorLogSinks(environment) {
  const directory = environment.PIHUB_LOG_DIRECTORY;
  if (directory === undefined || directory === "") return {};
  let stdoutLogSink;
  try {
    stdoutLogSink = createBoundedLogStream({ directory, name: "server.log" });
    const stderrLogSink = createBoundedLogStream({ directory, name: "server-error.log" });
    stdoutLogSink.on("error", () => {
      console.error("PiHub Server output logging failed; continuing without persistent output logging.");
    });
    stderrLogSink.on("error", () => {
      console.error("PiHub Server error logging failed; continuing without persistent error logging.");
    });
    return { stdoutLogSink, stderrLogSink };
  } catch (error) {
    stdoutLogSink?.destroy();
    throw error;
  }
}

function createSupervisorLogger(stderrLogSink) {
  if (!stderrLogSink) return console;
  const write = (level, message) => {
    if (stderrLogSink.destroyed || stderrLogSink.writableEnded) return;
    const safeMessage = String(message).replace(/[\0\r\n]+/g, " ").slice(0, 2_000);
    stderrLogSink.write(`[supervisor:${level}] ${safeMessage}\n`);
  };
  return {
    error(message) { write("error", message); },
    warn(message) { write("warn", message); },
  };
}

async function main() {
  const { port, hostname, openBrowser: requestedOpenBrowser } = parseLaunchOptions();
  const openBrowser = process.env.PIHUB_HEADLESS === "1" ? false : requestedOpenBrowser;
  const version = readPackageVersion();
  const target = releaseTarget();
  const nextDirectory = path.join(packageRoot, ".next");
  if (!fs.existsSync(nextDirectory)) throw new Error("Build artifacts not found. Please report this issue.");

  const baseRuntimeEnvironment = createServerRuntimeEnvironment(process.env);
  const tailnetHostname = discoverTailnetHostname(baseRuntimeEnvironment);
  const jiti = createJiti(__filename, { interopDefault: true });
  const { readDefaultExtensionsSelection } = await jiti.import("../lib/default-extensions.ts");
  const { getServerUpdateDataRoot, ProductionServerUpdateRuntime } = await jiti.import("../lib/server-update-runtime.ts");
  const { loadConnectorConfig } = await jiti.import("../lib/connector.ts");
  const dataRoot = getServerUpdateDataRoot({ platform: target.platform });
  const selectedDefaultExtensions = await readDefaultExtensionsSelection(dataRoot);
  const defaultExtensionsEnabled = selectedDefaultExtensions.length > 0;
  const logSinks = createSupervisorLogSinks(process.env);

  console.log(`PiHub server is loopback-only on ${hostname}:${port}. Use 'tailscale serve' for Tailnet access; Funnel is unsupported.`);
  let supervisor;
  try {
    supervisor = new StableServerSupervisor({
      bootstrapPackageRoot: packageRoot,
      bootstrapVersion: version,
      hostname,
      port,
      openBrowser,
      tailnetHostname,
      baseRuntimeEnvironment,
      defaultExtensionsEnabled,
      selectedDefaultExtensions,
      // The relay connector only runs on hosts that opted in via
      // state/connector.json; a broken config must never block the server.
      connectorConfigured: () => {
        try {
          return loadConnectorConfig(dataRoot) !== null;
        } catch {
          return false;
        }
      },
      connectorDataRoot: dataRoot,
      ...logSinks,
      logger: createSupervisorLogger(logSinks.stderrLogSink),
      runtimeFactory: ({ health }) => new ProductionServerUpdateRuntime({
        bootstrapPackageRoot: packageRoot,
        bootstrapVersion: version,
        dataRoot,
        platform: target.platform,
        arch: target.arch,
        health,
      }),
    });
    await supervisor.start();
  } catch (error) {
    if (supervisor) {
      supervisor.logger.error("PiHub Server supervisor failed to start.");
      await supervisor.shutdown().catch(() => undefined);
    }
    else {
      logSinks.stdoutLogSink?.destroy();
      logSinks.stderrLogSink?.destroy();
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
