import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveTrustedGitExecutable } from "./trusted-executables";

const execFileAsync = promisify(execFile);

export const GIT_COMMAND_TIMEOUT_MS = 10_000;
export const GIT_COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

const SAFE_ENVIRONMENT_KEYS = [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const;

const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "check-ref-format",
  "config",
  "diff",
  "ls-files",
  "rev-parse",
  "show-ref",
  "status",
  "worktree",
]);

type GitConfigEntry = { name: string; value: string };

export interface GitExecutionRisk {
  executableConfigKeys: string[];
  isRepository: boolean;
  requiresTrust: boolean;
}

export interface RunGitOptions {
  maxBuffer?: number;
  timeout?: number;
}

function environmentKeyMatches(
  actual: string,
  expected: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === "win32"
    ? actual.toUpperCase() === expected.toUpperCase()
    : actual === expected;
}

function nullDevice(platform: NodeJS.Platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

/**
 * Git inherits no credentials, provider keys, tracing destinations, config
 * injection variables, or loader variables from the server. Only values
 * needed by the platform runtime and temporary-file handling are retained.
 * Git itself is launched by a separately verified absolute path.
 */
export function createGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = {} as NodeJS.ProcessEnv;
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SAFE_ENVIRONMENT_KEYS.some((safeName) => environmentKeyMatches(name, safeName, platform))) {
      environment[name] = value;
    }
  }

  const disabledProgram = nullDevice(platform);
  Object.assign(environment, {
    LC_ALL: "C",
    LANG: "C",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: disabledProgram,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: disabledProgram,
    GIT_EDITOR: disabledProgram,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_SEQUENCE_EDITOR: disabledProgram,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: disabledProgram,
    PAGER: "",
  });
  return environment;
}

function parseConfigList(output: string): GitConfigEntry[] {
  return output.split("\0").flatMap((record): GitConfigEntry[] => {
    if (!record) return [];
    const separator = record.indexOf("\n");
    if (separator < 1) return [];
    return [{ name: record.slice(0, separator), value: record.slice(separator + 1) }];
  });
}

function executableConfigKind(name: string): "filter" | "diff" | "other" | null {
  const lowerName = name.toLowerCase();
  if (/^filter\..+\.(clean|smudge|process)$/.test(lowerName)) return "filter";
  if (/^diff\..+\.(command|textconv)$/.test(lowerName)) return "diff";
  if (lowerName === "diff.external" || lowerName === "core.hookspath") return "other";
  if (lowerName === "core.fsmonitor") return "other";
  return null;
}

function isExecutableConfig(entry: GitConfigEntry): boolean {
  const kind = executableConfigKind(entry.name);
  if (!kind || !entry.value.trim()) return false;
  if (entry.name.toLowerCase() === "core.fsmonitor") {
    return !/^(false|no|off|0)$/i.test(entry.value.trim());
  }
  return true;
}

function safeConfigEntries(
  discoveredEntries: readonly GitConfigEntry[],
  platform: NodeJS.Platform,
): GitConfigEntry[] {
  const entries: GitConfigEntry[] = [
    { name: "core.hooksPath", value: nullDevice(platform) },
    { name: "core.fsmonitor", value: "false" },
    { name: "core.attributesFile", value: nullDevice(platform) },
    { name: "core.excludesFile", value: nullDevice(platform) },
    { name: "core.askPass", value: "" },
    { name: "credential.helper", value: "" },
    { name: "credential.interactive", value: "false" },
    { name: "diff.external", value: "" },
    { name: "fetch.recurseSubmodules", value: "false" },
    { name: "gc.auto", value: "0" },
    { name: "maintenance.auto", value: "false" },
    { name: "protocol.allow", value: "never" },
    { name: "submodule.recurse", value: "false" },
  ];
  const seen = new Set(entries.map((entry) => `${entry.name}\0${entry.value}`));

  for (const entry of discoveredEntries) {
    const kind = executableConfigKind(entry.name);
    if (!kind) continue;
    const suffix = entry.name.lastIndexOf(".");
    const prefix = suffix < 0 ? entry.name : entry.name.slice(0, suffix);
    const overrides = kind === "filter"
      ? [
          { name: `${prefix}.clean`, value: "" },
          { name: `${prefix}.smudge`, value: "" },
          { name: `${prefix}.process`, value: "" },
          { name: `${prefix}.required`, value: "false" },
        ]
      : kind === "diff"
        ? [
            { name: `${prefix}.command`, value: "" },
            { name: `${prefix}.textconv`, value: "" },
          ]
        : [];
    for (const override of overrides) {
      const key = `${override.name}\0${override.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push(override);
      }
    }
  }
  return entries;
}

function withCommandConfig(
  environment: NodeJS.ProcessEnv,
  entries: readonly GitConfigEntry[],
): NodeJS.ProcessEnv {
  const configured = {
    ...environment,
    GIT_CONFIG_COUNT: String(entries.length),
  } as NodeJS.ProcessEnv;
  entries.forEach((entry, index) => {
    configured[`GIT_CONFIG_KEY_${index}`] = entry.name;
    configured[`GIT_CONFIG_VALUE_${index}`] = entry.value;
  });
  return configured;
}

function trustedGitExecutable(): string {
  const executable = resolveTrustedGitExecutable();
  if (!executable) throw new Error("Trusted Git executable is unavailable");
  return executable;
}

async function readEffectiveConfig(
  cwd: string,
  options: RunGitOptions,
  executable = trustedGitExecutable(),
): Promise<GitConfigEntry[]> {
  const { stdout } = await execFileAsync(
    executable,
    ["--no-pager", "-C", cwd, "config", "--includes", "--null", "--list"],
    {
      env: createGitEnvironment(),
      maxBuffer: options.maxBuffer ?? GIT_COMMAND_MAX_BUFFER,
      timeout: options.timeout ?? GIT_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  return parseConfigList(stdout);
}

/** Execute a local Git command with repository-controlled execution disabled. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<string> {
  const subcommand = args[0];
  if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`Git subcommand is not allowed: ${subcommand ?? "<missing>"}`);
  }
  if (subcommand === "diff" && args.some((arg) => arg === "--ext-diff" || arg === "--textconv")) {
    throw new Error("Executable Git diff drivers are not allowed");
  }
  const protectedArgs = subcommand === "diff"
    ? [
        subcommand,
        ...(!args.includes("--no-ext-diff") ? ["--no-ext-diff"] : []),
        ...(!args.includes("--no-textconv") ? ["--no-textconv"] : []),
        ...args.slice(1),
      ]
    : [...args];
  const executable = trustedGitExecutable();
  const discoveredEntries = await readEffectiveConfig(cwd, options, executable);
  const environment = withCommandConfig(
    createGitEnvironment(),
    safeConfigEntries(discoveredEntries, process.platform),
  );
  const { stdout } = await execFileAsync(executable, ["--no-pager", "-C", cwd, ...protectedArgs], {
    env: environment,
    maxBuffer: options.maxBuffer ?? GIT_COMMAND_MAX_BUFFER,
    timeout: options.timeout ?? GIT_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
}

/** Names only: values may contain secrets or commands and must not cross APIs. */
export async function inspectGitExecutionRisk(cwd: string): Promise<GitExecutionRisk> {
  const entries = await readEffectiveConfig(cwd, {});
  const executableConfigKeys = Array.from(new Set(
    entries.filter(isExecutableConfig).map((entry) => entry.name),
  )).sort((left, right) => left.localeCompare(right));
  let isRepository = false;
  try {
    await runGit(cwd, ["rev-parse", "--git-dir"]);
    isRepository = true;
  } catch {
    // `git config` is valid outside a repository; rev-parse is authoritative.
  }
  return {
    executableConfigKeys,
    isRepository,
    requiresTrust: executableConfigKeys.length > 0,
  };
}
