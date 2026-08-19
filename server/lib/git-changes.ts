import fs from "fs";
import path from "path";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import { runGit } from "./git-command";
import { toNativePath } from "./paths";
import type {
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types";
import {
  classifyGitStatus,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";

interface GitRepository {
  root: string;
  bare: boolean;
}

function stripCommandLineEnding(output: string): string {
  if (output.endsWith("\r\n")) return output.slice(0, -2);
  if (output.endsWith("\n")) return output.slice(0, -1);
  return output;
}

async function findRepository(cwd: string): Promise<GitRepository | null> {
  try {
    const bare = stripCommandLineEnding(
      await runGit(cwd, ["rev-parse", "--is-bare-repository"]),
    ) === "true";
    const root = toNativePath(stripCommandLineEnding(await runGit(cwd, [
      "rev-parse",
      "--path-format=absolute",
      bare ? "--git-common-dir" : "--show-toplevel",
    ])));
    if (!root) return null;
    const canonicalCwd = fs.realpathSync.native(cwd);
    const canonicalRoot = fs.realpathSync.native(root);
    if (
      !fs.statSync(canonicalRoot).isDirectory()
      || !isWithinPath(canonicalRoot, canonicalCwd)
    ) {
      return null;
    }
    return { root: canonicalRoot, bare };
  } catch {
    return null;
  }
}

function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalFilePath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
    } catch {
      return path.resolve(filePath);
    }
  }
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function readRegularFileLimited(filePath: string, maxBytes: number): Buffer | null {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > maxBytes) return null;

    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = fs.readSync(descriptor, content, offset, content.length - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return null;
    return content;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

async function readStatusEntries(repositoryRoot: string): Promise<GitPorcelainEntry[]> {
  const output = await runGit(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

async function readTrackedLineStats(
  repositoryRoot: string,
  cwd: string,
): Promise<{ additions: number; deletions: number }> {
  const relativeCwd = toGitPath(path.relative(repositoryRoot, cwd));
  const pathspec = relativeCwd || ".";
  try {
    const output = await runGit(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "HEAD",
      "--",
      pathspec,
    ]);
    let additions = 0;
    let deletions = 0;
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [added, deleted] = line.split("\t", 2);
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (Number.isInteger(addedCount)) additions += addedCount;
      if (Number.isInteger(deletedCount)) deletions += deletedCount;
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

function countUntrackedTextLines(filePath: string): number {
  const content = readRegularFileLimited(filePath, TEXT_PREVIEW_MAX_BYTES);
  if (!content || hasNullByte(content) || content.length === 0) return 0;
  const text = content.toString("utf8");
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  const repository = await findRepository(cwd);
  if (!repository) {
    return {
      isGitRepository: false,
      isBareRepository: false,
      repositoryRoot: null,
      files: [],
      additions: 0,
      deletions: 0,
    };
  }
  const { root: repositoryRoot, bare } = repository;
  if (bare) {
    return {
      isGitRepository: true,
      isBareRepository: true,
      repositoryRoot,
      files: [],
      additions: 0,
      deletions: 0,
    };
  }

  // git reports the repository root with symlinks resolved (e.g. macOS maps
  // /tmp → /private/tmp), while sessions store the unresolved cwd. Compare
  // against the real path or every file gets filtered out as "outside cwd".
  let effectiveCwd = cwd;
  try { effectiveCwd = fs.realpathSync(cwd); } catch { /* keep original */ }

  const [entries, trackedLineStats] = await Promise.all([
    readStatusEntries(repositoryRoot),
    readTrackedLineStats(repositoryRoot, effectiveCwd),
  ]);
  const files = entries.flatMap((entry): GitFileStatus[] => {
    const filePath = path.resolve(repositoryRoot, entry.path);
    if (!isWithinPath(effectiveCwd, filePath)) return [];
    const classified = classifyGitStatus(entry);
    return [{
      filePath,
      ...classified,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    }];
  });
  const untrackedAdditions = files.reduce(
    (total, file) => total + (file.status === "untracked" ? countUntrackedTextLines(file.filePath) : 0),
    0,
  );

  return {
    isGitRepository: true,
    isBareRepository: false,
    repositoryRoot,
    files,
    additions: trackedLineStats.additions + untrackedAdditions,
    deletions: trackedLineStats.deletions,
  };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function quotePatchPath(prefix: "a" | "b", gitPath: string): string {
  const value = `${prefix}/${gitPath}`;
  return /[\u0000-\u0020\u007f"\\]/.test(value) ? JSON.stringify(value) : value;
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git ${quotePatchPath("a", gitPath)} ${quotePatchPath("b", gitPath)}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ ${quotePatchPath("b", gitPath)}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await runGit(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], { maxBuffer: TEXT_PREVIEW_MAX_BYTES * 4 });
  } catch {
    return null;
  }
}

export async function getGitFileDiff(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  const repository = await findRepository(cwd);
  const canonicalPath = canonicalFilePath(filePath);
  if (!repository || repository.bare || !isWithinPath(repository.root, canonicalPath)) return { supported: false };
  const repositoryRoot = repository.root;

  const resolvedFilePath = path.resolve(canonicalPath);
  const relativePath = toGitPath(path.relative(repositoryRoot, resolvedFilePath));
  const entries = await readStatusEntries(repositoryRoot);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") {
    const patch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath);
    if (!patch?.includes("\n@@ ")) return { supported: false };
    return { supported: true, status, patch };
  }

  const currentBuffer = readRegularFileLimited(resolvedFilePath, TEXT_PREVIEW_MAX_BYTES);
  if (!currentBuffer || hasNullByte(currentBuffer)) return { supported: false };
  const newContent = currentBuffer.toString("utf8");

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  if (!patch.includes("\n@@ ")) return { supported: false };
  return { supported: true, status, patch };
}
