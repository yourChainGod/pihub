import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  createMinimalProcessEnvironment,
  isSensitiveEnvironmentName,
} = await createJiti(import.meta.url).import("./process-environment.ts");

const SECRET_CANARIES = {
  PI_WEB_PASSWORD: "web-password-canary",
  PIHUB_SERVER_PASSWORD: "pihub-server-password-canary",
  PIHUB_AUTH_SECRET: "auth-canary",
  OPENAI_API_KEY: "api-key-canary",
  github_token: "token-canary",
  HTTPS_PROXY: "http://proxy-user:proxy-password@proxy.invalid",
  NO_PROXY: "localhost",
  NEXT_RUNTIME: "nodejs",
  PORT: "30141",
  NODE_ENV: "production",
  DATABASE_PASSWORD: "database-password-canary",
  SESSION_SECRET: "session-secret-canary",
};

test("creates a minimal Linux command environment and rejects secret canaries", () => {
  const environment = createMinimalProcessEnvironment(
    {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/pi",
      USER: "pi",
      LOGNAME: "pi",
      SHELL: "/bin/bash",
      TMPDIR: "/tmp/pi",
      LANG: "zh_CN.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_TIME: "en_GB.UTF-8",
      TERM: "xterm-256color",
      SystemRoot: "/not-a-linux-runtime-variable",
      PI_USER_SETTING: "not-allow-listed",
      ...SECRET_CANARIES,
    },
    { platform: "linux" },
  );

  assert.deepEqual(environment, {
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/pi",
    USER: "pi",
    LOGNAME: "pi",
    SHELL: "/bin/bash",
    TMPDIR: "/tmp/pi",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "C.UTF-8",
    LC_TIME: "en_GB.UTF-8",
    TERM: "xterm-256color",
  });
});

test("creates a minimal macOS command environment with safe overrides", () => {
  const environment = createMinimalProcessEnvironment(
    {
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/pi",
      USER: "pi",
      SHELL: "/bin/zsh",
      TMPDIR: "/var/folders/pi/T/",
      LANG: "en_US.UTF-8",
      TERM: "dumb",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock",
      ...SECRET_CANARIES,
    },
    {
      overrides: {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        OPENAI_API_KEY: "override-api-key-canary",
      },
      platform: "darwin",
    },
  );

  assert.deepEqual(environment, {
    PATH: "/opt/homebrew/bin:/usr/bin",
    HOME: "/Users/pi",
    USER: "pi",
    SHELL: "/bin/zsh",
    TMPDIR: "/var/folders/pi/T/",
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });
});

test("matches Windows names case-insensitively while preserving source casing", () => {
  const environment = createMinimalProcessEnvironment(
    {
      Path: "C:\\Windows\\System32",
      PATH: "C:\\duplicate-must-not-win",
      systemroot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      UserProfile: "C:\\Users\\Pi",
      temp: "C:\\Users\\Pi\\AppData\\Local\\Temp",
      AppData: "C:\\Users\\Pi\\AppData\\Roaming",
      LocalAppData: "C:\\Users\\Pi\\AppData\\Local",
      lc_time: "English_United States.utf8",
      ...SECRET_CANARIES,
    },
    {
      overrides: {
        PATH: "C:\\Tools;C:\\Windows\\System32",
        TEMP: "C:\\Temp",
        TERM: "xterm-256color",
        PIHUB_AUTH_TOKEN: "override-auth-canary",
      },
      platform: "win32",
    },
  );

  assert.deepEqual(environment, {
    Path: "C:\\Tools;C:\\Windows\\System32",
    systemroot: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    UserProfile: "C:\\Users\\Pi",
    temp: "C:\\Temp",
    AppData: "C:\\Users\\Pi\\AppData\\Roaming",
    LocalAppData: "C:\\Users\\Pi\\AppData\\Local",
    lc_time: "English_United States.utf8",
    TERM: "xterm-256color",
  });
  assert.equal(Object.keys(environment).filter((name) => name.toUpperCase() === "PATH").length, 1);
});

test("sensitive names cannot be admitted through additional keys or overrides", () => {
  const sensitiveNames = Object.keys(SECRET_CANARIES).concat([
    "API_KEY",
    "TOKEN",
    "PIHUB_AUTH_STATE_PATH",
    "NPM_CONFIG_PROXY",
    "CLIENT_CREDENTIAL",
    "PRIVATE_KEY",
    "AUTHORIZATION",
    "API_KEY_FILE",
    "SERVICE_TOKEN_FILE",
  ]);
  const source = Object.fromEntries(sensitiveNames.map((name) => [name, `${name}-canary`]));
  const environment = createMinimalProcessEnvironment(source, {
    additionalAllowedKeys: sensitiveNames,
    overrides: source,
    platform: "linux",
  });

  assert.deepEqual(environment, {});
  for (const name of sensitiveNames) assert.equal(isSensitiveEnvironmentName(name), true, name);
});
