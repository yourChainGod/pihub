import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { projectIdentityKey } = await jiti.import("../../../../lib/project-identity.ts");
const {
  allowedRootKey,
  getAdditionalAllowedRoots,
} = await jiti.import("../../../../lib/allowed-roots.ts");

const DEVICE_ID = "dev_AAAAAAAAAAAAAAAAAAAAAA";
const AUTHENTICATED_HEADERS = {
  "Content-Type": "application/json",
  "x-pihub-authenticated-device": DEVICE_ID,
  "x-pihub-authenticated-capabilities": "workspaces:manage",
};

test("validated cwd responses include server-resolved project identity", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-web-cwd-validate-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const canonicalCwd = await realpath(cwd);

  const response = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST",
    headers: AUTHENTICATED_HEADERS,
    body: JSON.stringify({ cwd, ownerId: "attacker-selected-owner" }),
  }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    success: true,
    cwd: canonicalCwd,
    projectRoot: canonicalCwd,
    projectKey: projectIdentityKey(canonicalCwd),
  });
  const canonicalKey = allowedRootKey(canonicalCwd);
  assert.equal(getAdditionalAllowedRoots({ ownerId: DEVICE_ID }).has(canonicalKey), true);
  assert.equal(
    getAdditionalAllowedRoots({ ownerId: "attacker-selected-owner" }).has(canonicalKey),
    false,
  );
});

test("returns a symlink-free canonical cwd", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-web-cwd-canonical-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const realDirectory = path.join(base, "real");
  const link = path.join(base, "link");
  await mkdir(realDirectory);
  await symlink(realDirectory, link, process.platform === "win32" ? "junction" : "dir");

  const response = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST",
    headers: AUTHENTICATED_HEADERS,
    body: JSON.stringify({ cwd: link }),
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.cwd, await realpath(realDirectory));
  assert.equal(body.projectRoot, await realpath(realDirectory));
});

test("rejects the filesystem root without caching; home and system directories are grantable", async () => {
  const root = path.parse(os.homedir()).root;
  const response = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST",
    headers: AUTHENTICATED_HEADERS,
    body: JSON.stringify({ cwd: root }),
  }));
  assert.equal(response.status, 403, root);
  assert.equal(response.headers.get("cache-control"), "private, no-store");

  // Self-hosted tailnet policy: home and system directories can be workspaces.
  const systemDirectory = process.platform === "win32" ? process.env.SystemRoot : "/etc";
  for (const cwd of ["~", systemDirectory].filter(Boolean)) {
    const allowed = await POST(new Request("http://localhost/api/cwd/validate", {
      method: "POST",
      headers: AUTHENTICATED_HEADERS,
      body: JSON.stringify({ cwd }),
    }));
    assert.equal(allowed.status, 200, String(cwd));
  }
});

test("rejects relative paths, files, and missing directories before granting them", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-web-cwd-invalid-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = path.join(base, "file.txt");
  await writeFile(file, "not a directory");

  for (const cwd of [".", file, path.join(base, "missing")]) {
    const response = await POST(new Request("http://localhost/api/cwd/validate", {
      method: "POST",
      headers: AUTHENTICATED_HEADERS,
      body: JSON.stringify({ cwd }),
    }));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
});

test("requires trusted workspace-management context", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-web-cwd-auth-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const unauthenticatedResponse = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  }));
  assert.equal(unauthenticatedResponse.status, 401);
  assert.equal(unauthenticatedResponse.headers.get("cache-control"), "private, no-store");

  const readOnly = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST",
    headers: {
      ...AUTHENTICATED_HEADERS,
      "x-pihub-authenticated-capabilities": "workspaces:read",
    },
    body: JSON.stringify({ cwd }),
  }));
  assert.equal(readOnly.status, 403);
  assert.equal(readOnly.headers.get("cache-control"), "private, no-store");
});
