import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./route.ts");

const DEVICE_ID = `dev_${"S".repeat(22)}`;
const TRUSTED_HEADERS = {
  host: "localhost:30141",
  origin: "http://localhost:30141",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
  "x-pihub-authenticated-device": DEVICE_ID,
  "x-pihub-authenticated-capabilities": "system:manage",
};

function request(method, body, headers = TRUSTED_HEADERS) {
  return new NextRequest("http://localhost:30141/api/pihub/setup", {
    method,
    headers,
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

function assertPrivate(response) {
  const policy = response.headers.get("cache-control") ?? "";
  assert.match(policy, /\bprivate\b/);
  assert.match(policy, /\bno-store\b/);
}

test("requires system:manage at the route boundary", async () => {
  const unauthenticated = await route.GET(request("GET", undefined, {
    host: "localhost:30141",
  }));
  assert.equal(unauthenticated.status, 401);
  assertPrivate(unauthenticated);

  const forbidden = await route.POST(request("POST", { action: "provider-install" }, {
    ...TRUSTED_HEADERS,
    "x-pihub-authenticated-capabilities": "system:update",
  }));
  assert.equal(forbidden.status, 403);
  assertPrivate(forbidden);
});

test("returns a bounded, private default-extension status", async () => {
  const response = await route.GET(request("GET"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assertPrivate(response);
  assert.equal(body.defaultExtensions.source, "signed-release");
  assert.equal(body.defaultExtensions.total, 7);
  assert.equal(body.defaultExtensions.packages.length, 7);
  assert.equal(body.defaultExtensions.installedCount >= 0, true);
  assert.equal(body.defaultExtensions.installedCount <= 7, true);
  assert.equal(JSON.stringify(body).includes(process.cwd()), false);
});

test("reports the bundled pi version and per-package installed versions", async () => {
  const response = await route.GET(request("GET"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(typeof body.pi.installed, "boolean");
  assert.ok(body.pi.version === null || typeof body.pi.version === "string");
  if (body.pi.installed) assert.match(body.pi.version, /^\d+\.\d+\.\d+/);
  for (const entry of body.defaultExtensions.packages) {
    assert.equal(typeof entry.version, "string");
    assert.ok(entry.installedVersion === null || typeof entry.installedVersion === "string");
  }
});

test("retires legacy Magic Context actions without executing setup commands", async () => {
  for (const action of ["magic-context-install", "magic-context-doctor"]) {
    const response = await route.POST(request("POST", { action }));
    const body = await response.json();
    assert.equal(response.status, 410);
    assert.equal(body.code, "legacy_extension_action_removed");
    assert.match(body.replacement, /signed PiHub Server release/);
    assertPrivate(response);
  }
});

test("rejects unbounded, malformed, and ambiguous setup input", async () => {
  const oversized = await route.POST(request("POST", JSON.stringify({
    action: "tailscale-serve",
    padding: "x".repeat(9 * 1024),
  })));
  assert.equal(oversized.status, 413);
  assertPrivate(oversized);

  const malformed = await route.POST(request("POST", "{"));
  assert.equal(malformed.status, 400);
  assertPrivate(malformed);

  const extraField = await route.POST(request("POST", {
    action: "provider-install",
    source: "npm:attacker-controlled",
  }));
  assert.equal(extraField.status, 400);
  assertPrivate(extraField);

  const wrongContentType = await route.POST(request("POST", { action: "provider-install" }, {
    ...TRUSTED_HEADERS,
    "content-type": "text/plain",
  }));
  assert.equal(wrongContentType.status, 415);
  assertPrivate(wrongContentType);
});

test("contains no package-manager or caller-selected subprocess path", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:npm|npx|pnpm|yarn)\s+(?:install|add|update)/i);
  assert.doesNotMatch(source, /child_process|execFile|spawn\s*\(/);
  assert.match(source, /requirePihubRouteCapability\(request, "system:manage"\)/);
  assert.match(source, /readBoundedJsonRequest\(request, MAX_SETUP_BODY_BYTES\)/);
});
