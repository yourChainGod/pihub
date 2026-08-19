import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./worktree.ts");
}

async function git(cwd, args) {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout;
}

async function initializeRepository(repo) {
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "PiHub Test"]);
  await git(repo, ["config", "user.email", "pihub@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
}

test("main and linked worktrees share one canonical project root", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await initializeRepository(repo);
  await git(repo, ["worktree", "add", "-b", "feature/test", linked]);

  const { findCurrentWorktreePath, listWorktrees, resolveProject } = await loadSubject();
  const mainProject = await resolveProject(`${repo}${path.sep}`);
  const linkedProject = await resolveProject(linked);

  assert.equal(mainProject.isTopLevel, true);
  assert.equal(mainProject.isWorktree, false);
  assert.equal(linkedProject.isTopLevel, true);
  assert.equal(linkedProject.isWorktree, true);
  assert.equal(linkedProject.branch, "feature/test");
  assert.equal(mainProject.projectRoot, linkedProject.projectRoot);

  const worktrees = await listWorktrees(linked);
  const listedLinked = worktrees.find((worktree) => worktree.branch === "feature/test");
  assert.ok(listedLinked);
  assert.equal(findCurrentWorktreePath(worktrees, `${linked}${path.sep}`), listedLinked.path);
});

test("parses NUL worktree porcelain without treating path newlines as records", async () => {
  const { parseWorktreePorcelainV1Z } = await loadSubject();
  assert.deepEqual(parseWorktreePorcelainV1Z([
    "worktree /repo/line\nbreak",
    "HEAD 0123456789abcdef",
    "branch refs/heads/feature/test",
    "",
    "worktree /repo/bare.git",
    "bare",
    "",
    "",
  ].join("\0")), [
    {
      path: "/repo/line\nbreak",
      branch: "feature/test",
      bare: false,
      prunable: false,
    },
    {
      path: "/repo/bare.git",
      branch: null,
      bare: true,
      prunable: false,
    },
  ]);
});

test("bare repositories remain their own project root and expose only real worktrees", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-bare-worktree-"));
  const source = path.join(root, "source");
  const bare = path.join(root, "source.git");
  const linked = path.join(root, "linked checkout");
  t.after(() => rm(root, { recursive: true, force: true }));

  await initializeRepository(source);
  const branch = (await git(source, ["branch", "--show-current"])).trim();
  await execFileAsync("git", ["clone", "--bare", source, bare]);
  await git(bare, ["worktree", "add", linked, branch]);

  const { listWorktrees, resolveProject } = await loadSubject();
  const [realBare, realLinked] = await Promise.all([realpath(bare), realpath(linked)]);
  const bareProject = await resolveProject(bare);
  const linkedProject = await resolveProject(linked);
  assert.equal(bareProject.projectRoot, realBare);
  assert.equal(bareProject.isTopLevel, true);
  assert.equal(bareProject.isWorktree, false);
  assert.equal(linkedProject.projectRoot, realBare);
  assert.equal(linkedProject.isWorktree, true);

  assert.deepEqual(await listWorktrees(bare), [{
    path: realLinked,
    branch,
    isMain: false,
  }]);
});

test("rejects invalid branch names and a symlinked managed worktree directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-worktree-validation-"));
  const repo = path.join(root, "repo");
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeRepository(repo);

  const { addWorktree } = await loadSubject();
  await assert.rejects(addWorktree(repo, "-malicious"), /Invalid branch name/);
  await assert.rejects(addWorktree(repo, "../escape"), /Invalid branch name/);

  if (process.platform !== "win32") {
    const redirect = path.join(root, "redirect");
    await mkdir(redirect);
    await symlink(redirect, `${repo}-worktrees`, "dir");
    await assert.rejects(addWorktree(repo, "feature/safe-name"), /Unsafe worktree directory/);
  }
});

test("rejects an external core.worktree repository layout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-worktree-external-layout-"));
  const gitDir = path.join(root, "repo.git");
  const outside = path.join(root, "outside");
  const probe = path.join(root, "probe");
  t.after(() => rm(root, { recursive: true, force: true }));

  await execFileAsync("git", ["init", "--bare", gitDir]);
  await execFileAsync("git", ["--git-dir", gitDir, "config", "core.bare", "false"]);
  await execFileAsync("git", ["--git-dir", gitDir, "config", "core.worktree", outside]);
  await execFileAsync("git", ["--git-dir", gitDir, "config", "user.name", "PiHub Test"]);
  await execFileAsync("git", ["--git-dir", gitDir, "config", "user.email", "pihub@example.invalid"]);
  await mkdir(outside);
  await mkdir(probe);
  await writeFile(path.join(outside, "README.md"), "outside\n");
  await execFileAsync("git", ["--git-dir", gitDir, "--work-tree", outside, "add", "README.md"]);
  await execFileAsync("git", ["--git-dir", gitDir, "--work-tree", outside, "commit", "-m", "initial"]);
  await writeFile(path.join(probe, ".git"), `gitdir: ${gitDir}\n`);

  const { addWorktree, listWorktrees, resolveProject } = await loadSubject();
  assert.deepEqual(await resolveProject(probe), {
    projectRoot: probe,
    branch: null,
    isWorktree: false,
    isTopLevel: false,
  });
  await assert.rejects(listWorktrees(probe), /Unsafe Git repository layout/);
  await assert.rejects(addWorktree(probe, "must-not-touch-outside"), /Unsafe Git repository layout/);
});

test("rejects a copied linked-worktree pointer that is not registered for cwd", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-worktree-copied-pointer-"));
  const repo = path.join(root, "repo");
  const linked = path.join(root, "linked");
  const probe = path.join(root, "probe");
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeRepository(repo);
  await git(repo, ["worktree", "add", "-b", "feature/linked", linked]);
  await mkdir(probe);
  await copyFile(path.join(linked, ".git"), path.join(probe, ".git"));

  const { addWorktree, listWorktrees, resolveProject } = await loadSubject();
  assert.deepEqual(await resolveProject(probe), {
    projectRoot: probe,
    branch: null,
    isWorktree: false,
    isTopLevel: false,
  });
  await assert.rejects(listWorktrees(probe), /Unsafe Git repository layout/);
  await assert.rejects(addWorktree(probe, "must-not-touch-main"), /Unsafe Git repository layout/);
});

test("omits a registered worktree replaced by a directory symlink", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-worktree-rebound-"));
  const repo = path.join(root, "repo");
  const linked = path.join(root, "linked");
  const relocated = path.join(root, "relocated");
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeRepository(repo);
  await git(repo, ["worktree", "add", "-b", "feature/rebound", linked]);
  await rename(linked, relocated);
  await symlink(relocated, linked, "dir");

  const { listWorktrees, removeWorktree } = await loadSubject();
  assert.equal((await listWorktrees(repo)).some((worktree) => worktree.branch === "feature/rebound"), false);
  await assert.rejects(removeWorktree(repo, linked), /Not a worktree of this repository/);
  assert.equal(await readFile(path.join(relocated, "README.md"), "utf8"), "# test\n");
});

test("new and removed worktrees update only the supplied owner scope", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-worktree-scope-"));
  const repo = path.join(root, "repo");
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeRepository(repo);

  const subject = await loadSubject();
  const { createJiti } = await import("jiti");
  const roots = await createJiti(import.meta.url).import("./allowed-roots.ts");
  const scope = { ownerId: "dev_worktree_test" };
  const otherScope = { ownerId: "dev_other_test" };
  const added = await subject.addWorktree(repo, "feature/scoped", scope);
  const key = roots.allowedRootKey(await realpath(added.path));
  assert.equal(roots.getAdditionalAllowedRoots(scope).has(key), true);
  assert.equal(roots.getAdditionalAllowedRoots(otherScope).has(key), false);

  await subject.removeWorktree(repo, added.path, false, scope);
  assert.equal(roots.getAdditionalAllowedRoots(scope).has(key), false);
  assert.equal(roots.getRevokedAllowedRoots(scope).has(key), true);
  assert.equal(roots.getRevokedAllowedRoots(otherScope).has(key), false);
});

test("maps Windows reserved device names to ordinary worktree directories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-worktree-reserved-"));
  const repo = path.join(root, "repo");
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeRepository(repo);

  const subject = await loadSubject();
  const added = await subject.addWorktree(repo, "CON");
  assert.equal(path.basename(added.path), "_CON");
  assert.equal(added.branch, "CON");
  await subject.removeWorktree(repo, added.path);
});

test("worktree APIs derive owner scope from authenticated request context", async () => {
  const source = await readFile(new URL("../app/api/worktrees/route.ts", import.meta.url), "utf8");
  assert.match(source, /getTrustedPihubRequestContext\(request\)/);
  assert.match(source, /scope: \{ ownerId: authentication\.deviceId \}/);
  assert.match(source, /getAllowedFileRoots\(scope\)/);
  assert.match(source, /isScopedExistingPathAllowed\(worktree\.path, allowedRoots\)/);
  assert.match(source, /isScopedExistingPathAllowed\(project\.projectRoot, allowedRoots\)/);
  assert.match(source, /addWorktree\(body\.cwd, body\.branch, authentication\.scope\)/);
  assert.match(source, /removeWorktree\(body\.cwd, body\.path, body\.force === true, authentication\.scope\)/);
  assert.doesNotMatch(source, /body\.(?:ownerId|deviceId)/);
  assert.doesNotMatch(source, /allowFileRoot/);
  assert.doesNotMatch(source, /error: (?:String\(error\)|message)/);
  assert.doesNotMatch(source, /Directory does not exist:/);
  assert.match(source, /requestScope\(req, "workspaces:read"\)/);
  assert.equal(Array.from(source.matchAll(/requestScope\(req, "workspaces:manage"\)/g)).length, 2);
  assert.match(source, /Cache-Control/);
  assert.match(source, /private, no-store/);
});
