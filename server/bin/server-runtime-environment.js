"use strict";

const PORTABLE_RUNTIME_KEYS = [
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
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
];

const WINDOWS_RUNTIME_KEYS = [
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
  "PUBLIC",
];

// These values configure PiHub itself. Unknown PIHUB/PI_WEB variables are not
// admitted, so a future token or credential cannot cross this boundary by
// sharing a prefix.
const SERVER_RUNTIME_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_WEB_ALLOWED_HOSTS",
  "PI_WEB_PASSWORD",
  "PIHUB_AUTH_STATE_PATH",
  "PIHUB_TERMINALS_PER_DEVICE",
  "PIHUB_TERMINALS_PER_PROCESS",
  "PIHUB_TERMINAL_SUBSCRIBERS",
  "PIHUB_WINDOWS_SHELL",
  "TAILSCALE_SOCKET",
  "TS_SOCKET",
];

const DERIVED_RUNTIME_KEYS = new Set([
  "PI_WEB_HOSTNAME",
  "PIHUB_SERVER_ROOT",
  "PIHUB_SERVER_VERSION",
  "PIHUB_TAILNET_HOSTNAME",
]);

function comparableName(name, platform) {
  return platform === "win32" ? name.toUpperCase() : name;
}

function createServerRuntimeEnvironment(
  source,
  { overrides = {}, platform = process.platform } = {},
) {
  const allowedNames = [
    ...PORTABLE_RUNTIME_KEYS,
    ...SERVER_RUNTIME_KEYS,
    ...(platform === "win32" ? WINDOWS_RUNTIME_KEYS : []),
  ];
  const allowed = new Set(allowedNames.map((name) => comparableName(name, platform)));
  const copiedNames = new Map();
  const environment = { NODE_ENV: "production" };

  for (const [name, value] of Object.entries(source ?? {})) {
    if (typeof value !== "string") continue;
    const comparable = comparableName(name, platform);
    const isLocale = /^LC_[A-Z0-9_]+$/.test(comparable);
    if (!allowed.has(comparable) && !isLocale) continue;
    if (copiedNames.has(comparable)) continue;
    copiedNames.set(comparable, name);
    environment[name] = value;
  }

  for (const [name, value] of Object.entries(overrides)) {
    if (!DERIVED_RUNTIME_KEYS.has(name) || typeof value !== "string") continue;
    environment[name] = value;
  }

  return environment;
}

module.exports = { createServerRuntimeEnvironment };
