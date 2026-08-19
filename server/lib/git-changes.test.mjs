import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args]);
}

async function loadSubject() {
  return import("./git-status.ts");
}

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

test("reports a bare repository without attempting worktree status or diff", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-git-bare-status-"));
  const bare = path.join(root, "repo.git");
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--bare", bare]);

  const { getGitFileDiff, getGitStatus } = await createJiti(import.meta.url)
    .import("./git-changes.ts");
  assert.deepEqual(await getGitStatus(bare), {
    isGitRepository: true,
    isBareRepository: true,
    repositoryRoot: await realpath(bare),
    files: [],
    additions: 0,
    deletions: 0,
  });
  assert.deepEqual(await getGitFileDiff(bare, path.join(bare, "config")), {
    supported: false,
  });
});

test("rejects a Git directory whose configured worktree is outside cwd", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-git-external-worktree-"));
  const gitDir = path.join(root, "repo.git");
  const outside = path.join(root, "outside");
  const probe = path.join(root, "probe");
  t.after(() => rm(root, { recursive: true, force: true }));

  await execFileAsync("git", ["init", "--bare", gitDir]);
  await execFileAsync("git", ["--git-dir", gitDir, "config", "core.bare", "false"]);
  await execFileAsync("git", ["--git-dir", gitDir, "config", "core.worktree", outside]);
  await mkdir(outside);
  await mkdir(probe);
  await writeFile(path.join(probe, ".git"), `gitdir: ${gitDir}\n`);

  const { getGitFileDiff, getGitStatus } = await createJiti(import.meta.url)
    .import("./git-changes.ts");
  assert.deepEqual(await getGitStatus(probe), {
    isGitRepository: false,
    isBareRepository: false,
    repositoryRoot: null,
    files: [],
    additions: 0,
    deletions: 0,
  });
  assert.deepEqual(await getGitFileDiff(probe, path.join(outside, "secret.txt")), {
    supported: false,
  });
});

test("reads normal diffs by descriptor and refuses an untracked symlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-git-status-"));
  const repo = path.join(root, "repo");
  const tracked = path.join(repo, "tracked.txt");
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "PiHub Test"]);
  await git(repo, ["config", "user.email", "pihub@example.invalid"]);
  await writeFile(tracked, "initial\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
  await writeFile(tracked, "changed\n");

  const { getGitFileDiff, getGitStatus } = await createJiti(import.meta.url)
    .import("./git-changes.ts");
  const status = await getGitStatus(repo);
  const realTracked = await realpath(tracked);
  assert.equal(status.isGitRepository, true);
  assert.equal(status.isBareRepository, false);
  assert.equal(status.files.some((file) => file.filePath === realTracked && file.status === "modified"), true);
  const diff = await getGitFileDiff(repo, tracked);
  assert.equal(diff.supported, true);
  assert.match(diff.patch, /\+changed/);

  if (process.platform !== "win32") {
    const outside = path.join(root, "outside.txt");
    const linked = path.join(repo, "linked.txt");
    await writeFile(outside, "must not be read\n");
    await symlink(outside, linked);
    assert.deepEqual(await getGitFileDiff(repo, linked), { supported: false });

    const unusual = path.join(repo, "line\nbreak.txt");
    await writeFile(unusual, "safe\n");
    const unusualDiff = await getGitFileDiff(repo, unusual);
    assert.equal(unusualDiff.supported, true);
    assert.match(unusualDiff.patch, /"a\/line\\nbreak\.txt"/);
    assert.doesNotMatch(unusualDiff.patch, /diff --git[^\n]*\n[^\n]*break\.txt/);
  }
});

test("Git APIs use authenticated device scopes and private no-store responses", async () => {
  for (const route of ["status", "diff"]) {
    const source = await readFile(
      new URL(`../app/api/git/${route}/route.ts`, import.meta.url),
      "utf8",
    );
    assert.match(source, /getTrustedPihubRequestContext\(request\)/);
    assert.match(source, /getAllowedFileRoots\(\{ ownerId: authentication\.deviceId \}\)/);
    assert.match(source, /capabilities\.includes\("workspaces:read"\)/);
    assert.doesNotMatch(source, /error: error instanceof Error/);
    assert.match(source, /private, no-store/);
  }
});
