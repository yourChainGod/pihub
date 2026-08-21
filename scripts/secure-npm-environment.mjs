import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPortableBuildEnvironment } from "./build-portable-server.mjs";

const NPM_REGISTRY = "https://registry.npmjs.org/";

/**
 * Command + argv for running npm with the current Node runtime. Since the
 * CVE-2024-27980 mitigation, Node refuses to spawn `.cmd` shims without a
 * shell, so on Windows npm must be invoked through its CLI entry script
 * instead of the `npm.cmd` shim next to node.exe.
 */
export function npmSpawnInvocation(args, {
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (platform !== "win32") return { command: "npm", args };
  const npmCli = path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return { command: execPath, args: [npmCli, ...args] };
}

export function createSecureNpmEnvironment(isolationRoot, {
  execPath = process.execPath,
  platform = process.platform,
  sourceEnvironment = process.env,
  legacyPeerDeps = false,
} = {}) {
  const root = path.resolve(isolationRoot);
  const environment = createPortableBuildEnvironment(root, {
    execPath,
    platform,
    sourceEnvironment,
  });
  return {
    ...environment,
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_BIN_LINKS: "false",
    NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    NPM_CONFIG_COLOR: "false",
    NPM_CONFIG_ENGINE_STRICT: "true",
    NPM_CONFIG_FORCE: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: path.join(root, "global.npmrc"),
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_LEGACY_PEER_DEPS: legacyPeerDeps ? "true" : "false",
    NPM_CONFIG_PROVENANCE: "false",
    NPM_CONFIG_REGISTRY: NPM_REGISTRY,
    NPM_CONFIG_STRICT_SSL: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: path.join(root, "user.npmrc"),
  };
}

export function prepareSecureNpmEnvironment(prefix, options = {}) {
  if (!/^pihub-[a-z0-9-]+-$/.test(prefix)) {
    throw new Error("Secure npm environment prefix is invalid");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  try {
    for (const name of ["cache", "config", "home", "npm-cache", "tmp"]) {
      fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    }
    for (const name of ["global.npmrc", "user.npmrc"]) {
      fs.writeFileSync(path.join(root, name), "", { flag: "wx", mode: 0o600 });
    }
    return {
      environment: createSecureNpmEnvironment(root, options),
      root,
      cleanup() {
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
