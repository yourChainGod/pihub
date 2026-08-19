import { existsSync, lstatSync, mkdirSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { allowFileRoot, revokeFileRoot, type AllowedRootScope } from "./allowed-roots";
import { runGit } from "./git-command";
import { samePath, toNativePath } from "./paths";

// ============================================================================
// Project resolution: cwd → { projectRoot, branch }
//
// A worktree's `git rev-parse --git-common-dir` points at the *main* repo's
// .git directory, so its parent is the project root shared by all worktrees.
// Non-git directories resolve to themselves. Results are cached on globalThis
// (hot-reload safe) with a short TTL; add/remove worktree invalidates eagerly.
// ============================================================================

export interface ProjectInfo {
  projectRoot: string;
  /** Current branch of the cwd, null for non-git dirs or detached HEAD */
  branch: string | null;
  /** True when cwd is a linked worktree (not the main checkout) */
  isWorktree: boolean;
  /** True when cwd is the top-level directory of a checkout (main or linked).
   *  False for repo subdirectories and non-git dirs — the worktree switcher
   *  is only meaningful at the top level. */
  isTopLevel: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface WorktreePorcelainRecord {
  path: string;
  branch: string | null;
  bare: boolean;
  prunable: boolean;
}

declare global {
  var __piProjectCache: Map<string, { info: ProjectInfo; expiresAt: number }> | undefined;
}

const PROJECT_CACHE_TTL_MS = 60_000;

function getProjectCache(): Map<string, { info: ProjectInfo; expiresAt: number }> {
  if (!globalThis.__piProjectCache) globalThis.__piProjectCache = new Map();
  return globalThis.__piProjectCache;
}

export function invalidateProjectCache(): void {
  globalThis.__piProjectCache?.clear();
}

function stripCommandLineEnding(output: string): string {
  if (output.endsWith("\r\n")) return output.slice(0, -2);
  if (output.endsWith("\n")) return output.slice(0, -1);
  return output;
}

async function gitLine(cwd: string, args: readonly string[]): Promise<string> {
  return stripCommandLineEnding(await runGit(cwd, args, { maxBuffer: 1024 * 1024 }));
}

function realPathOrSelf(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/**
 * addWorktree() places worktrees in `<repoRoot>-worktrees/<dir>`. When such a
 * directory no longer exists (worktree removed), group its sessions back
 * under the main repo instead of letting them dangle as a phantom project.
 * The dir name is the sanitized branch name — close enough for display.
 */
function inferRemovedWorktree(cwd: string): ProjectInfo | null {
  const parent = dirname(cwd);
  if (!parent.endsWith("-worktrees")) return null;
  const repoRoot = parent.slice(0, -"-worktrees".length);
  const canonicalRepoRoot = repoRoot ? safeCanonicalDirectory(repoRoot) : null;
  if (!canonicalRepoRoot) return null;
  const normalRepository = existsSync(join(canonicalRepoRoot, ".git"));
  const bareRepository = existsSync(join(canonicalRepoRoot, "HEAD"))
    && existsSync(join(canonicalRepoRoot, "objects"));
  if (!normalRepository && !bareRepository) return null;
  return { projectRoot: canonicalRepoRoot, branch: basename(cwd), isWorktree: true, isTopLevel: true };
}

interface RepositoryLayout {
  commonDir: string;
  gitDir: string;
  mainRoot: string;
  topLevel: string;
  branch: string | null;
  bare: boolean;
  worktrees: WorktreePorcelainRecord[];
}

interface DirectoryIdentity {
  canonicalPath: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
}

function isWithinPath(parent: string, target: string): boolean {
  const candidate = relative(resolve(parent), resolve(target));
  return candidate === ""
    || (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate));
}

function readSafeDirectoryIdentity(directory: string): DirectoryIdentity {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Unsafe Git directory");
  }
  const canonicalPath = realpathSync.native(directory);
  const canonicalStat = lstatSync(canonicalPath);
  if (
    !canonicalStat.isDirectory()
    || canonicalStat.isSymbolicLink()
    || canonicalStat.dev !== stat.dev
    || canonicalStat.ino !== stat.ino
    || canonicalStat.birthtimeMs !== stat.birthtimeMs
  ) {
    throw new Error("Unsafe Git directory");
  }
  return {
    canonicalPath,
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
  };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return samePath(left.canonicalPath, right.canonicalPath)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function assertDirectoryIdentity(directory: string, expected: DirectoryIdentity): void {
  if (!sameDirectoryIdentity(readSafeDirectoryIdentity(directory), expected)) {
    throw new Error("Git directory changed during operation");
  }
}

function safeCanonicalDirectory(directory: string): string | null {
  try {
    return readSafeDirectoryIdentity(directory).canonicalPath;
  } catch {
    return null;
  }
}

async function readRepositoryLayout(cwd: string): Promise<RepositoryLayout> {
  const [commonDirOutput, gitDirOutput, bareOutput, ref, worktreeOutput] = await Promise.all([
    gitLine(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    gitLine(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]),
    gitLine(cwd, ["rev-parse", "--is-bare-repository"]),
    gitLine(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(cwd, ["worktree", "list", "--porcelain", "-z"]),
  ]);
  const commonDir = toNativePath(commonDirOutput);
  const gitDir = toNativePath(gitDirOutput);
  const bare = bareOutput === "true";
  const worktrees = parseWorktreePorcelainV1Z(worktreeOutput);
  const primaryWorktree = worktrees[0];
  const topLevel = bare
    ? commonDir
    : toNativePath(await gitLine(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]));
  const realCwd = safeCanonicalDirectory(cwd);
  const realTopLevel = safeCanonicalDirectory(topLevel);
  const realCommonDir = safeCanonicalDirectory(commonDir);
  const realGitDir = safeCanonicalDirectory(gitDir);
  const mainRoot = primaryWorktree?.bare
    ? realCommonDir
    : safeCanonicalDirectory(primaryWorktree?.path ?? (bare ? commonDir : topLevel));
  const registeredTopLevel = bare
    ? true
    : worktrees.some((record) => {
      if (record.bare || record.prunable || !realTopLevel) return false;
      const registeredPath = safeCanonicalDirectory(record.path);
      return registeredPath !== null && samePath(registeredPath, realTopLevel);
    });
  if (
    !realCwd
    || !realTopLevel
    || !realCommonDir
    || !realGitDir
    || !mainRoot
    || !isWithinPath(realTopLevel, realCwd)
    || !isWithinPath(realCommonDir, realGitDir)
    || !registeredTopLevel
    || (bare && !samePath(realTopLevel, realCommonDir))
    || (!bare && samePath(realGitDir, realCommonDir) && !samePath(mainRoot, realTopLevel))
  ) {
    throw new Error("Unsafe Git repository layout");
  }
  return {
    commonDir: realCommonDir,
    gitDir: realGitDir,
    mainRoot,
    topLevel: realTopLevel,
    branch: ref && ref !== "HEAD" ? ref : null,
    bare,
    worktrees,
  };
}

export async function resolveProject(cwd: string): Promise<ProjectInfo> {
  const cache = getProjectCache();
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  let info: ProjectInfo;
  try {
    if (!existsSync(cwd)) {
      info = inferRemovedWorktree(cwd) ?? { projectRoot: cwd, branch: null, isWorktree: false, isTopLevel: false };
      cache.set(cwd, { info, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
      return info;
    }
    const layout = await readRepositoryLayout(cwd);
    // git prints resolved (symlink-free) paths; normalize cwd the same way
    const realCwd = realPathOrSelf(cwd);
    // For a linked worktree, --git-dir differs from --git-common-dir.
    // Only collapse *worktree toplevels* into the main repo. A session whose
    // cwd is a subdirectory of a repo keeps its own project identity —
    // grouping subdirs under the repo root would change where new sessions
    // are created for existing users.
    const isTopLevel = samePath(layout.topLevel, realCwd);
    const isWorktreeTopLevel = !layout.bare && !samePath(layout.gitDir, layout.commonDir) && isTopLevel;
    const topLevelProjectRoot = isWorktreeTopLevel ? layout.mainRoot : layout.topLevel;
    info = {
      projectRoot: isTopLevel ? realPathOrSelf(topLevelProjectRoot) : cwd,
      branch: layout.branch,
      isWorktree: isWorktreeTopLevel,
      isTopLevel,
    };
  } catch {
    info = { projectRoot: cwd, branch: null, isWorktree: false, isTopLevel: false };
  }

  cache.set(cwd, { info, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });
  return info;
}

// ============================================================================
// Worktree operations
//
// These take any directory inside the repo (a worktree, the main checkout, or
// a subdirectory) and resolve the main repo root themselves via the git
// common dir, so callers can pass session cwds directly.
// ============================================================================

/** Main repo root (parent of the shared .git dir), or throws for non-git dirs */
async function getRepoRoot(cwd: string): Promise<string> {
  return realPathOrSelf((await readRepositoryLayout(cwd)).mainRoot);
}

export function parseWorktreePorcelainV1Z(output: string): WorktreePorcelainRecord[] {
  const records: WorktreePorcelainRecord[] = [];
  let current: WorktreePorcelainRecord | null = null;
  const flush = () => {
    if (current?.path) records.push(current);
    current = null;
  };

  for (const field of output.split("\0")) {
    if (field === "") {
      flush();
    } else if (field.startsWith("worktree ")) {
      flush();
      current = {
        path: toNativePath(field.slice("worktree ".length)),
        branch: null,
        bare: false,
        prunable: false,
      };
    } else if (field.startsWith("branch ") && current) {
      current.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (field === "bare" && current) {
      current.bare = true;
    } else if ((field === "prunable" || field.startsWith("prunable ")) && current) {
      current.prunable = true;
    }
  }
  flush();
  return records;
}

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const layout = await readRepositoryLayout(cwd);
  return layout.worktrees.flatMap((record, index): WorktreeInfo[] => {
    // A bare common repository appears as the first porcelain record but is
    // not a browsable worktree and must never become a removable "main" row.
    if (record.bare || record.prunable) return [];
    const canonicalPath = safeCanonicalDirectory(record.path);
    if (!canonicalPath) return [];
    return [{
      path: canonicalPath,
      branch: record.branch,
      isMain: index === 0,
    }];
  });
}

function findWorktreeByPath(worktrees: readonly WorktreeInfo[], candidate: string): WorktreeInfo | undefined {
  return worktrees.find((worktree) => samePath(worktree.path, candidate));
}

export function findCurrentWorktreePath(worktrees: readonly WorktreeInfo[], cwd: string): string | null {
  return findWorktreeByPath(worktrees, realPathOrSelf(cwd))?.path ?? null;
}

function sanitizeBranchForDir(branch: string): string {
  const sanitized = branch.replace(/[\/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized)
    ? `_${sanitized}`
    : sanitized;
}

function assertSafeWorktreeBase(baseDir: string): DirectoryIdentity {
  if (!existsSync(baseDir)) {
    try {
      mkdirSync(baseDir, { mode: 0o700 });
    } catch (error) {
      if (!existsSync(baseDir)) throw error;
    }
  }
  try {
    return readSafeDirectoryIdentity(baseDir);
  } catch {
    throw new Error(`Unsafe worktree directory: ${baseDir}`);
  }
}

async function validateBranchName(cwd: string, branch: string): Promise<void> {
  let normalized: string;
  try {
    normalized = await gitLine(cwd, ["check-ref-format", "--branch", branch]);
  } catch {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  // check-ref-format expands @{-N}; accepting that would make the requested
  // name differ from the branch and directory shown to the user.
  if (normalized !== branch) throw new Error(`Invalid branch name: ${branch}`);
}

export async function addWorktree(
  cwd: string,
  branch: string,
  scope?: AllowedRootScope,
): Promise<{ path: string; branch: string }> {
  const trimmed = branch.trim();
  if (!trimmed) throw new Error("Branch name is required");

  const dirName = sanitizeBranchForDir(trimmed);
  if (!dirName) throw new Error(`Invalid branch name: ${branch}`);

  const repoRoot = await getRepoRoot(cwd);
  const repoIdentity = readSafeDirectoryIdentity(repoRoot);
  await validateBranchName(repoRoot, trimmed);
  const baseDir = `${resolve(repoRoot)}-worktrees`;
  const worktreePath = join(baseDir, dirName);
  if (existsSync(worktreePath)) {
    throw new Error(`Directory already exists: ${worktreePath}`);
  }
  const baseIdentity = assertSafeWorktreeBase(baseDir);

  // Reuse the branch if it already exists, otherwise create it at HEAD.
  let branchExists = false;
  try {
    await runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${trimmed}`]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  try {
    assertDirectoryIdentity(repoRoot, repoIdentity);
    assertDirectoryIdentity(baseDir, baseIdentity);
    if (branchExists) {
      await runGit(repoRoot, ["worktree", "add", "--", worktreePath, trimmed]);
    } else {
      await runGit(repoRoot, ["worktree", "add", "-b", trimmed, "--", worktreePath]);
    }
    assertDirectoryIdentity(repoRoot, repoIdentity);
    assertDirectoryIdentity(baseDir, baseIdentity);
  } catch (error) {
    throw new Error(extractGitError(error));
  }

  const worktreeIdentity = readSafeDirectoryIdentity(worktreePath);
  if (!samePath(dirname(worktreeIdentity.canonicalPath), baseIdentity.canonicalPath)) {
    throw new Error("Unsafe worktree directory");
  }
  const grantedPath = allowFileRoot(worktreeIdentity.canonicalPath, scope);
  invalidateProjectCache();
  return { path: grantedPath, branch: trimmed };
}

export async function removeWorktree(
  cwd: string,
  worktreePath: string,
  force = false,
  scope?: AllowedRootScope,
): Promise<void> {
  const repoRoot = await getRepoRoot(cwd);
  const repoIdentity = readSafeDirectoryIdentity(repoRoot);
  const worktrees = await listWorktrees(repoRoot);
  const target = findWorktreeByPath(worktrees, worktreePath);
  if (!target) throw new Error(`Not a worktree of this repository: ${worktreePath}`);
  if (target.isMain) throw new Error("Cannot remove the main worktree");
  const targetIdentity = readSafeDirectoryIdentity(target.path);

  try {
    assertDirectoryIdentity(repoRoot, repoIdentity);
    assertDirectoryIdentity(target.path, targetIdentity);
    await runGit(repoRoot, ["worktree", "remove", ...(force ? ["--force"] : []), "--", target.path]);
    assertDirectoryIdentity(repoRoot, repoIdentity);
  } catch (error) {
    throw new Error(extractGitError(error));
  }
  revokeFileRoot(target.path, scope);
  invalidateProjectCache();
}

function extractGitError(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}
