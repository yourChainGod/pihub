import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  configuredPackageId,
  PackageSettingsMutationError,
  setConfiguredPackageDisabled,
} = await createJiti(import.meta.url).import("./package-settings-security.ts");

function fixture(t, packages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-package-settings-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const filename = path.join(agentDir, "settings.json");
  fs.writeFileSync(filename, JSON.stringify({ theme: "dark", packages }, null, 2));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { agentDir, cwd, filename };
}

function mutate(paths, source, disabled, signal = new AbortController().signal) {
  return setConfiguredPackageDisabled({
    ...paths,
    disabled,
    packageId: configuredPackageId("global", source),
    scope: "global",
    signal,
  });
}

test("package handles are deterministic, scope-bound, and do not expose their source", () => {
  const source = "git:https://user:secret@example.invalid/private/repository@main";
  const globalId = configuredPackageId("global", source);
  assert.match(globalId, /^pkg_[A-Za-z0-9_-]{43}$/);
  assert.equal(globalId, configuredPackageId("global", source));
  assert.notEqual(globalId, configuredPackageId("project", source));
  assert.doesNotMatch(globalId, /user|secret|private|repository/i);
});

test("plugin disable and enable atomically preserve the exact configured source and filters", (t) => {
  const original = {
    source: "npm:@scope/plugin@1.2.3",
    autoload: true,
    extensions: ["dist/index.js"],
    skills: ["skills/safe/SKILL.md"],
  };
  const paths = fixture(t, [original, "git:https://example.invalid/repo@0123456789abcdef"]);
  assert.deepEqual(mutate(paths, original.source, true), { changed: true });
  const disabled = JSON.parse(fs.readFileSync(paths.filename, "utf8"));
  assert.equal(disabled.theme, "dark");
  assert.equal(disabled.packages[0].source, original.source);
  assert.equal(disabled.packages[0].autoload, false);
  assert.deepEqual(disabled.packages[0].extensions, []);
  assert.deepEqual(disabled.packages[0].pihubDisabledV1, original);

  assert.deepEqual(mutate(paths, original.source, false), { changed: true });
  const restored = JSON.parse(fs.readFileSync(paths.filename, "utf8"));
  assert.deepEqual(restored.packages[0], original);
  assert.equal(restored.packages[1], "git:https://example.invalid/repo@0123456789abcdef");
  if (process.platform !== "win32") assert.equal(fs.statSync(paths.filename).mode & 0o777, 0o600);
});

test("plugin mutations reject forged, duplicate, legacy, symlinked, and aborted state", (t) => {
  const paths = fixture(t, ["npm:safe@1.0.0"]);
  assert.throws(
    () => mutate(paths, "npm:attacker@9.9.9", true),
    (error) => error instanceof PackageSettingsMutationError && error.code === "not-configured",
  );

  fs.writeFileSync(paths.filename, JSON.stringify({ packages: ["npm:safe@1.0.0", "npm:safe@1.0.0"] }));
  assert.throws(
    () => mutate(paths, "npm:safe@1.0.0", true),
    (error) => error instanceof PackageSettingsMutationError && error.code === "ambiguous-source",
  );

  fs.writeFileSync(paths.filename, JSON.stringify({
    packages: [{ source: "npm:safe@1.0.0", autoload: false, extensions: [], skills: [], prompts: [], themes: [] }],
  }));
  assert.throws(
    () => mutate(paths, "npm:safe@1.0.0", false),
    (error) => error instanceof PackageSettingsMutationError && error.code === "legacy-disabled",
  );

  fs.writeFileSync(paths.filename, JSON.stringify({ packages: ["npm:safe@1.0.0"] }));
  const before = fs.readFileSync(paths.filename, "utf8");
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => mutate(paths, "npm:safe@1.0.0", true, controller.signal), /abort/i);
  assert.equal(fs.readFileSync(paths.filename, "utf8"), before);

  const real = path.join(path.dirname(paths.filename), "real-settings.json");
  fs.renameSync(paths.filename, real);
  fs.symlinkSync(real, paths.filename);
  assert.throws(
    () => mutate(paths, "npm:safe@1.0.0", true),
    (error) => error instanceof PackageSettingsMutationError && error.code === "unsafe-settings-path",
  );
});
