import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createServerRuntimeEnvironment } = require("./server-runtime-environment.js");

const SECRET_CANARIES = {
  AWS_SECRET_ACCESS_KEY: "aws-secret-canary",
  CI_JOB_TOKEN: "ci-token-canary",
  DATABASE_PASSWORD: "database-password-canary",
  GH_TOKEN: "gh-token-canary",
  GITHUB_TOKEN: "github-token-canary",
  HTTPS_PROXY: "http://proxy-user:proxy-password@proxy.invalid",
  NODE_OPTIONS: "--require=/tmp/untrusted.js",
  NPM_CONFIG_USERCONFIG: "/tmp/private-npmrc",
  NPM_TOKEN: "npm-token-canary",
  OPENAI_API_KEY: "provider-key-canary",
  PIHUB_AUTH_SECRET: "auth-secret-canary",
  PIHUB_FUTURE_TOKEN: "future-token-canary",
  PIHUB_LOG_DIRECTORY: "/tmp/untrusted-log-target-canary",
  SSH_AUTH_SOCK: "/tmp/private-agent.sock",
};

test("server runtime keeps required Linux configuration and rejects unrelated secrets", () => {
  const environment = createServerRuntimeEnvironment({
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/pi",
    USER: "pi",
    SHELL: "/bin/bash",
    TMPDIR: "/tmp/pi",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "C.UTF-8",
    XDG_STATE_HOME: "/home/pi/.local/state",
    PI_CODING_AGENT_DIR: "/home/pi/.pi/agent",
    PI_WEB_ALLOWED_HOSTS: "host.example.ts.net",
    PI_WEB_PASSWORD: "server-auth-secret",
    PIHUB_SERVER_ALLOWED_HOSTS: "server.example.ts.net",
    PIHUB_SERVER_PASSWORD: "pihub-server-auth-secret",
    PIHUB_AUTH_STATE_PATH: "/home/pi/.pihub/auth.json",
    PIHUB_TERMINALS_PER_DEVICE: "4",
    PIHUB_WINDOWS_SHELL: "pwsh.exe",
    TS_SOCKET: "/run/tailscale/tailscaled.sock",
    ...SECRET_CANARIES,
  }, {
    platform: "linux",
    overrides: {
      PIHUB_SERVER_HOSTNAME: "127.0.0.1",
      PI_WEB_HOSTNAME: "127.0.0.1",
      PIHUB_SERVER_ROOT: "/opt/pihub/server",
      PIHUB_SERVER_VERSION: "0.0.1",
      PIHUB_TAILNET_HOSTNAME: "host.example.ts.net",
      OPENAI_API_KEY: "override-provider-key-canary",
    },
  });

  assert.deepEqual(environment, {
    NODE_ENV: "production",
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/pi",
    USER: "pi",
    SHELL: "/bin/bash",
    TMPDIR: "/tmp/pi",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "C.UTF-8",
    XDG_STATE_HOME: "/home/pi/.local/state",
    PI_CODING_AGENT_DIR: "/home/pi/.pi/agent",
    PI_WEB_ALLOWED_HOSTS: "host.example.ts.net",
    PI_WEB_PASSWORD: "server-auth-secret",
    PIHUB_SERVER_ALLOWED_HOSTS: "server.example.ts.net",
    PIHUB_SERVER_PASSWORD: "pihub-server-auth-secret",
    PIHUB_AUTH_STATE_PATH: "/home/pi/.pihub/auth.json",
    PIHUB_TERMINALS_PER_DEVICE: "4",
    PIHUB_WINDOWS_SHELL: "pwsh.exe",
    TS_SOCKET: "/run/tailscale/tailscaled.sock",
    PIHUB_SERVER_HOSTNAME: "127.0.0.1",
    PI_WEB_HOSTNAME: "127.0.0.1",
    PIHUB_SERVER_ROOT: "/opt/pihub/server",
    PIHUB_SERVER_VERSION: "0.0.1",
    PIHUB_TAILNET_HOSTNAME: "host.example.ts.net",
  });
  for (const canary of Object.values(SECRET_CANARIES)) {
    assert.equal(Object.values(environment).includes(canary), false, canary);
  }
});

test("server runtime handles Windows variable names case-insensitively", () => {
  const environment = createServerRuntimeEnvironment({
    Path: "C:\\Tools;C:\\Windows\\System32",
    PATH: "C:\\duplicate-must-not-win",
    systemroot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    UserProfile: "C:\\Users\\Pi",
    temp: "C:\\Users\\Pi\\AppData\\Local\\Temp",
    ProgramFiles: "C:\\Program Files",
    PUBLIC: "C:\\Users\\Public",
    lc_time: "English_United States.utf8",
    PIHUB_AUTH_STATE_PATH: "C:\\Users\\Pi\\.pihub\\auth.json",
    ...SECRET_CANARIES,
  }, { platform: "win32" });

  assert.deepEqual(environment, {
    NODE_ENV: "production",
    Path: "C:\\Tools;C:\\Windows\\System32",
    systemroot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    UserProfile: "C:\\Users\\Pi",
    temp: "C:\\Users\\Pi\\AppData\\Local\\Temp",
    ProgramFiles: "C:\\Program Files",
    PUBLIC: "C:\\Users\\Public",
    lc_time: "English_United States.utf8",
    PIHUB_AUTH_STATE_PATH: "C:\\Users\\Pi\\.pihub\\auth.json",
  });
  assert.equal(Object.keys(environment).filter((name) => name.toUpperCase() === "PATH").length, 1);
});

test("source values cannot override production mode or derived launcher metadata", () => {
  const environment = createServerRuntimeEnvironment({
    NODE_ENV: "development",
    PI_WEB_HOSTNAME: "attacker.invalid",
    PIHUB_SERVER_ROOT: "/tmp/untrusted",
  }, {
    platform: "linux",
    overrides: {
      PI_WEB_HOSTNAME: "127.0.0.1",
      PIHUB_SERVER_ROOT: "/opt/pihub/server",
      NODE_ENV: "development",
    },
  });

  assert.deepEqual(environment, {
    NODE_ENV: "production",
    PI_WEB_HOSTNAME: "127.0.0.1",
    PIHUB_SERVER_ROOT: "/opt/pihub/server",
  });
});

test("launcher and headless scripts keep the environment boundary cross-platform", () => {
  const launcher = readFileSync(new URL("./pihub-server.js", import.meta.url), "utf8");
  const supervisor = readFileSync(new URL("./server-supervisor.js", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(launcher, /createServerRuntimeEnvironment\(process\.env\)/);
  assert.match(launcher, /baseRuntimeEnvironment,/);
  assert.match(supervisor, /createServerRuntimeEnvironment\(this\.baseRuntimeEnvironment/);
  assert.match(supervisor, /env: this\.childEnvironment\(packageRoot, version\)/);
  assert.match(supervisor, /env: this\.baseRuntimeEnvironment/g);
  assert.doesNotMatch(launcher, /env:\s*\{\s*\.\.\.process\.env/);
  assert.doesNotMatch(supervisor, /env:\s*(?:\{\s*\.\.\.)?process\.env/);
  assert.equal(packageJson.scripts["dev:headless"], "next dev -H 127.0.0.1 -p 30141");
  assert.equal(packageJson.scripts["start:headless"], "node bin/pihub-server.js --no-open");
  assert.doesNotMatch(packageJson.scripts["dev:headless"], /^[A-Za-z_][A-Za-z0-9_]*=/);
  assert.doesNotMatch(packageJson.scripts["start:headless"], /^[A-Za-z_][A-Za-z0-9_]*=/);
});
