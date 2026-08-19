import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);
const { createGitEnvironment, inspectGitExecutionRisk, runGit } = await createJiti(import.meta.url)
  .import("./git-command.ts");

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", [
    "-c", "commit.gpgsign=false",
    "-c", `core.hooksPath=${os.devNull}`,
    "-C", cwd,
    ...args,
  ], { env: { ...process.env, LC_ALL: "C" } });
  return stdout;
}

function shellPath(filePath) {
  return filePath.replaceAll("\\", "/").replaceAll('"', '\\"');
}

test("Git child environments retain no executable search variables", () => {
  const environment = createGitEnvironment({
    PATH: "/usr/bin",
    PATHEXT: ".CMD;.EXE",
    COMSPEC: "/tmp/attacker",
    HOME: "/home/private",
    NODE_OPTIONS: "--require attacker.js",
    OPENAI_API_KEY: "secret",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/attacker",
    GIT_EXTERNAL_DIFF: "attacker",
    SSH_AUTH_SOCK: "/private/agent.sock",
  });

  for (const key of [
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "HOME",
    "NODE_OPTIONS",
    "OPENAI_API_KEY",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_EXTERNAL_DIFF",
    "SSH_AUTH_SOCK",
  ]) {
    assert.equal(environment[key], undefined, `${key} must not be inherited`);
  }
  assert.equal(environment.GIT_LITERAL_PATHSPECS, "1");
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  assert.equal(environment.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(environment.GIT_PAGER, "");

  const windowsEnvironment = createGitEnvironment({
    Path: "C:\\Windows\\System32",
    PATHEXT: ".CMD;.EXE",
    COMSPEC: "C:\\attacker.cmd",
    SystemRoot: "C:\\Windows",
    Api_Key: "secret",
  }, "win32");
  assert.equal(windowsEnvironment.SystemRoot, "C:\\Windows");
  assert.equal(windowsEnvironment.Path, undefined);
  assert.equal(windowsEnvironment.PATHEXT, undefined);
  assert.equal(windowsEnvironment.COMSPEC, undefined);
  assert.equal(windowsEnvironment.Api_Key, undefined);
  assert.equal(windowsEnvironment.GIT_CONFIG_GLOBAL, "NUL");
});

test("Git commands suppress repository hooks, filters, fsmonitor, textconv, and external diff", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-git-command-"));
  const repo = path.join(root, "repo");
  const linked = path.join(root, "linked checkout");
  const marker = path.join(root, "repository-command-ran");
  const attacker = path.join(root, "attacker.cjs");
  const hooks = path.join(root, "hooks");
  t.after(() => rm(root, { recursive: true, force: true }));

  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "PiHub Test"]);
  await git(repo, ["config", "user.email", "pihub@example.invalid"]);
  await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=evil diff=evil\n");
  await writeFile(path.join(repo, "tracked.txt"), "initial\n");
  await git(repo, ["add", ".gitattributes", "tracked.txt"]);
  await git(repo, ["commit", "-m", "initial"]);

  await writeFile(
    attacker,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`,
  );
  const attackCommand = `"${shellPath(process.execPath)}" "${shellPath(attacker)}"`;
  await mkdir(hooks);
  await writeFile(
    path.join(hooks, "post-checkout"),
    `#!/bin/sh\n${attackCommand}\n`,
  );
  await chmod(path.join(hooks, "post-checkout"), 0o755);

  await git(repo, ["config", "core.hooksPath", hooks]);
  await git(repo, ["config", "core.fsmonitor", attackCommand]);
  await git(repo, ["config", "filter.evil.clean", attackCommand]);
  await git(repo, ["config", "filter.evil.smudge", attackCommand]);
  await git(repo, ["config", "filter.evil.process", attackCommand]);
  await git(repo, ["config", "filter.evil.required", "true"]);
  await git(repo, ["config", "diff.evil.textconv", attackCommand]);
  await git(repo, ["config", "diff.external", attackCommand]);
  await writeFile(path.join(repo, "tracked.txt"), "changed\n");

  const risk = await inspectGitExecutionRisk(repo);
  assert.equal(risk.isRepository, true);
  assert.equal(risk.requiresTrust, true);
  assert.deepEqual(risk.executableConfigKeys, [
    "core.fsmonitor",
    "core.hookspath",
    "diff.evil.textconv",
    "diff.external",
    "filter.evil.clean",
    "filter.evil.process",
    "filter.evil.smudge",
  ]);

  const status = await runGit(repo, ["status", "--porcelain=v1", "-z"]);
  assert.match(status, /tracked\.txt/);
  assert.equal(existsSync(marker), false);

  await git(repo, ["config", "--unset", "diff.external"]);
  const textconvDiff = await runGit(repo, ["diff", "HEAD", "--", "tracked.txt"]);
  assert.match(textconvDiff, /changed/);
  assert.equal(existsSync(marker), false);

  await git(repo, ["config", "diff.external", attackCommand]);
  const externalDiff = await runGit(repo, ["diff", "HEAD", "--", "tracked.txt"]);
  assert.match(externalDiff, /changed/);
  assert.equal(existsSync(marker), false);

  await runGit(repo, ["worktree", "add", "-b", "safe-checkout", "--", linked]);

  assert.equal(existsSync(marker), false);
});

test("non-repositories are not reported as a Git trust surface", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pihub-git-command-clean-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.deepEqual(await inspectGitExecutionRisk(cwd), {
    executableConfigKeys: [],
    isRepository: false,
    requiresTrust: false,
  });
});
