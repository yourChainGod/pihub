import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

/**
 * Resolution for the Pi Agent CLI used by the components route (version probe,
 * extension listing, `pi update`).
 *
 * Packaged releases ship Pi as the pinned `@earendil-works/pi-coding-agent`
 * dependency and intentionally do NOT install a global `pi` binary, so probing
 * PATH alone makes every packaged device report "Pi Agent not found". The
 * bundled fallback runs the pinned CLI through the current Node executable.
 *
 * Priority: 1. PIHUB_PI_EXECUTABLE env, 2. global `pi` on PATH, 3. bundled CLI.
 */
export type PiCommand = {
  /** Executable passed to spawn/execFile. */
  command: string;
  /** Arguments prepended before every pi invocation (bundled CLI: node + cli.js). */
  argsPrefix: string[];
  /** Human-readable identifier for status responses. */
  display: string;
};

export type PiCommandDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  serverRoot?: string;
  execPath?: string;
  exists?: (path: string) => boolean;
  which?: (name: string) => string | null;
  bundledCandidates?: () => string[];
};

function defaultWhich(name: string, platform: NodeJS.Platform): string | null {
  try {
    const output = execFileSync(platform === "win32" ? "where" : "which", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

function defaultBundledCandidates(serverRoot: string): string[] {
  // Prefer the pinned dependency under the release root: in the packaged build
  // the SDK's getPackageDir() can resolve into the compiled .next tree.
  const candidates = [resolve(
    serverRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  )];
  try {
    candidates.push(resolve(realpathSync(getPackageDir()), "dist", "cli.js"));
  } catch {
    // SDK resolution unavailable; the release-root candidate above still applies.
  }
  return candidates;
}

export function resolvePiCommand(deps: PiCommandDeps = {}): PiCommand | null {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? existsSync;
  const which = deps.which ?? ((name: string) => defaultWhich(name, platform));

  // 1. Explicit override. A .cmd shim cannot run under execFile without a
  // shell, so accept it only on non-Windows platforms.
  const envPath = env.PIHUB_PI_EXECUTABLE?.trim();
  if (envPath && exists(envPath) && !(platform === "win32" && /\.cmd$/i.test(envPath))) {
    return { command: resolve(envPath), argsPrefix: [], display: envPath };
  }

  // 2. Global install. Skipped on Windows: `where pi` resolves to a .cmd shim
  // that execFile cannot execute without shell:true.
  if (platform !== "win32") {
    const globalPi = which("pi");
    if (globalPi && exists(globalPi)) {
      return { command: globalPi, argsPrefix: [], display: "pi" };
    }
  }

  // 3. Bundled pinned CLI, run through the current Node executable.
  const serverRoot = deps.serverRoot ?? env.PIHUB_SERVER_ROOT?.trim() ?? process.cwd();
  const bundledCandidates = deps.bundledCandidates ?? (() => defaultBundledCandidates(serverRoot));
  const bundled = bundledCandidates().find((candidate) => exists(candidate));
  if (bundled) {
    return {
      command: deps.execPath ?? process.execPath,
      argsPrefix: [bundled],
      display: "bundled",
    };
  }

  return null;
}
