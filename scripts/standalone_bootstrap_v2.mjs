#!/usr/bin/env node
/**
 * PiHub Bootstrap v2.0 - Decoupled Architecture
 *
 * This script installs PiHub Server in the new decoupled architecture where:
 * 1. Pi Agent is installed separately (global or standalone)
 * 2. PiHub Server is a lightweight layer on top of Pi
 * 3. Extensions are managed by Pi's standard toolchain
 *
 * Usage:
 *   node scripts/standalone_bootstrap_v2.mjs
 *   node scripts/standalone_bootstrap_v2.mjs --pi-path /usr/local/bin/pi
 *   node scripts/standalone_bootstrap_v2.mjs --legacy  # Use old bundled mode
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { resolve, join } from "node:path";

const DEFAULT_EXTENSIONS = [
  "@cortexkit/pi-magic-context",
  "pi-todo-rail",
  "@gotgenes/pi-permission-system",
  "@eko24ive/pi-ask",
  "@gotgenes/pi-subagents",
];

// ============================================================================
// Utilities
// ============================================================================

function log(message) {
  console.log(`[bootstrap] ${message}`);
}

function error(message) {
  console.error(`[bootstrap] ERROR: ${message}`);
}

function hasCommand(cmd) {
  try {
    execFileSync(platform() === "win32" ? "where" : "which", [cmd], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function exec(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    log(`Executing: ${command} ${args.join(" ")}`);
    const proc = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with code ${code}`));
    });
    proc.on("error", reject);
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    piPath: null,
    legacy: false,
    skipPi: false,
    skipExtensions: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pi-path") {
      parsed.piPath = args[++i];
    } else if (arg === "--legacy") {
      parsed.legacy = true;
    } else if (arg === "--skip-pi") {
      parsed.skipPi = true;
    } else if (arg === "--skip-extensions") {
      parsed.skipExtensions = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`
PiHub Bootstrap v2.0 - Decoupled Architecture Installer

Usage:
  node scripts/standalone_bootstrap_v2.mjs [options]

Options:
  --pi-path <path>       Use specific Pi executable path
  --skip-pi              Skip Pi installation (assume already installed)
  --skip-extensions      Skip default extensions installation
  --legacy               Use legacy bundled mode (old architecture)
  --help, -h             Show this help message

Examples:
  # Full installation (recommended)
  node scripts/standalone_bootstrap_v2.mjs

  # Use existing Pi installation
  node scripts/standalone_bootstrap_v2.mjs --skip-pi

  # Custom Pi path
  node scripts/standalone_bootstrap_v2.mjs --pi-path /opt/pi/bin/pi

  # Legacy mode (fallback to bundled Pi)
  node scripts/standalone_bootstrap_v2.mjs --legacy
`);
}

// ============================================================================
// Step 1: Check/Install Pi Agent
// ============================================================================

async function checkPiInstallation(piPath = null) {
  if (piPath) {
    if (existsSync(piPath)) {
      log(`✓ Found Pi at custom path: ${piPath}`);
      return piPath;
    } else {
      throw new Error(`Pi not found at specified path: ${piPath}`);
    }
  }

  // Check global `pi` command
  if (hasCommand("pi")) {
    try {
      const version = execFileSync("pi", ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      log(`✓ Found global Pi: ${version}`);
      return "pi";
    } catch {
      // Fall through
    }
  }

  return null;
}

async function installPi() {
  log("📦 Installing Pi Agent...");

  if (hasCommand("npm")) {
    log("Installing Pi via npm (global)...");
    await exec("npm", ["install", "-g", "@earendil-works/pi-coding-agent@latest"]);
    log("✓ Pi Agent installed successfully");
    return "pi";
  } else {
    error("npm not found. Please install Node.js and npm first.");
    throw new Error("npm is required to install Pi Agent");
  }
}

// ============================================================================
// Step 2: Install PiHub Server
// ============================================================================

async function installPihubServer() {
  log("📦 Installing PiHub Server...");

  const serverDir = resolve(process.cwd(), "server");
  if (!existsSync(serverDir)) {
    throw new Error("Server directory not found. Please run from project root.");
  }

  log("Installing Server dependencies...");
  await exec("npm", ["install"], { cwd: serverDir });

  log("✓ PiHub Server installed successfully");
}

// ============================================================================
// Step 3: Initialize Configuration
// ============================================================================

async function initializeConfig() {
  log("⚙️  Initializing configuration...");

  const pihubDir = join(homedir(), ".pihub");
  const configDir = join(pihubDir, "config");

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  // Create default config
  const configFile = join(configDir, "server.json");
  if (!existsSync(configFile)) {
    const defaultConfig = {
      version: "2.0",
      mode: "decoupled",
      pi: {
        executable: "pi",
        ipcEnabled: true,
      },
      server: {
        port: 30141,
        hostname: "127.0.0.1",
      },
    };
    writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2));
    log(`✓ Created config file: ${configFile}`);
  }

  log("✓ Configuration initialized");
}

// ============================================================================
// Step 4: Install Default Extensions
// ============================================================================

async function installDefaultExtensions(piCommand) {
  log("🔌 Installing default extensions...");

  for (const ext of DEFAULT_EXTENSIONS) {
    try {
      log(`Installing ${ext}...`);
      await exec(piCommand, ["install", ext]);
    } catch (err) {
      error(`Failed to install ${ext}: ${err.message}`);
      log(`Continuing with remaining extensions...`);
    }
  }

  log("✓ Default extensions installed");
}

// ============================================================================
// Step 5: Configure Environment
// ============================================================================

function configureEnvironment(legacy = false) {
  log("🔧 Configuring environment...");

  const envFile = resolve(process.cwd(), "server", ".env.local");
  const envVars = [];

  if (legacy) {
    envVars.push("PIHUB_LEGACY_MODE=1");
    envVars.push("# Using legacy bundled Pi mode");
  } else {
    envVars.push("PIHUB_USE_IPC=1");
    envVars.push("# Using decoupled IPC mode (Pi runs out-of-process)");
  }

  writeFileSync(envFile, envVars.join("\n") + "\n");
  log(`✓ Environment configured: ${envFile}`);
}

// ============================================================================
// Main Bootstrap Flow
// ============================================================================

async function bootstrap() {
  console.log(`
╔════════════════════════════════════════════════════════╗
║  🚀 PiHub Bootstrap v2.0                               ║
║  Decoupled Architecture Installer                      ║
╚════════════════════════════════════════════════════════╝
`);

  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  try {
    // Step 1: Check/Install Pi
    let piCommand = null;
    if (args.legacy) {
      log("⚠️  Legacy mode: Skipping Pi installation (using bundled)");
    } else if (args.skipPi) {
      log("⚠️  Skipping Pi installation (--skip-pi)");
      piCommand = await checkPiInstallation(args.piPath);
      if (!piCommand) {
        throw new Error("Pi not found. Remove --skip-pi to install automatically.");
      }
    } else {
      piCommand = await checkPiInstallation(args.piPath);
      if (!piCommand) {
        piCommand = await installPi();
      }
    }

    // Step 2: Install PiHub Server
    await installPihubServer();

    // Step 3: Initialize Configuration
    await initializeConfig();

    // Step 4: Install Default Extensions
    if (!args.legacy && !args.skipExtensions && piCommand) {
      await installDefaultExtensions(piCommand);
    } else if (args.skipExtensions) {
      log("⚠️  Skipping extensions installation (--skip-extensions)");
    }

    // Step 5: Configure Environment
    configureEnvironment(args.legacy);

    console.log(`
╔════════════════════════════════════════════════════════╗
║  ✅ Setup Complete!                                    ║
╚════════════════════════════════════════════════════════╝

Next steps:
  1. Start PiHub Server:
     cd server && npm run dev

  2. Open desktop app and connect to localhost:30141

${args.legacy ? `
⚠️  Running in legacy mode (bundled Pi).
    Remove PIHUB_LEGACY_MODE=1 from server/.env.local to use IPC mode.
` : `
✅ Running in decoupled IPC mode.
    Pi Agent runs as a separate process.
    Update Pi: pi update --self
    Update Extensions: pi update --extensions
`}
`);
  } catch (err) {
    error(err.message);
    console.error(err);
    process.exit(1);
  }
}

// Run bootstrap
bootstrap().catch((err) => {
  error("Bootstrap failed:");
  console.error(err);
  process.exit(1);
});
