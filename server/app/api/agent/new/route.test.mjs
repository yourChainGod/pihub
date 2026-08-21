import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
const { allowFileRoot, revokeFileRoot } = await jiti.import("../../../../lib/allowed-roots.ts");

const DEVICE_A = "dev_AAAAAAAAAAAAAAAAAAAAAA";
const DEVICE_B = "dev_BBBBBBBBBBBBBBBBBBBBBB";
const AUTHENTICATED_HEADERS = {
  "Content-Type": "application/json",
  "x-pihub-authenticated-device": DEVICE_B,
  "x-pihub-authenticated-capabilities": "agents:use",
};

test("new-agent requests reject the filesystem root before session startup", async () => {
  // Self-hosted tailnet policy: only the filesystem root itself is protected;
  // home and other directories are grantable workspaces.
  const cwd = path.parse(os.homedir()).root;
  const response = await POST(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: AUTHENTICATED_HEADERS,
    body: JSON.stringify({ cwd, type: "ensure_session" }),
  }));

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match((await response.json()).error, /protected/i);
});

test("new-agent prompt rejection preserves the response contract", async () => {
  const response = await POST(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: AUTHENTICATED_HEADERS,
    body: JSON.stringify({ cwd: path.parse(os.homedir()).root, type: "prompt", message: "hello" }),
  }));

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Workspace directory is protected",
    code: "prompt_rejected",
    accepted: false,
  });
});

test("new-agent requests require trusted proxy context", async () => {
  const response = await POST(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: os.homedir(), type: "ensure_session" }),
  }));

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("new-agent rejects an ungranted safe cwd before session startup", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-web-agent-ungranted-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const response = await POST(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: AUTHENTICATED_HEADERS,
    body: JSON.stringify({ cwd, type: "ensure_session" }),
  }));

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
});

test("new-agent cannot use a cwd granted to another device", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-web-agent-owner-scope-"));
  allowFileRoot(cwd, { ownerId: DEVICE_A });
  t.after(async () => {
    revokeFileRoot(cwd, { ownerId: DEVICE_A });
    await rm(cwd, { recursive: true, force: true });
  });

  const response = await POST(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: AUTHENTICATED_HEADERS,
    body: JSON.stringify({ cwd, type: "ensure_session" }),
  }));

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
});
