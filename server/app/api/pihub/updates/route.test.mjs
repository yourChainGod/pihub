import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});
const release = await jiti.import("../../../../lib/release-manifest.ts");
const serverRelease = await jiti.import("../../../../lib/server-release.ts");
const updateIpc = await jiti.import("../../../../lib/server-update-ipc.ts");
const route = await jiti.import("./route.ts");
const originalFetch = globalThis.fetch;

const DEVICE_ID = `dev_${"U".repeat(22)}`;
const TRUSTED_HEADERS = {
  "content-type": "application/json",
  "x-pihub-authenticated-device": DEVICE_ID,
  "x-pihub-authenticated-capabilities": "system:update",
};

function request(method, body, headers = TRUSTED_HEADERS) {
  return new NextRequest("http://localhost/api/pihub/updates", {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function assertPrivate(response) {
  assert.match(response.headers.get("cache-control") ?? "", /\bprivate\b/);
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/);
}

test.afterEach(() => {
  updateIpc.setServerUpdateIpcTransportForTests(undefined);
  serverRelease.resetServerReleaseManifestCacheForTests();
  globalThis.fetch = originalFetch;
});

test("pins the public repository and delegates mutations only to stable IPC", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.equal(serverRelease.SERVER_RELEASE_OWNER, "yourChainGod");
  assert.equal(serverRelease.SERVER_RELEASE_REPO, "pihub");
  assert.equal(serverRelease.SERVER_RELEASE_CHANNEL, "stable");
  assert.equal(serverRelease.SERVER_RELEASE_PUBLIC_KEY, "2o1U_BIfYt1G_xYhSQBpAtHiQfTNi2ieUkxhvxBHkHI");
  assert.doesNotMatch(source, /registry\.npmjs|DefaultPackageManager|npm install|PIHUB_RELEASE_PUBLIC_KEY/);
  assert.doesNotMatch(source, /\btoken\s*:/i);
  assert.doesNotMatch(source, /__pihubServerUpdateRuntime|new UpdateEngine\(/);
  assert.match(source, /requestServerUpdateSupervisor\("apply"\)/);
  assert.match(source, /status:\s*202/);
});

test("keeps device capability checks and fails closed without a stable launcher", async () => {
  const unauthenticated = await route.POST(request("POST", { action: "apply" }, { "content-type": "application/json" }));
  assert.equal(unauthenticated.status, 401);
  assertPrivate(unauthenticated);

  const forbidden = await route.POST(request("POST", { action: "apply" }, {
    ...TRUSTED_HEADERS,
    "x-pihub-authenticated-capabilities": "devices:manage",
  }));
  assert.equal(forbidden.status, 403);
  assertPrivate(forbidden);

  const unavailable = await route.POST(request("POST", { action: "apply" }));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "update_runtime_unavailable");
  assertPrivate(unavailable);
});

test("rejects legacy Pi/plugin actions and unknown request fields", async () => {
  updateIpc.setServerUpdateIpcTransportForTests(async () => {
    throw new Error("Invalid requests must not reach the stable launcher");
  });
  for (const body of [
    { action: "pi" },
    { action: "plugin", source: "npm:example" },
    { action: "apply", token: "must-not-be-accepted" },
  ]) {
    const response = await route.POST(request("POST", body));
    assert.equal(response.status, 400);
    assertPrivate(response);
  }
});

test("GET rejects a wrong signing key and never sends credentials", async () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const version = "0.0.1";
  const unsignedAsset = {
    version,
    platform: process.platform === "win32" ? "win32" : process.platform,
    arch: process.arch,
    url: `https://github.com/yourChainGod/pihub/releases/download/v${version}/pihub-server.tgz`,
    sha256: "0".repeat(64),
    size: 1,
  };
  const asset = {
    ...unsignedAsset,
    signature: sign(null, release.releaseAssetSigningPayload(unsignedAsset), privateKey).toString("base64url"),
  };
  const unsignedManifest = {
    schemaVersion: 1,
    owner: "yourChainGod",
    repo: "pihub",
    channel: "stable",
    version,
    assets: [asset],
  };
  const body = release.canonicalizeReleaseJson({
    ...unsignedManifest,
    signature: sign(null, release.releaseManifestSigningPayload(unsignedManifest), privateKey).toString("base64url"),
  });
  const requests = [];
  updateIpc.setServerUpdateIpcTransportForTests(async (command) => {
    assert.equal(command, "status");
    return {
      currentVersion: "0.0.0",
      update: { phase: "idle", updatedAt: new Date(0).toISOString() },
    };
  });
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      authorization: new Headers(init.headers).get("authorization"),
    });
    return new Response(body, { status: 200 });
  };

  const response = await route.GET(request("GET"));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "release_unavailable");
  assert.deepEqual(requests, [{
      url: serverRelease.SERVER_RELEASE_MANIFEST_URL,
    authorization: null,
  }]);
  assertPrivate(response);
});

test("POST queues one supervisor update and returns before activation", async () => {
  const operationId = "a".repeat(32);
  const calls = [];
  updateIpc.setServerUpdateIpcTransportForTests(async (command) => {
    calls.push(command);
    return {
      accepted: true,
      operationId,
      update: {
        phase: "queued",
        operationId,
        updatedAt: new Date(0).toISOString(),
      },
    };
  });

  const response = await route.POST(request("POST", { action: "apply" }));
  assert.equal(response.status, 202);
  assert.deepEqual(calls, ["apply"]);
  assert.equal((await response.json()).operationId, operationId);
  assertPrivate(response);
});
