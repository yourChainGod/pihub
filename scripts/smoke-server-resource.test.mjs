import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertRelocatedDependencyTree,
  smokeRelocatedDefaultExtensions,
} from "./smoke-server-resource.mjs";

const VERSION = "0.0.1";
const FIXED_ENTRIES = Object.freeze([
  Object.freeze({ name: "@cortexkit/pi-magic-context", entry: "dist/index.js" }),
  Object.freeze({ name: "pi-todo-rail", entry: "index.ts" }),
  Object.freeze({ name: "@ff-labs/pi-fff", entry: "src/index.ts" }),
  Object.freeze({ name: "pi-simplify", entry: "dist/index.js" }),
  Object.freeze({ name: "@gotgenes/pi-permission-system", entry: "src/index.ts" }),
  Object.freeze({ name: "@eko24ive/pi-ask", entry: "src/index.ts" }),
  Object.freeze({ name: "@gotgenes/pi-subagents", entry: "src/index.ts" }),
]);

const FAKE_RELOCATED_PI = `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.84.2";

const relocatedRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const extensionRoot = path.join(relocatedRoot, "extensions");
const definitions = [
  ["@cortexkit/pi-magic-context", ["ctx_memory"], ["ctx-status"]],
  ["pi-todo-rail", ["todo"], ["todo"]],
  ["@ff-labs/pi-fff", ["ffgrep", "fffind"], ["fff-mode"]],
  ["pi-simplify", [], ["simplify"]],
  ["@gotgenes/pi-permission-system", [], ["permission-system"]],
  ["@eko24ive/pi-ask", ["ask_user"], ["ask-settings"]],
  ["@gotgenes/pi-subagents", ["subagent", "get_subagent_result", "steer_subagent"], ["subagents:settings"]],
];

function definitionFor(filename) {
  const portable = filename.replaceAll("\\\\", "/");
  const definition = definitions.find(([name]) => portable.includes("/" + name + "/"));
  if (!definition) throw new Error("unexpected fake extension path");
  return definition;
}

export class SettingsManager {
  static inMemory(settings, options) {
    return { options, settings };
  }
}

export class DefaultResourceLoader {
  constructor(options) {
    this.options = options;
  }

  async reload() {
    const extensionPrefix = fs.realpathSync.native(extensionRoot) + path.sep;
    if (!this.options.additionalExtensionPaths.every((filename) => fs.realpathSync.native(filename).startsWith(extensionPrefix))) {
      throw new Error("fake loader received a non-relocated extension path");
    }
    this.extensions = this.options.additionalExtensionPaths.map((filename) => {
      const [, tools, commands] = definitionFor(filename);
      return {
        path: filename,
        resolvedPath: filename,
        tools: new Map(tools.map((name) => [name, {}])),
        commands: new Map(commands.map((name) => [name, {}])),
      };
    });
  }

  getExtensions() {
    return { errors: [], extensions: this.extensions };
  }

  getSkills() {
    return {
      diagnostics: [],
      skills: [{
        name: "ask-user",
        filePath: path.join(this.options.additionalSkillPaths[0], "ask-user", "SKILL.md"),
      }],
    };
  }
}
`;

function writeFile(filename, source = "fixture\n") {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, source);
}

function fixture(t, { dependencies = true, extensions = true } = {}) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-smoke-fixture-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const packageRoot = path.join(temporaryDirectory, "relocated", "server");
  fs.mkdirSync(packageRoot, { recursive: true });
  writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: "@pihub/server", version: VERSION }, null, 2)}\n`,
  );
  if (dependencies) {
    writeFile(path.join(packageRoot, "node_modules", "next", "dist", "bin", "next"));
    const piRoot = path.join(
      packageRoot,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    writeFile(
      path.join(piRoot, "package.json"),
      `${JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "0.84.2",
        type: "module",
      }, null, 2)}\n`,
    );
    writeFile(path.join(piRoot, "dist", "index.js"), FAKE_RELOCATED_PI);
  }
  if (extensions) {
    const extensionRoot = path.join(packageRoot, "extensions");
    writeFile(path.join(extensionRoot, "inventory.json"), '{"state":"original"}\n');
    for (const extension of FIXED_ENTRIES) {
      writeFile(path.join(
        extensionRoot,
        "node_modules",
        ...extension.name.split("/"),
        ...extension.entry.split("/"),
      ));
    }
    writeFile(path.join(
      extensionRoot,
      "node_modules",
      "@eko24ive",
      "pi-ask",
      "skills",
      "ask-user",
      "SKILL.md",
    ), "---\nname: ask-user\ndescription: fixture\n---\n");
  }
  return { packageRoot, temporaryDirectory };
}

function fixtureBundleVerifier(expectedInventory = '{"state":"original"}\n') {
  return async (extensionRoot, options) => {
    assert.equal(options.expectedVersion, VERSION);
    assert.equal(options.serverRoot, path.dirname(extensionRoot));
    if (fs.readFileSync(path.join(extensionRoot, "inventory.json"), "utf8") !== expectedInventory) {
      throw new Error("Default extension bundle does not match its inventory");
    }
    return { version: VERSION };
  };
}

test("relocated dependency smoke rejects a missing archive node_modules without workspace fallback", (t) => {
  const { packageRoot } = fixture(t, { dependencies: false, extensions: false });
  assert.throws(
    () => assertRelocatedDependencyTree(packageRoot),
    /must include its own node_modules; workspace fallback is forbidden/,
  );
  assert.equal(fs.existsSync(path.join(packageRoot, "node_modules")), false);
});

test("relocated dependency smoke rejects a dependency-tree link", {
  skip: process.platform === "win32" ? "Windows CI may not permit unprivileged directory symlinks" : false,
}, (t) => {
  const { packageRoot } = fixture(t, { dependencies: false, extensions: false });
  fs.symlinkSync(path.resolve(import.meta.dirname, "..", "server", "node_modules"), path.join(packageRoot, "node_modules"));
  assert.throws(
    () => assertRelocatedDependencyTree(packageRoot),
    /dependency tree must be a real directory/,
  );
});

test("default extension smoke rejects an archive without extensions before loading Pi", async (t) => {
  const { packageRoot } = fixture(t, { extensions: false });
  let loaderCalled = false;
  await assert.rejects(
    smokeRelocatedDefaultExtensions(packageRoot, {
      expectedVersion: VERSION,
      loadPiApi: async () => {
        loaderCalled = true;
        throw new Error("loader must not run");
      },
      verifyBundle: fixtureBundleVerifier(),
    }),
    /default extension bundle must be a real directory/i,
  );
  assert.equal(loaderCalled, false);
});

test("default extension smoke propagates inventory tampering before loading Pi", async (t) => {
  const { packageRoot } = fixture(t);
  fs.writeFileSync(path.join(packageRoot, "extensions", "inventory.json"), '{"state":"tampered"}\n');
  let loaderCalled = false;
  await assert.rejects(
    smokeRelocatedDefaultExtensions(packageRoot, {
      expectedVersion: VERSION,
      loadPiApi: async () => {
        loaderCalled = true;
        throw new Error("loader must not run");
      },
      verifyBundle: fixtureBundleVerifier(),
    }),
    /does not match its inventory/,
  );
  assert.equal(loaderCalled, false);
});

test("relocated Pi loader loads the fixed extensions and ask-user skill", async (t) => {
  const { packageRoot } = fixture(t);
  let verificationCalls = 0;
  const verifyBundle = async (...args) => {
    verificationCalls += 1;
    return fixtureBundleVerifier()(...args);
  };
  const result = await smokeRelocatedDefaultExtensions(packageRoot, {
    expectedVersion: VERSION,
    verifyBundle,
  });

  assert.equal(verificationCalls, 1);
  assert.deepEqual(result.extensions, FIXED_ENTRIES.map(({ name }) => name));
  assert.deepEqual(result.skills, ["ask-user"]);
  assert.deepEqual(result.commands, [
    "ask-settings",
    "ctx-status",
    "fff-mode",
    "permission-system",
    "simplify",
    "subagents:settings",
    "todo",
  ]);
  assert.deepEqual(result.tools, [
    "ask_user",
    "ctx_memory",
    "fffind",
    "ffgrep",
    "get_subagent_result",
    "steer_subagent",
    "subagent",
    "todo",
  ]);
});
