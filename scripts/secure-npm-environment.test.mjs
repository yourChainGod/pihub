import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createSecureNpmEnvironment,
  prepareSecureNpmEnvironment,
} from "./secure-npm-environment.mjs";

test("release npm receives a fixed credential-free environment", () => {
  const filesystemRoot = path.parse(process.cwd()).root;
  const privateRoot = path.join(filesystemRoot, "Users", "private-builder");
  const isolationRoot = path.join(filesystemRoot, "tmp", "pihub-npm");
  const environment = createSecureNpmEnvironment(isolationRoot, {
    execPath: path.join(filesystemRoot, "opt", "node", "bin", "node"),
    platform: "darwin",
    sourceEnvironment: {
      AWS_SECRET_ACCESS_KEY: "canary-secret",
      GITHUB_TOKEN: "canary-token",
      HOME: privateRoot,
      HTTPS_PROXY: "https://user:password@proxy.example.invalid/",
      NEXT_PUBLIC_PRIVATE_PATH: privateRoot,
      NODE_AUTH_TOKEN: "canary-node-token",
      NODE_OPTIONS: "--require /tmp/canary.js",
      NPM_TOKEN: "canary-npm-token",
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
    "NPM_CONFIG_AUDIT",
    "NPM_CONFIG_BIN_LINKS",
    "NPM_CONFIG_CACHE",
    "NPM_CONFIG_COLOR",
    "NPM_CONFIG_ENGINE_STRICT",
    "NPM_CONFIG_FORCE",
    "NPM_CONFIG_FUND",
    "NPM_CONFIG_GLOBALCONFIG",
    "NPM_CONFIG_IGNORE_SCRIPTS",
    "NPM_CONFIG_LEGACY_PEER_DEPS",
    "NPM_CONFIG_PROVENANCE",
    "NPM_CONFIG_REGISTRY",
    "NPM_CONFIG_STRICT_SSL",
    "NPM_CONFIG_UPDATE_NOTIFIER",
    "NPM_CONFIG_USERCONFIG",
    "PATH",
    "SOURCE_DATE_EPOCH",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
  ]);
  const serialized = JSON.stringify(environment);
  assert.equal(serialized.includes("canary"), false);
  assert.equal(serialized.includes("password"), false);
  assert.equal(serialized.includes(privateRoot), false);
  assert.equal(environment.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org/");
  assert.equal(environment.NPM_CONFIG_PROVENANCE, "false");
});

test("release npm retains only the Windows process contract", () => {
  const environment = createSecureNpmEnvironment("D:\\pihub-npm", {
    execPath: "D:\\node\\node.exe",
    platform: "win32",
    sourceEnvironment: {
      GITHUB_TOKEN: "canary-token",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      SystemRoot: "C:\\Windows",
    },
  });

  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.WINDIR, "C:\\Windows");
  assert.equal(environment.ComSpec, path.join("C:\\Windows", "System32", "cmd.exe"));
  assert.equal(environment.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(JSON.stringify(environment).includes("canary-token"), false);
});

test("prepared npm homes and configuration are private and disposable", (t) => {
  const prepared = prepareSecureNpmEnvironment("pihub-npm-test-");
  t.after(() => prepared.cleanup());

  for (const name of ["global.npmrc", "user.npmrc"]) {
    const filename = path.join(prepared.root, name);
    assert.equal(fs.readFileSync(filename, "utf8"), "");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    }
  }
  assert.equal(prepared.environment.HOME, path.join(prepared.root, "home"));
  assert.equal(prepared.environment.NPM_CONFIG_CACHE, path.join(prepared.root, "npm-cache"));

  prepared.cleanup();
  assert.equal(fs.existsSync(prepared.root), false);
});
