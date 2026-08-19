import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Loaded through jiti so the module's own extensionless imports resolve the way
// the app resolves them (tsconfig moduleResolution: "bundler"); bare
// `import("./path-security.ts")` only works while that file has no imports.
async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./path-security.ts");
}

async function loadAllowedRoots() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./allowed-roots.ts");
}

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const canonicalAllowed = fs.realpathSync.native(allowed);
  const target = path.join(canonicalAllowed, "link", "secret.txt");
  const roots = new Set([canonicalAllowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

test("rejects a granted root replaced by a symlink to another directory", async (t) => {
  const { isExistingPathWithinRoots, resolveExistingPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-root-rebind-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const granted = path.join(base, "granted");
  const outside = path.join(base, "outside");
  fs.mkdirSync(granted);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const canonicalGrant = fs.realpathSync.native(granted);

  fs.rmSync(granted, { recursive: true });
  fs.symlinkSync(outside, granted, process.platform === "win32" ? "junction" : "dir");
  const reboundTarget = path.join(granted, "secret.txt");
  const roots = new Set([canonicalGrant]);

  assert.equal(isExistingPathWithinRoots(reboundTarget, roots), false);
  assert.equal(resolveExistingPathWithinRoots(reboundTarget, roots), null);
});

test("uses canonical existing paths after symlink authorization", async (t) => {
  const { resolveExistingPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-canonical-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const realDirectory = path.join(allowed, "real");
  fs.mkdirSync(realDirectory, { recursive: true });
  fs.writeFileSync(path.join(realDirectory, "file.txt"), "ok");
  const link = path.join(allowed, "link");
  fs.symlinkSync(realDirectory, link, process.platform === "win32" ? "junction" : "dir");

  assert.equal(
    resolveExistingPathWithinRoots(
      path.join(link, "file.txt"),
      new Set([fs.realpathSync.native(allowed)]),
    ),
    fs.realpathSync.native(path.join(realDirectory, "file.txt")),
  );
});

test("Windows containment is case-insensitive but rejects ADS and device paths", async () => {
  const { isPathWithinRoots } = await loadSubject();
  const roots = new Set(["C:\\Work\\PiHub"]);

  assert.equal(isPathWithinRoots("c:/work/PIHUB/src/index.ts", roots), true);
  assert.equal(isPathWithinRoots("C:\\Work\\PiHub-old\\secret.txt", roots), false);
  assert.equal(isPathWithinRoots("C:\\Work\\PiHub\\secret.txt:payload", roots), false);
  assert.equal(isPathWithinRoots("\\\\?\\C:\\Work\\PiHub\\secret.txt", roots), false);
});

test("filesystem roots cannot authorize a drive, POSIX tree, or UNC share", async () => {
  const { isFilesystemRootPath, isPathWithinRoots } = await loadSubject();

  assert.equal(isFilesystemRootPath("/"), true);
  assert.equal(isFilesystemRootPath("C:\\"), true);
  assert.equal(isFilesystemRootPath("\\\\server\\share\\"), true);
  assert.equal(isPathWithinRoots("/etc/passwd", new Set(["/"])), false);
  assert.equal(isPathWithinRoots("C:\\Windows\\System32", new Set(["C:\\"])), false);
  assert.equal(
    isPathWithinRoots("\\\\server\\share\\secret.txt", new Set(["\\\\server\\share\\"])),
    false,
  );
  assert.equal(
    isPathWithinRoots(
      "\\\\SERVER\\Share\\Project\\src\\index.ts",
      new Set(["\\\\server\\share\\project"]),
    ),
    true,
  );
});

test("allowed roots are canonical, identity-scoped, and revocable", async (t) => {
  const {
    allowedRootKey,
    allowFileRoot,
    getAdditionalAllowedRoots,
    getRevokedAllowedRoots,
    revokeFileRoot,
  } = await loadAllowedRoots();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-root-scope-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const realDirectory = path.join(base, "real");
  const link = path.join(base, "link");
  fs.mkdirSync(realDirectory);
  fs.symlinkSync(realDirectory, link, process.platform === "win32" ? "junction" : "dir");
  const scopeA = { ownerId: `test-a-${base}` };
  const scopeB = { ownerId: `test-b-${base}` };

  const canonical = allowFileRoot(link, scopeA);
  const key = allowedRootKey(canonical);
  assert.equal(canonical, fs.realpathSync.native(realDirectory));
  assert.equal(getAdditionalAllowedRoots(scopeA).has(key), true);
  assert.equal(getAdditionalAllowedRoots(scopeB).has(key), false);
  const mutableSnapshot = getAdditionalAllowedRoots(scopeA);
  mutableSnapshot.clear();
  assert.equal(getAdditionalAllowedRoots(scopeA).has(key), true);
  assert.equal(revokeFileRoot(canonical, scopeA), true);
  assert.equal(revokeFileRoot(canonical, scopeA), false);
  assert.equal(getAdditionalAllowedRoots(scopeA).has(key), false);
  assert.equal(getRevokedAllowedRoots(scopeA).has(key), true);

  allowFileRoot(canonical, scopeA);
  assert.equal(getRevokedAllowedRoots(scopeA).has(key), false);
});

test("canonical root validation rejects filesystem, home, system, and file roots", async (t) => {
  const { AllowedRootError, canonicalizeAllowedFileRoot } = await loadAllowedRoots();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-root-policy-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, "file.txt");
  fs.writeFileSync(file, "not a directory");
  const systemDirectory = process.platform === "win32" ? process.env.SystemRoot : "/etc";
  if (process.platform !== "win32") {
    const systemLink = path.join(base, "system-link");
    fs.symlinkSync("/etc", systemLink, "dir");
    assert.throws(
      () => canonicalizeAllowedFileRoot(systemLink),
      (error) => error instanceof AllowedRootError && error.code === "UNSAFE_ROOT",
    );
  }

  for (const [candidate, code] of [
    [path.parse(os.homedir()).root, "UNSAFE_ROOT"],
    [os.homedir(), "UNSAFE_ROOT"],
    [systemDirectory, "UNSAFE_ROOT"],
    [file, "NOT_DIRECTORY"],
  ]) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    assert.throws(
      () => canonicalizeAllowedFileRoot(candidate),
      (error) => error instanceof AllowedRootError && error.code === code,
    );
  }
});

test("Windows allowed-root keys collapse drive and UNC casing", async () => {
  const { allowedRootKey } = await loadAllowedRoots();
  assert.equal(allowedRootKey("C:\\Work\\PiHub"), allowedRootKey("c:/work/pihub"));
  assert.equal(
    allowedRootKey("\\\\SERVER\\Share\\Project"),
    allowedRootKey("//server/share/project"),
  );
});
