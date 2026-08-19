import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
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

const DEVICE_A = `dev_${"A".repeat(22)}`;
const DEVICE_B = `dev_${"B".repeat(22)}`;

function trustedHeaders(deviceId, capability, json = false) {
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    "x-pihub-authenticated-device": deviceId,
    "x-pihub-authenticated-capabilities": capability,
  };
}

function assertPrivate(response) {
  assert.match(response.headers.get("cache-control") ?? "", /\bprivate\b/);
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/);
}

const routeCases = [
  {
    name: "default cwd POST",
    path: "./default-cwd/route.ts",
    handler: "POST",
    capability: "workspaces:manage",
    request: (headers) => new Request("http://localhost/api/default-cwd", { method: "POST", headers }),
  },
  {
    name: "file index GET",
    path: "./file-index/route.ts",
    handler: "GET",
    capability: "files:read",
    request: (headers) => new NextRequest("http://localhost/api/file-index", { headers }),
  },
  {
    name: "models GET",
    path: "./models/route.ts",
    handler: "GET",
    capability: "models:read",
    request: (headers) => new Request("http://localhost/api/models", { headers }),
  },
  {
    name: "skills check POST",
    path: "./skills/check/route.ts",
    handler: "POST",
    capability: "packages:read",
    request: (headers) => new Request("http://localhost/api/skills/check", { method: "POST", headers }),
  },
  {
    name: "skills GET",
    path: "./skills/route.ts",
    handler: "GET",
    capability: "packages:read",
    request: (headers) => new Request("http://localhost/api/skills", { headers }),
  },
  {
    name: "skills PATCH",
    path: "./skills/route.ts",
    handler: "PATCH",
    capability: "packages:manage",
    request: (headers) => new Request("http://localhost/api/skills", { method: "PATCH", headers }),
  },
  {
    name: "skills update POST",
    path: "./skills/update/route.ts",
    handler: "POST",
    capability: "packages:manage",
    request: (headers) => new Request("http://localhost/api/skills/update", { method: "POST", headers }),
  },
  {
    name: "skills install POST",
    path: "./skills/install/route.ts",
    handler: "POST",
    capability: "packages:manage",
    request: (headers) => new Request("http://localhost/api/skills/install", { method: "POST", headers }),
  },
  {
    name: "plugins GET",
    path: "./plugins/route.ts",
    handler: "GET",
    capability: "packages:read",
    request: (headers) => new Request("http://localhost/api/plugins", { headers }),
  },
  {
    name: "plugins POST",
    path: "./plugins/route.ts",
    handler: "POST",
    capability: "packages:manage",
    request: (headers) => new Request("http://localhost/api/plugins", { method: "POST", headers }),
  },
  {
    name: "updates GET",
    path: "./pihub/updates/route.ts",
    handler: "GET",
    capability: "system:update",
    request: (headers) => new NextRequest("http://localhost/api/pihub/updates", { headers }),
  },
  {
    name: "updates POST",
    path: "./pihub/updates/route.ts",
    handler: "POST",
    capability: "system:update",
    request: (headers) => new NextRequest("http://localhost/api/pihub/updates", { method: "POST", headers }),
  },
];

test("sensitive workspace and package routes require trusted device capabilities", async () => {
  for (const routeCase of routeCases) {
    const source = await readFile(new URL(routeCase.path, import.meta.url), "utf8");
    assert.equal(
      source.includes(`capabilities.includes("${routeCase.capability}")`),
      true,
      `${routeCase.name} must enforce ${routeCase.capability}`,
    );
    assert.match(source, /Cache-Control", "private, no-store"/);
    assert.doesNotMatch(source, /getAllowedFileRoots\(\)/);
    assert.doesNotMatch(source, /isApiRequestAllowed/);

    const route = await jiti.import(routeCase.path);
    const handler = route[routeCase.handler];

    const unauthenticated = await handler(routeCase.request({}));
    assert.equal(unauthenticated.status, 401, routeCase.name);
    assertPrivate(unauthenticated);

    const wrongCapability = await handler(routeCase.request(
      trustedHeaders(DEVICE_A, "devices:manage"),
    ));
    assert.equal(wrongCapability.status, 403, routeCase.name);
    assertPrivate(wrongCapability);
  }
});

test("file index roots are isolated by authenticated device", async (t) => {
  const source = await readFile(new URL("./file-index/route.ts", import.meta.url), "utf8");
  assert.match(source, /fs\.opendirSync\(abs\)/);
  assert.match(source, /directory\.readSync\(\)/);
  assert.doesNotMatch(source, /readdirSync|queue\.shift\(\)/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-scoped-index-"));
  fs.writeFileSync(path.join(root, "private.txt"), "private");
  const { allowFileRoot, revokeFileRoot } = await jiti.import("../../lib/file-access.ts");
  const { GET } = await jiti.import("./file-index/route.ts");
  const canonicalRoot = allowFileRoot(root, { ownerId: DEVICE_A });
  t.after(() => {
    revokeFileRoot(root, { ownerId: DEVICE_A });
    fs.rmSync(root, { recursive: true, force: true });
  });

  const request = (deviceId) => new NextRequest(
    `http://localhost/api/file-index?cwd=${encodeURIComponent(canonicalRoot)}`,
    { headers: trustedHeaders(deviceId, "files:read") },
  );

  const denied = await GET(request(DEVICE_B));
  assert.equal(denied.status, 403);
  assertPrivate(denied);

  const allowed = await GET(request(DEVICE_A));
  assert.equal(allowed.status, 200);
  assertPrivate(allowed);
  assert.deepEqual(await allowed.json(), { files: ["private.txt"], truncated: false });
});
