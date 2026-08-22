const PORTABLE_EXECUTION_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "USER",
  "LOGNAME",
  "USERNAME",
  "SHELL",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
] as const;

const WINDOWS_EXECUTION_ENVIRONMENT_KEYS = [
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
] as const;

export type ProcessEnvironmentSource = Readonly<Record<string, string | undefined>>;

export interface MinimalProcessEnvironmentOptions {
  additionalAllowedKeys?: readonly string[];
  overrides?: ProcessEnvironmentSource;
  platform?: NodeJS.Platform;
}

function comparableEnvironmentName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

/**
 * This deny layer protects future allow-list additions from accidentally
 * exposing credentials. The allow-list remains the primary boundary.
 */
export function isSensitiveEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized === "PORT"
    || normalized === "NODE_ENV"
    || normalized === "PI_WEB_PASSWORD"
    || normalized === "PIHUB_SERVER_PASSWORD"
    || normalized.startsWith("NEXT_")
    || normalized.startsWith("PIHUB_AUTH")
    || normalized === "API_KEY"
    || normalized.endsWith("_API_KEY")
    || normalized === "TOKEN"
    || normalized.endsWith("_TOKEN")
    || normalized.includes("PROXY")
    || /(?:^|_)(?:API_KEY|AUTH(?:ORIZATION)?|COOKIE|CREDENTIALS?|PASS(?:WORD|WD|PHRASE)?|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/.test(normalized);
}

function isLocaleEnvironmentName(name: string, platform: NodeJS.Platform): boolean {
  const comparableName = comparableEnvironmentName(name, platform);
  return /^LC_[A-Z0-9_]+$/.test(comparableName);
}

/**
 * Builds a fresh child-process environment from a small set of values needed
 * to locate programs, user and temporary directories, shells, and locales.
 */
export function createMinimalProcessEnvironment(
  source: ProcessEnvironmentSource,
  options: MinimalProcessEnvironmentOptions = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const allowedNames = [
    ...PORTABLE_EXECUTION_ENVIRONMENT_KEYS,
    ...(platform === "win32" ? WINDOWS_EXECUTION_ENVIRONMENT_KEYS : []),
    ...(options.additionalAllowedKeys ?? []),
  ];
  const comparableAllowedNames = new Set(
    allowedNames.map((name) => comparableEnvironmentName(name, platform)),
  );
  const copiedNames = new Map<string, string>();
  const environment: Record<string, string> = {};

  const copyAllowedValues = (values: ProcessEnvironmentSource, overwrite: boolean): void => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined || isSensitiveEnvironmentName(name)) continue;
      const comparableName = comparableEnvironmentName(name, platform);
      if (!comparableAllowedNames.has(comparableName) && !isLocaleEnvironmentName(name, platform)) continue;
      const existingName = copiedNames.get(comparableName);
      if (existingName !== undefined) {
        if (overwrite) environment[existingName] = value;
        continue;
      }
      copiedNames.set(comparableName, name);
      environment[name] = value;
    }
  };

  copyAllowedValues(source, false);
  copyAllowedValues(options.overrides ?? {}, true);

  return environment;
}
