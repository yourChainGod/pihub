import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { allowFileRoot, revokeFileRoot } = await jiti.import("../../../../lib/file-access.ts");

const deviceId = `dev_${"B".repeat(22)}`;
const scope = { ownerId: deviceId };

function request(body, headers = {}) {
  return new NextRequest("http://localhost/api/pihub/files", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      "x-pihub-authenticated-device": deviceId,
      "x-pihub-authenticated-capabilities": "files:write",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("file mutations require trusted authentication and return private errors", async () => {
  const response = await POST(new NextRequest("http://localhost/api/pihub/files", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: "{}",
  }));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("cache-control"), /private/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("writes replace regular files without temporary remnants and reject symlinks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-mutation-route-"));
  const target = path.join(root, "report.txt");
  fs.writeFileSync(target, "old");
  allowFileRoot(root, scope);
  t.after(() => {
    revokeFileRoot(root, scope);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const response = await POST(request({ action: "write", path: target, content: "new" }));
  assert.equal(response.status, 200);
  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(root), ["report.txt"]);
  assert.match(response.headers.get("cache-control"), /no-store/);

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
  const denied = await POST(request({ action: "write", path: link, content: "bad" }));
  assert.equal(denied.status, 403);
  assert.equal(fs.readFileSync(target, "utf8"), "new");
});

test("rejects file content above the hard limit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-mutation-limit-"));
  allowFileRoot(root, scope);
  t.after(() => {
    revokeFileRoot(root, scope);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const response = await POST(request({
    action: "write",
    path: path.join(root, "large.txt"),
    content: "x".repeat(5 * 1024 * 1024 + 1),
  }));
  assert.equal(response.status, 413);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("portable aliases cannot create, overwrite, rename, or move ambiguous entries", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-mutation-portable-"));
  allowFileRoot(root, scope);
  t.after(() => {
    revokeFileRoot(root, scope);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, "alpha.txt"), "original");
  fs.writeFileSync(path.join(root, "touch.txt"), "existing");
  fs.mkdirSync(path.join(root, "folder"));
  fs.writeFileSync(path.join(root, "rename-target.txt"), "target");
  fs.writeFileSync(path.join(root, "rename-source.txt"), "source");
  fs.writeFileSync(path.join(root, "move-target.txt"), "target");
  fs.writeFileSync(path.join(root, "move-source.txt"), "source");

  const cases = [
    { action: "write", path: path.join(root, "ALPHA.TXT"), content: "bad" },
    { action: "touch", path: root, name: "TOUCH.TXT" },
    { action: "mkdir", path: root, name: "FOLDER" },
    {
      action: "rename",
      path: path.join(root, "rename-source.txt"),
      destination: "RENAME-TARGET.TXT",
    },
    {
      action: "move",
      path: path.join(root, "move-source.txt"),
      destination: path.join(root, "MOVE-TARGET.TXT"),
    },
  ];

  for (const body of cases) {
    const response = await POST(request(body));
    assert.equal(response.status, 409, `${body.action}: ${await response.text()}`);
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
  assert.equal(fs.readFileSync(path.join(root, "alpha.txt"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(root, "rename-source.txt"), "utf8"), "source");
  assert.equal(fs.readFileSync(path.join(root, "move-source.txt"), "utf8"), "source");
  assert.equal(fs.readdirSync(root).some((name) => name === "ALPHA.TXT"), false);
  assert.equal(fs.readdirSync(root).some((name) => name === "FOLDER"), false);
});

test("authorized workspace roots cannot be deleted and the refusal is private", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-mutation-root-"));
  allowFileRoot(root, scope);
  t.after(() => {
    revokeFileRoot(root, scope);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const response = await POST(request({ action: "delete", path: root }));
  assert.equal(response.status, 400);
  assert.equal(fs.statSync(root).isDirectory(), true);
  assert.deepEqual(await response.json(), { error: "Cannot modify an authorized workspace root" });
  assert.match(response.headers.get("cache-control"), /private/);
  assert.match(response.headers.get("cache-control"), /no-store/);

  const caseAlias = path.join(path.dirname(root), path.basename(root).toUpperCase());
  if (caseAlias !== root && fs.existsSync(caseAlias)) {
    const aliasResponse = await POST(request({ action: "delete", path: caseAlias }));
    assert.notEqual(aliasResponse.status, 200);
    assert.equal(fs.statSync(root).isDirectory(), true);
    assert.match(aliasResponse.headers.get("cache-control"), /no-store/);
  }
});
