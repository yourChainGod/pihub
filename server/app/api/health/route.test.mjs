import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");

test("health exposes only bounded public status, version, and authentication metadata", async (t) => {
  const previousVersion = process.env.PIHUB_SERVER_VERSION;
  process.env.PIHUB_SERVER_VERSION = "0.0.1";
  t.after(() => {
    if (previousVersion === undefined) delete process.env.PIHUB_SERVER_VERSION;
    else process.env.PIHUB_SERVER_VERSION = previousVersion;
  });

  const response = GET();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.deepEqual(Object.keys(body).sort(), ["authentication", "status", "version"]);
  assert.equal(body.status, "ok");
  assert.equal(body.version, "0.0.1");
  assert.equal(typeof body.authentication?.epoch, "string");
  assert.equal(JSON.stringify(body).includes(process.cwd()), false);
});

test("health does not publish an invalid ambient version", async (t) => {
  const previousVersion = process.env.PIHUB_SERVER_VERSION;
  process.env.PIHUB_SERVER_VERSION = "private/path-canary";
  t.after(() => {
    if (previousVersion === undefined) delete process.env.PIHUB_SERVER_VERSION;
    else process.env.PIHUB_SERVER_VERSION = previousVersion;
  });

  const body = await GET().json();
  assert.equal(body.version, null);
  assert.equal(JSON.stringify(body).includes("private/path-canary"), false);
});
