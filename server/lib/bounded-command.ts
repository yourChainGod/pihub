import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { boundedProcessOutput, DEFAULT_PROCESS_OUTPUT_LIMIT } from "./process-output-security";
import { isSensitiveEnvironmentName, type ProcessEnvironmentSource } from "./process-environment";
import { trustedRegularExecutable } from "./trusted-executables";

const execFileAsync = promisify(execFile);

export interface BoundedCommandOptions {
  readonly cwd?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly outputLimit?: number;
  readonly signal?: AbortSignal;
  readonly sourceEnv?: ProcessEnvironmentSource;
  readonly timeout?: number;
}

export interface BoundedCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export class BoundedCommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;

  constructor(stdout: string, stderr: string) {
    super("External command failed");
    this.name = "BoundedCommandError";
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function commandEnvironment(environment: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  for (const name of Object.keys(environment)) {
    if (isSensitiveEnvironmentName(name)) {
      throw new Error(`Sensitive environment key is not allowed for child processes: ${name}`);
    }
  }
  return { ...environment } as NodeJS.ProcessEnv;
}

function executablePath(file: string): string {
  const executable = trustedRegularExecutable(file);
  if (!executable) throw new Error("External command executable is not a trusted regular file");
  return executable;
}

export async function runBoundedCommand(
  file: string,
  args: readonly string[],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  const sourceEnv = options.sourceEnv ?? process.env;
  const outputLimit = options.outputLimit ?? DEFAULT_PROCESS_OUTPUT_LIMIT;
  try {
    const { stdout, stderr } = await execFileAsync(executablePath(file), [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: commandEnvironment(options.environment),
      maxBuffer: outputLimit,
      signal: options.signal,
      timeout: options.timeout ?? 30_000,
      windowsHide: true,
    });
    return {
      stdout: boundedProcessOutput(stdout, { limit: outputLimit, source: sourceEnv }),
      stderr: boundedProcessOutput(stderr, { limit: outputLimit, source: sourceEnv }),
    };
  } catch (error) {
    const childError = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    throw new BoundedCommandError(
      boundedProcessOutput(childError.stdout, { limit: outputLimit, source: sourceEnv }),
      boundedProcessOutput(childError.stderr, { limit: outputLimit, source: sourceEnv }),
    );
  }
}

export function runBoundedCommandSync(
  file: string,
  args: readonly string[],
  options: BoundedCommandOptions,
): BoundedCommandResult {
  const sourceEnv = options.sourceEnv ?? process.env;
  const outputLimit = options.outputLimit ?? DEFAULT_PROCESS_OUTPUT_LIMIT;
  try {
    const stdout = execFileSync(executablePath(file), [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: commandEnvironment(options.environment),
      maxBuffer: outputLimit,
      timeout: options.timeout ?? 30_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      stdout: boundedProcessOutput(stdout, { limit: outputLimit, source: sourceEnv }),
      stderr: "",
    };
  } catch (error) {
    const childError = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    throw new BoundedCommandError(
      boundedProcessOutput(childError.stdout, { limit: outputLimit, source: sourceEnv }),
      boundedProcessOutput(childError.stderr, { limit: outputLimit, source: sourceEnv }),
    );
  }
}
