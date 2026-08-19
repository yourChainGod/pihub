import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
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
const { GET } = await jiti.import("./route.ts");

const DEVICE_ID = "dev_CCCCCCCCCCCCCCCCCCCCCC";

function request(capability) {
  return new NextRequest("http://localhost/api/cwd/browse", {
    headers: capability
      ? {
          "x-pihub-authenticated-device": DEVICE_ID,
          "x-pihub-authenticated-capabilities": capability,
        }
      : {},
  });
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
}

test("cwd browse requires workspace-read authentication", async () => {
  const unauthenticated = await GET(request());
  assert.equal(unauthenticated.status, 401);
  assertPrivateNoStore(unauthenticated);

  const wrongCapability = await GET(request("devices:manage"));
  assert.equal(wrongCapability.status, 403);
  assertPrivateNoStore(wrongCapability);
});

test("cwd browse returns private, non-cacheable directory results", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pihub-cwd-browse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "project"));

  const response = await GET(new NextRequest(
    `http://localhost/api/cwd/browse?path=${encodeURIComponent(root)}`,
    {
      headers: {
        "x-pihub-authenticated-device": DEVICE_ID,
        "x-pihub-authenticated-capabilities": "workspaces:read",
      },
    },
  ));

  assert.equal(response.status, 200);
  assertPrivateNoStore(response);
  const body = await response.json();
  const canonicalRoot = await realpath(root);
  assert.equal(body.path, canonicalRoot);
  assert.deepEqual(body.directories, [{
    name: "project",
    path: path.join(canonicalRoot, "project"),
  }]);
});
