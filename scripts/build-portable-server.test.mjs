import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createPortableBuildEnvironment } from "./build-portable-server.mjs";

test("portable Next builds receive only a deterministic credential-free environment", () => {
  const privateRoot = path.join(path.parse(process.cwd()).root, "Users", "private-builder");
  const environment = createPortableBuildEnvironment(path.join(path.parse(process.cwd()).root, "tmp", "pihub-build"), {
    execPath: path.join(path.parse(process.cwd()).root, "opt", "node", "bin", "node"),
    platform: "darwin",
    sourceEnvironment: {
      AWS_SECRET_ACCESS_KEY: "canary-secret",
      GITHUB_TOKEN: "canary-token",
      HOME: privateRoot,
      NEXT_PUBLIC_PRIVATE_PATH: privateRoot,
      NODE_OPTIONS: "--require /tmp/canary.js",
      npm_config_registry: "https://packages.example.invalid/",
    },
  });

  assert.deepEqual(Object.keys(environment).sort(), [
    "CI",
    "HOME",
    "LANG",
    "LC_ALL",
    "NEXT_TELEMETRY_DISABLED",
    "NODE_ENV",
    "NO_COLOR",
    "PATH",
    "SOURCE_DATE_EPOCH",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
  ]);
  assert.equal(JSON.stringify(environment).includes("canary"), false);
  assert.equal(JSON.stringify(environment).includes(privateRoot), false);
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.NEXT_TELEMETRY_DISABLED, "1");
});

test("portable Windows builds retain only the operating-system process contract", () => {
  const environment = createPortableBuildEnvironment("D:\\pihub-build", {
    execPath: "D:\\node\\node.exe",
    platform: "win32",
    sourceEnvironment: {
      GITHUB_TOKEN: "canary-token",
      PATHEXT: ".COM;.EXE",
      SystemRoot: "C:\\Windows",
    },
  });

  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.WINDIR, "C:\\Windows");
  assert.equal(environment.ComSpec, path.join("C:\\Windows", "System32", "cmd.exe"));
  assert.equal(JSON.stringify(environment).includes("canary-token"), false);
  assert.equal(environment.PATHEXT, ".COM;.EXE");
});
