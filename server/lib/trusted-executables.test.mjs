import assert from "node:assert/strict";
import { lstat, mkdtemp, realpath, rm, symlink, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  gitExecutableCandidates,
  resolveTrustedGitExecutable,
  trustedRegularExecutable,
} = await createJiti(import.meta.url).import("./trusted-executables.ts");

test("Windows Git candidates are limited to canonical system Program Files directories", () => {
  assert.deepEqual(gitExecutableCandidates({
    SystemRoot: "C:\\Windows",
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Untrusted\\AppData\\Local",
    PATH: "C:\\Untrusted\\WindowsApps",
    PATHEXT: ".CMD;.EXE",
  }, "win32"), [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
  ]);

  for (const source of [
    { SystemRoot: "C:\\Windows", ProgramFiles: "Program Files" },
    { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\attacker\\Program Files" },
    { SystemRoot: "C:\\Windows", ProgramFiles: "D:\\Program Files" },
    { SystemRoot: "C:\\Windows", ProgramFiles: "\\\\server\\share\\Program Files" },
    { SystemRoot: "relative", ProgramFiles: "C:\\Program Files" },
  ]) {
    assert.deepEqual(gitExecutableCandidates(source, "win32"), []);
  }
});

test("Unix candidate generation ignores empty, relative, and NUL-containing PATH entries", () => {
  assert.deepEqual(gitExecutableCandidates({ PATH: ":relative:/safe/bin" }, "linux"), [
    "/usr/bin/git",
    "/bin/git",
    "/usr/local/bin/git",
    "/safe/bin/git",
  ]);
  assert.deepEqual(gitExecutableCandidates({ PATH: "/safe/bin\0:/other/bin" }, "linux"), [
    "/usr/bin/git",
    "/bin/git",
    "/usr/local/bin/git",
  ]);
});

test("trusted executables reject a final symlink", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-executable-"));
  const executable = path.join(root, "git-real");
  const link = path.join(root, "git-link");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await chmod(executable, 0o755);
  await symlink(executable, link);

  assert.equal(trustedRegularExecutable(executable), await realpath(executable));
  assert.equal(trustedRegularExecutable(link), null);
});

test("Git resolution ignores a PATH-prepended executable and returns a protected absolute file", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-git-path-"));
  const attacker = path.join(root, "git");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(attacker, "#!/bin/sh\nexit 99\n");
  await chmod(attacker, 0o755);

  const resolved = resolveTrustedGitExecutable({ PATH: `${root}::relative` });
  assert.ok(resolved);
  assert.notEqual(resolved, await realpath(attacker));
  assert.equal(path.isAbsolute(resolved), true);
  assert.equal((await lstat(resolved)).isSymbolicLink(), false);
});
