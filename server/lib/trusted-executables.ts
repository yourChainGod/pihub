import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

function environmentValue(
  source: EnvironmentSource,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return source[name];
  const key = Object.keys(source).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key ? source[key] : undefined;
}

function absoluteEnvironmentDirectory(
  source: EnvironmentSource,
  name: string,
  platform: NodeJS.Platform,
): string | null {
  const value = environmentValue(source, name, platform)?.trim();
  if (!value || value.includes("\0")) return null;
  return platform === "win32" ? (path.win32.isAbsolute(value) ? value : null) : (path.isAbsolute(value) ? value : null);
}

/** Final executable must be a regular file, never a PATH-resolved shim or symlink. */
export function trustedRegularExecutable(candidate: string, platform = process.platform): string | null {
  if (!(platform === "win32" ? path.win32.isAbsolute(candidate) : path.isAbsolute(candidate))) return null;
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function uniqueCandidates(candidates: readonly string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function windowsSystemDrive(source: EnvironmentSource): string | null {
  for (const name of ["SystemRoot", "WINDIR"]) {
    const directory = absoluteEnvironmentDirectory(source, name, "win32");
    if (!directory) continue;
    const normalized = path.win32.normalize(directory);
    const parsed = path.win32.parse(normalized);
    if (!/^[A-Za-z]:\\$/.test(parsed.root)) continue;
    if (path.win32.relative(parsed.root, normalized).toLowerCase() !== "windows") continue;
    return parsed.root.toUpperCase();
  }
  return null;
}

function windowsProgramFilesDirectory(
  source: EnvironmentSource,
  name: string,
  expectedName: "Program Files" | "Program Files (x86)",
  systemDrive: string,
): string | null {
  const directory = absoluteEnvironmentDirectory(source, name, "win32");
  if (!directory) return null;
  const normalized = path.win32.normalize(directory);
  const parsed = path.win32.parse(normalized);
  if (parsed.root.toUpperCase() !== systemDrive) return null;
  if (path.win32.relative(parsed.root, normalized).toLowerCase() !== expectedName.toLowerCase()) {
    return null;
  }
  return path.win32.join(systemDrive, expectedName);
}

/** Candidate generation is exported so cross-platform policy can be tested without executing it. */
export function gitExecutableCandidates(
  source: EnvironmentSource = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") {
    const systemDrive = windowsSystemDrive(source);
    if (!systemDrive) return [];
    const directories = [
      windowsProgramFilesDirectory(source, "ProgramFiles", "Program Files", systemDrive),
      windowsProgramFilesDirectory(source, "ProgramW6432", "Program Files", systemDrive),
      windowsProgramFilesDirectory(source, "ProgramFiles(x86)", "Program Files (x86)", systemDrive),
    ].filter((directory): directory is string => directory !== null);
    return uniqueCandidates(
      directories.map((directory) => path.win32.join(directory, "Git", "cmd", "git.exe")),
      platform,
    );
  }

  const candidates = ["/usr/bin/git", "/bin/git", "/usr/local/bin/git"];
  const searchPath = environmentValue(source, "PATH", platform);
  if (searchPath && !searchPath.includes("\0")) {
    for (const directory of searchPath.split(path.delimiter)) {
      // Empty entries resolve against cwd and are therefore never trusted.
      if (directory && path.isAbsolute(directory)) candidates.push(path.join(directory, "git"));
    }
  }
  return uniqueCandidates(candidates, platform);
}

function trustedUnixGitExecutable(candidate: string, platform: NodeJS.Platform): string | null {
  const executable = trustedRegularExecutable(candidate, platform);
  if (!executable) return null;

  let current = executable;
  while (true) {
    try {
      const stat = lstatSync(current);
      const isExecutable = current === executable;
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) return null;
      if (isExecutable ? !stat.isFile() : !stat.isDirectory()) return null;
    } catch {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return executable;
}

function windowsProgramFilesRoot(candidate: string): string | null {
  if (!path.win32.isAbsolute(candidate) || candidate.includes("\0")) return null;
  const normalized = path.win32.normalize(candidate);
  const parsed = path.win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/.test(parsed.root)) return null;
  const parts = path.win32.relative(parsed.root, normalized).split("\\");
  if (
    parts.length !== 4
    || !["program files", "program files (x86)"].includes(parts[0].toLowerCase())
    || parts[1].toLowerCase() !== "git"
    || parts[2].toLowerCase() !== "cmd"
    || parts[3].toLowerCase() !== "git.exe"
  ) {
    return null;
  }
  return path.win32.join(parsed.root, parts[0]);
}

function trustedWindowsGitExecutable(candidate: string): string | null {
  const programFilesRoot = windowsProgramFilesRoot(candidate);
  if (!programFilesRoot) return null;

  let current = path.win32.dirname(candidate);
  const volumeRoot = path.win32.parse(candidate).root;
  while (current.toLowerCase() !== volumeRoot.toLowerCase()) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    } catch {
      return null;
    }
    current = path.win32.dirname(current);
  }

  const executable = trustedRegularExecutable(candidate, "win32");
  if (!executable) return null;
  try {
    const realProgramFilesRoot = realpathSync(programFilesRoot);
    const relative = path.win32.relative(realProgramFilesRoot, executable);
    if (relative.startsWith("..") || path.win32.isAbsolute(relative)) return null;
  } catch {
    return null;
  }
  return executable;
}

export function resolveTrustedGitExecutable(
  source: EnvironmentSource = process.env,
  platform = process.platform,
  candidates: readonly string[] = gitExecutableCandidates(source, platform),
): string | null {
  for (const candidate of candidates) {
    const executable = platform === "win32"
      ? trustedWindowsGitExecutable(candidate)
      : trustedUnixGitExecutable(candidate, platform);
    if (executable) return executable;
  }
  return null;
}
