import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");

const DEVICE_ID = "dev_DDDDDDDDDDDDDDDDDDDDDD";

function request(capability) {
  return new Request("http://localhost/api/home", {
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

test("home requires workspace-read authentication", async () => {
  const unauthenticated = await GET(request());
  assert.equal(unauthenticated.status, 401);
  assertPrivateNoStore(unauthenticated);

  const wrongCapability = await GET(request("devices:manage"));
  assert.equal(wrongCapability.status, 403);
  assertPrivateNoStore(wrongCapability);
});

test("home returns the path privately for an authorized device", async () => {
  const response = await GET(request("workspaces:read"));
  assert.equal(response.status, 200);
  assertPrivateNoStore(response);
  assert.deepEqual(await response.json(), { home: os.homedir() });
});
