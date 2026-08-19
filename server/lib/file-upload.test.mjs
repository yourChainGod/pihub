import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url, { interopDefault: true }).import("./file-upload.ts");
}

test("validates upload names without accepting paths or duplicates", async () => {
  const { validateUploadFileNames } = await loadSubject();

  assert.equal(validateUploadFileNames(["one.txt", "two file.md"]), null);
  assert.match(validateUploadFileNames(["../secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames(["same.txt", "SAME.TXT"]), /Duplicate/);
  assert.match(validateUploadFileNames(["\u00e9.txt", "e\u0301.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames(["\u03c3.txt", "\u03c2.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames(["report.txt:secret"]), /not portable/);
  assert.match(validateUploadFileNames(["CON.txt"]), /Reserved Windows/);
  assert.match(validateUploadFileNames(["CON .txt"]), /Reserved Windows/);
  assert.match(validateUploadFileNames(["COM\u00b9.log"]), /Reserved Windows/);
  assert.match(validateUploadFileNames(["report.txt."]), /end in a dot or space/);
  assert.match(validateUploadFileNames(["report.txt "]), /end in a dot or space/);
  assert.match(validateUploadFileNames([]), /No files/);
});

test("finds conflicts and prevents replacing directories", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  fs.mkdirSync(path.join(root, "directory"));

  assert.deepEqual(
    inspectUploadTargets(root, ["new.txt", "file.txt", "directory"]),
    {
      conflicts: ["file.txt", "directory"],
      nonReplaceable: ["directory"],
    },
  );
});

test("fails closed for existing portable case and Unicode aliases", async (t) => {
  const {
    assertPortableFileNameAvailable,
    inspectUploadTargets,
    writeUploadFileAtomically,
  } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-upload-portable-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "alpha.txt"), "case");
  fs.writeFileSync(path.join(root, "\u00e9.txt"), "unicode");
  const unicodeActual = fs.readdirSync(root).find((name) => name !== "alpha.txt");
  const unicodeAlias = unicodeActual === "\u00e9.txt" ? "e\u0301.txt" : "\u00e9.txt";

  assert.deepEqual(inspectUploadTargets(root, ["ALPHA.TXT", unicodeAlias]), {
    conflicts: ["ALPHA.TXT", unicodeAlias],
    nonReplaceable: ["ALPHA.TXT", unicodeAlias],
  });
  assert.throws(
    () => assertPortableFileNameAvailable(root, "ALPHA.TXT", true),
    (error) => error?.code === "EEXIST",
  );
  assert.throws(
    () => writeUploadFileAtomically(root, "ALPHA.TXT", Buffer.from("bad"), true),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(fs.readFileSync(path.join(root, "alpha.txt"), "utf8"), "case");
  assert.equal(fs.readdirSync(root).includes("ALPHA.TXT"), false);
});

test("portable collision scans are bounded and fail closed", async (t) => {
  const {
    assertPortableFileNameAvailable,
    UploadDirectoryScanLimitError,
  } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-upload-bounded-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "one.txt"), "1");
  fs.writeFileSync(path.join(root, "two.txt"), "2");

  assert.throws(
    () => assertPortableFileNameAvailable(root, "new.txt", false, 1),
    UploadDirectoryScanLimitError,
  );
});

test("prevents replacing symbolic links", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  try {
    fs.symlinkSync("file.txt", path.join(root, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(
    inspectUploadTargets(root, ["link.txt"]),
    {
      conflicts: ["link.txt"],
      nonReplaceable: ["link.txt"],
    },
  );
});

test("parses only supported conflict strategies", async () => {
  const { parseUploadConflictStrategy } = await loadSubject();

  assert.equal(parseUploadConflictStrategy(null), "error");
  assert.equal(parseUploadConflictStrategy("overwrite"), "overwrite");
  assert.equal(parseUploadConflictStrategy("skip"), "skip");
  assert.equal(parseUploadConflictStrategy("rename"), null);
});

test("atomically overwrites regular files while refusing symlinks", async (t) => {
  const { writeUploadFileAtomically, UploadTargetNotReplaceableError } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "report.txt");
  fs.writeFileSync(destination, "old");

  writeUploadFileAtomically(root, "report.txt", Buffer.from("new"), true);
  assert.equal(fs.readFileSync(destination, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(root), ["report.txt"]);

  const link = path.join(root, "linked.txt");
  try {
    fs.symlinkSync("report.txt", link);
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }
  assert.throws(
    () => writeUploadFileAtomically(root, "linked.txt", Buffer.from("bad"), true),
    UploadTargetNotReplaceableError,
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "new");
});

test("uses one atomic replacement on Windows and preserves the original on failure", async (t) => {
  const { publishUploadTemporaryFile } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-rollback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "report.txt");
  const temporary = path.join(root, ".report.upload");
  fs.writeFileSync(destination, "old");
  fs.writeFileSync(temporary, "new");
  const existing = fs.lstatSync(destination);
  let renameCount = 0;
  const operations = {
    linkSync: fs.linkSync,
    lstatSync: fs.lstatSync,
    unlinkSync: fs.unlinkSync,
    renameSync() {
      renameCount += 1;
      throw new Error("simulated publish failure");
    },
  };

  assert.throws(
    () => publishUploadTemporaryFile(temporary, destination, existing, "win32", operations),
    /simulated publish failure/,
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "old");
  assert.equal(fs.readFileSync(temporary, "utf8"), "new");
  assert.equal(renameCount, 1);
});

test("directory guards reject a late symlink replacement", async (t) => {
  const {
    assertUploadDirectoryGuard,
    captureUploadDirectoryGuard,
    UploadDirectoryChangedError,
  } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-upload-guard-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const directory = path.join(base, "target");
  const moved = path.join(base, "moved");
  const outside = path.join(base, "outside");
  fs.mkdirSync(directory);
  fs.mkdirSync(outside);
  const guard = captureUploadDirectoryGuard(directory);
  fs.renameSync(directory, moved);
  try {
    fs.symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    fs.renameSync(moved, directory);
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.throws(() => assertUploadDirectoryGuard(directory, guard), UploadDirectoryChangedError);
});
