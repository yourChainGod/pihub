import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const auth = await jiti.import("./pihub-auth.ts");
const store = await jiti.import("./pihub-auth-store.ts");
const { proxy } = await jiti.import("../proxy.ts");
const pairingRoute = await jiti.import("../app/api/pairing/route.ts");

function createState(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-device-auth-"));
  const statePath = path.join(root, "private", "auth.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, statePath };
}

async function createDevice(t, capabilities = ["sessions:read", "sessions:write"]) {
  const { statePath } = createState(t);
  const now = 1_800_000_000_000;
  const pairing = await store.issuePihubPairingCode(
    { label: "Test device", capabilities },
    { statePath, now },
  );
  const device = await store.claimPihubPairingCode(pairing.code, {
    statePath,
    now: now + 1,
  });
  assert.ok(device);
  return { statePath, device };
}

function request(url, method = "GET", authorization) {
  const normalizedMethod = method.toUpperCase();
  return new NextRequest(url, {
    method,
    headers: {
      host: "localhost:30141",
      ...(authorization ? { authorization } : {}),
      ...(normalizedMethod === "GET" || normalizedMethod === "HEAD"
        ? {}
        : { "x-pihub-content-sha256": auth.PIHUB_EMPTY_CONTENT_SHA256 }),
    },
  });
}

function sign(device, url, method, timestamp, nonce, contentSha256, epoch) {
  return auth.createPihubAuthorization({
    deviceId: device.id,
    secret: device.secret,
    url,
    method,
    timestamp,
    nonce,
    contentSha256,
    epoch,
  });
}

function spawnWithInput(arguments_, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(input);
  });
}

test("pairing codes are high-entropy, private, expiring, and single-use", async (t) => {
  const { statePath } = createState(t);
  const now = 1_800_000_000_000;
  const pairing = await store.issuePihubPairingCode({
    label: "Laptop",
    capabilities: ["files:read"],
    ttlMs: 30_000,
  }, { statePath, now });

  assert.match(pairing.code, /^pihub-[A-Za-z0-9_-]{43}$/);
  assert.equal(fs.readFileSync(statePath, "utf8").includes(pairing.code), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(statePath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  }

  const device = await store.claimPihubPairingCode(pairing.code, { statePath, now: now + 29_999 });
  assert.ok(device);
  assert.match(device.id, /^dev_[A-Za-z0-9_-]{22}$/);
  assert.match(device.secret, /^pihub_key_[A-Za-z0-9_-]{43}$/);
  assert.equal(await store.claimPihubPairingCode(pairing.code, { statePath, now: now + 29_999 }), null);

  const summary = await store.listPihubAuthState({ statePath, now: now + 29_999 });
  assert.deepEqual(summary.pairingCodes, []);
  assert.equal(JSON.stringify(summary).includes(device.secret), false);
});

test("expired pairing codes cannot be claimed", async (t) => {
  const { statePath } = createState(t);
  const now = 1_800_000_000_000;
  const pairing = await store.issuePihubPairingCode({
    capabilities: ["sessions:read"],
    ttlMs: 30_000,
  }, { statePath, now });
  assert.equal(await store.claimPihubPairingCode(pairing.code, { statePath, now: now + 30_000 }), null);
  assert.deepEqual((await store.listPihubAuthState({ statePath, now: now + 30_000 })).pairingCodes, []);
});

test("device secrets rotate independently and revocation is permanent", async (t) => {
  const { statePath, device } = await createDevice(t, ["sessions:read", "devices:manage"]);
  const rotated = await store.rotatePihubDeviceSecret(device.id, {
    statePath,
    now: 1_800_000_001_000,
  });
  assert.notEqual(rotated.secret, device.secret);
  assert.equal(store.getActivePihubDevice(device.id, { statePath })?.secret, rotated.secret);

  const revoked = await store.revokePihubDevice(device.id, {
    statePath,
    now: 1_800_000_002_000,
    allowLastManagerRevocation: true,
  });
  assert.equal(revoked.revokedAt, 1_800_000_002_000);
  assert.equal(store.getActivePihubDevice(device.id, { statePath }), null);
  assert.equal(fs.readFileSync(statePath, "utf8").includes(rotated.secret), false);
});

test("remote management cannot revoke the last active device manager", async (t) => {
  const { statePath, device } = await createDevice(t, ["devices:manage"]);
  await assert.rejects(
    store.revokePihubDevice(device.id, { statePath }),
    (error) => error?.name === "PihubAuthStateConflictError",
  );
  assert.ok(store.getActivePihubDevice(device.id, { statePath }));
});

test("pairing management is manager-only, self-rotation only, and preserves one manager", async (t) => {
  const { statePath, device: manager } = await createDevice(t, ["devices:manage"]);
  const secondPairing = await store.issuePihubPairingCode({
    label: "Second manager",
    capabilities: ["devices:manage"],
  }, { statePath });
  const secondManager = await store.claimPihubPairingCode(secondPairing.code, { statePath });
  assert.ok(secondManager);

  const previousPath = process.env.PIHUB_AUTH_STATE_PATH;
  process.env.PIHUB_AUTH_STATE_PATH = statePath;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PIHUB_AUTH_STATE_PATH;
    else process.env.PIHUB_AUTH_STATE_PATH = previousPath;
  });
  const trustedHeaders = {
    "content-type": "application/json",
    "x-pihub-authenticated-device": manager.id,
    "x-pihub-authenticated-capabilities": "devices:manage",
  };

  assert.equal((await pairingRoute.GET(new Request("http://localhost/api/pairing"))).status, 401);
  assert.equal((await pairingRoute.GET(new Request("http://localhost/api/pairing", {
    headers: {
      "x-pihub-authenticated-device": manager.id,
      "x-pihub-authenticated-capabilities": "sessions:read",
    },
  }))).status, 403);
  assert.equal((await pairingRoute.PATCH(new Request("http://localhost/api/pairing", {
    method: "PATCH",
    headers: trustedHeaders,
    body: JSON.stringify({ deviceId: secondManager.id }),
  }))).status, 403);

  const rotatedResponse = await pairingRoute.PATCH(new Request("http://localhost/api/pairing", {
    method: "PATCH",
    headers: trustedHeaders,
    body: JSON.stringify({ deviceId: manager.id }),
  }));
  assert.equal(rotatedResponse.status, 200);
  const rotated = (await rotatedResponse.json()).device;
  assert.notEqual(rotated.secret, manager.secret);

  assert.equal((await pairingRoute.DELETE(new Request(
    `http://localhost/api/pairing?deviceId=${encodeURIComponent(secondManager.id)}`,
    { method: "DELETE", headers: trustedHeaders },
  ))).status, 204);
  assert.equal((await pairingRoute.DELETE(new Request(
    `http://localhost/api/pairing?deviceId=${encodeURIComponent(manager.id)}`,
    { method: "DELETE", headers: trustedHeaders },
  ))).status, 409);
});

test("local admin CLI bootstraps and manages devices without secrets in argv or env", async (t) => {
  const { root, statePath } = createState(t);
  const admin = path.join(process.cwd(), "bin", "pihub-auth-admin.js");
  const grantPath = path.join(root, "first-pairing.json");
  const issueArguments = [
    admin,
    "issue",
    "--state", statePath,
    "--input", "-",
    "--output", grantPath,
  ];
  const unsafeStdout = spawnSync(process.execPath, [
    admin,
    "issue",
    "--state", statePath,
    "--input", "-",
    "--output", "-",
  ], {
    input: JSON.stringify({ capabilities: ["sessions:read"] }),
    encoding: "utf8",
  });
  assert.notEqual(unsafeStdout.status, 0);
  assert.equal(unsafeStdout.stdout, "");

  const issued = spawnSync(process.execPath, issueArguments, {
    input: JSON.stringify({
      label: "First administrator",
      capabilities: ["devices:manage", "sessions:read"],
      ttlSeconds: 60,
    }),
    encoding: "utf8",
  });
  assert.equal(issued.status, 0, issued.stderr);
  assert.equal(issued.stdout, "");
  if (process.platform !== "win32") assert.equal(fs.statSync(grantPath).mode & 0o777, 0o600);
  const grant = JSON.parse(fs.readFileSync(grantPath, "utf8"));
  assert.match(grant.code, /^pihub-[A-Za-z0-9_-]{43}$/);
  assert.equal(issueArguments.includes(grant.code), false);

  const device = await store.claimPihubPairingCode(grant.code, { statePath });
  assert.ok(device);
  const listed = spawnSync(process.execPath, [
    admin,
    "list",
    "--state", statePath,
    "--output", "-",
  ], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.includes(device.secret), false);

  const rotatedPath = path.join(root, "rotated-device.json");
  const rotateArguments = [
    admin,
    "rotate",
    "--state", statePath,
    "--input", "-",
    "--output", rotatedPath,
  ];
  const rotatedResult = spawnSync(process.execPath, rotateArguments, {
    input: JSON.stringify({ deviceId: device.id }),
    encoding: "utf8",
  });
  assert.equal(rotatedResult.status, 0, rotatedResult.stderr);
  const rotated = JSON.parse(fs.readFileSync(rotatedPath, "utf8"));
  assert.notEqual(rotated.secret, device.secret);
  assert.equal(rotateArguments.includes(device.secret), false);
  assert.equal(rotateArguments.includes(rotated.secret), false);

  const revoked = spawnSync(process.execPath, [
    admin,
    "revoke",
    "--state", statePath,
    "--input", "-",
    "--output", "-",
  ], {
    input: JSON.stringify({ deviceId: device.id }),
    encoding: "utf8",
  });
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.equal(store.getActivePihubDevice(device.id, { statePath }), null);
});

test("cross-process locks prevent lost updates and double pairing claims", async (t) => {
  const { statePath } = createState(t);
  const admin = path.join(process.cwd(), "bin", "pihub-auth-admin.js");
  const issueResults = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    spawnWithInput([
      admin,
      "issue",
      "--state", statePath,
      "--input", "-",
      "--output", "-",
      "--show-secret",
    ], JSON.stringify({
      label: `Concurrent ${index}`,
      capabilities: ["sessions:read"],
      ttlSeconds: 60,
    }))
  ));
  for (const result of issueResults) assert.equal(result.status, 0, result.stderr);
  const afterIssue = await store.listPihubAuthState({ statePath });
  assert.equal(afterIssue.pairingCodes.length, 6);

  const contested = await store.issuePihubPairingCode({
    label: "Contested",
    capabilities: ["sessions:read"],
    ttlMs: 60_000,
  }, { statePath });
  const childSource = [
    "(async () => {",
    "  let text = '';",
    "  for await (const chunk of process.stdin) text += chunk;",
    "  const input = JSON.parse(text);",
    "  const { createJiti } = require('jiti');",
    "  const jiti = createJiti(process.cwd() + '/auth-concurrency.cjs', { interopDefault: true });",
    "  const store = await jiti.import('./lib/pihub-auth-store.ts');",
    "  const result = await store.claimPihubPairingCode(input.code, { statePath: input.statePath });",
    "  process.stdout.write(JSON.stringify({ claimed: Boolean(result) }));",
    "})().catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join("\n");
  const claimInput = JSON.stringify({ statePath, code: contested.code });
  const claims = await Promise.all([
    spawnWithInput(["-e", childSource], claimInput),
    spawnWithInput(["-e", childSource], claimInput),
  ]);
  for (const result of claims) assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    claims.map((result) => JSON.parse(result.stdout).claimed).sort(),
    [false, true],
  );
});

test("request targets are canonical and signatures bind method, target, time, nonce, and device", () => {
  assert.equal(
    auth.canonicalizePihubRequestTarget("https://example.invalid/api/files/a%20b?z=2&a=x%20y&a=x"),
    "/api/files/a%20b?a=x+y&a=x&z=2",
  );

  const input = {
    deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA",
    secret: `pihub_key_${"B".repeat(43)}`,
    method: "POST",
    url: "https://example.invalid/api/models?b=2&a=1",
    timestamp: 1_800_000_000,
    nonce: "C".repeat(22),
  };
  const first = auth.createPihubAuthorization(input);
  assert.equal(first, auth.createPihubAuthorization({
    ...input,
    url: "https://different-host.invalid/api/models?a=1&b=2",
  }));
  assert.notEqual(first, auth.createPihubAuthorization({ ...input, method: "GET" }));
  assert.notEqual(first, auth.createPihubAuthorization({ ...input, url: "/api/sessions?a=1&b=2" }));
  assert.notEqual(first, auth.createPihubAuthorization({ ...input, timestamp: input.timestamp + 1 }));
  assert.notEqual(first, auth.createPihubAuthorization({ ...input, nonce: "D".repeat(22) }));
  assert.notEqual(first, auth.createPihubAuthorization({
    ...input,
    deviceId: "dev_EEEEEEEEEEEEEEEEEEEEEE",
  }));
});

test("v3 signing vector is stable across server, CLI, and desktop implementations", () => {
  const input = {
    deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA",
    secret: `pihub_key_${"B".repeat(43)}`,
    method: "POST",
    url: "https://pi.invalid/api/agent/new?z=2&name=hello%20world&a=%2F",
    timestamp: 1_800_000_000,
    nonce: "C".repeat(22),
    epoch: "G".repeat(22),
    contentSha256: "9b2d43affbf49a367028df2e1414f84c0e099ac98c3d54a8a80157fd7771af25",
  };
  assert.equal(auth.buildPihubSigningPayload(input), [
    "pihub-request-v3",
    "POST",
    "/api/agent/new?a=%2F&name=hello+world&z=2",
    input.contentSha256,
    "1800000000",
    input.nonce,
    input.epoch,
    input.deviceId,
  ].join("\n"));
  assert.equal(
    auth.createPihubAuthorization(input),
    "PiHub-HMAC-SHA256 dev_AAAAAAAAAAAAAAAAAAAAAA:1800000000:CCCCCCCCCCCCCCCCCCCCCC:GGGGGGGGGGGGGGGGGGGGGG:omu6JdCYA72o1I6Qmue5Hs_gtlj6b0X9SKnsR1bP0k4",
  );
});

test("public authentication metadata exposes a versioned epoch and bounded clock reference", () => {
  auth.resetPihubAuthRuntimeForTests();
  assert.deepEqual(auth.getPihubAuthenticationMetadata(1_800_000_000_999), {
    scheme: "PiHub-HMAC-SHA256",
    signingContext: "pihub-request-v3",
    epoch: auth.getPihubAuthEpoch(),
    serverTimeUnixSeconds: 1_800_000_000,
    timestampWindowSeconds: 120,
  });
  auth.resetPihubAuthRuntimeForTests();
});

test("proxy accepts valid canonical signatures and rejects forgery, expiry, and replay", async (t) => {
  const { statePath, device } = await createDevice(t, ["models:read"]);
  const previousPath = process.env.PIHUB_AUTH_STATE_PATH;
  process.env.PIHUB_AUTH_STATE_PATH = statePath;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PIHUB_AUTH_STATE_PATH;
    else process.env.PIHUB_AUTH_STATE_PATH = previousPath;
    auth.resetPihubAuthRuntimeForTests();
  });
  auth.resetPihubAuthRuntimeForTests();

  const forgedRootGrant = await proxy(new NextRequest(
    "http://localhost:30141/api/cwd/validate",
    {
      method: "POST",
      headers: {
        host: "localhost:30141",
        "content-type": "application/json",
        "x-pihub-authenticated-device": device.id,
        "x-pihub-authenticated-capabilities": "workspaces:manage",
      },
      body: JSON.stringify({ cwd: os.tmpdir() }),
    },
  ));
  assert.equal(forgedRootGrant.status, 401);

  const now = Math.floor(Date.now() / 1000);
  const signedUrl = "http://localhost:30141/api/models?b=2&a=1";
  const requestedUrl = "http://localhost:30141/api/models?a=1&b=2";
  const authorization = sign(device, signedUrl, "GET", now, "A".repeat(22));
  assert.equal((await proxy(request(requestedUrl, "GET", authorization))).status, 200);
  assert.equal((await proxy(request(requestedUrl, "GET", authorization))).status, 401);

  const forged = `${authorization.slice(0, -1)}${authorization.endsWith("A") ? "B" : "A"}`;
  assert.equal((await proxy(request(requestedUrl, "GET", forged))).status, 401);

  const expired = sign(
    device,
    requestedUrl,
    "GET",
    now - auth.PIHUB_AUTH_TIMESTAMP_WINDOW_SECONDS - 1,
    "B".repeat(22),
  );
  assert.equal((await auth.authenticatePihubApiRequest(request(requestedUrl, "GET", expired), {
    statePath,
    now,
  })).status, "unauthorized");

  const wrongTarget = sign(device, "/api/sessions?a=1&b=2", "GET", now, "C".repeat(22));
  assert.equal((await auth.authenticatePihubApiRequest(request(requestedUrl, "GET", wrongTarget), {
    statePath,
    now,
  })).status, "unauthorized");
});

test("a server restart epoch invalidates otherwise fresh captured requests", async (t) => {
  const { statePath, device } = await createDevice(t, ["models:read"]);
  auth.resetPihubAuthRuntimeForTests();
  const oldEpoch = auth.getPihubAuthEpoch();
  const now = Math.floor(Date.now() / 1000);
  const url = "http://localhost:30141/api/models";
  const authorization = sign(
    device,
    url,
    "GET",
    now,
    "R".repeat(22),
    undefined,
    oldEpoch,
  );

  assert.equal((await auth.authenticatePihubApiRequest(request(url, "GET", authorization), {
    statePath,
    now,
  })).status, "authenticated");
  auth.resetPihubAuthRuntimeForTests();
  assert.notEqual(auth.getPihubAuthEpoch(), oldEpoch);
  assert.equal((await auth.authenticatePihubApiRequest(request(url, "GET", authorization), {
    statePath,
    now,
  })).status, "unauthorized");
  auth.resetPihubAuthRuntimeForTests();
});

test("proxy enforces device capabilities and strips spoofed trusted headers", async (t) => {
  const { statePath, device } = await createDevice(t, ["sessions:read"]);
  const previousPath = process.env.PIHUB_AUTH_STATE_PATH;
  process.env.PIHUB_AUTH_STATE_PATH = statePath;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PIHUB_AUTH_STATE_PATH;
    else process.env.PIHUB_AUTH_STATE_PATH = previousPath;
    auth.resetPihubAuthRuntimeForTests();
  });
  auth.resetPihubAuthRuntimeForTests();

  const now = Math.floor(Date.now() / 1000);
  const url = "http://localhost:30141/api/models-config";
  const forbidden = sign(device, url, "PUT", now, "D".repeat(22));
  assert.equal((await proxy(request(url, "PUT", forbidden))).status, 403);

  const readableUrl = "http://localhost:30141/api/sessions";
  const readable = sign(device, readableUrl, "GET", now, "E".repeat(22));
  const spoofed = new NextRequest(readableUrl, {
    headers: {
      host: "localhost:30141",
      authorization: readable,
      "x-pihub-authenticated-device": "dev_spoofed",
      "x-pihub-authenticated-capabilities": "devices:manage",
      "x-pihub-authenticated-content-sha256": "f".repeat(64),
    },
  });
  const response = await proxy(spoofed);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-request-x-pihub-authenticated-device"), device.id);
  assert.equal(response.headers.get("x-middleware-request-x-pihub-authenticated-capabilities"), "sessions:read");
  assert.equal(
    response.headers.get("x-middleware-request-x-pihub-authenticated-content-sha256"),
    auth.PIHUB_EMPTY_CONTENT_SHA256,
  );

  const context = auth.getTrustedPihubRequestContext(new Request(url, {
    headers: {
      "x-pihub-authenticated-device": device.id,
      "x-pihub-authenticated-capabilities": "sessions:read",
    },
  }));
  assert.deepEqual(context, { deviceId: device.id, capabilities: ["sessions:read"] });
  assert.equal(auth.getTrustedPihubRequestContext(new Request(url, {
    headers: {
      "x-pihub-authenticated-device": "dev_spoofed",
      "x-pihub-authenticated-capabilities": "devices:manage",
    },
  })), null);
});

test("pairing claim rate limit is bounded", () => {
  auth.resetPihubAuthRuntimeForTests();
  const now = 1_800_000_000_000;
  for (let index = 0; index < 8; index += 1) {
    assert.deepEqual(auth.consumePihubPairingClaimAttempt("same-code", now), { allowed: true });
  }
  const limited = auth.consumePihubPairingClaimAttempt("same-code", now);
  assert.equal(limited.allowed, false);
  assert.equal(limited.retryAfterSeconds, 300);
  assert.deepEqual(auth.consumePihubPairingClaimAttempt("same-code", now + 300_001), { allowed: true });
  auth.resetPihubAuthRuntimeForTests();
});

test("authenticated JSON mutations bind the exact body before consuming the nonce", async (t) => {
  const { statePath, device } = await createDevice(t, ["agents:use"]);
  const now = Math.floor(Date.now() / 1000);
  const url = "http://localhost:30141/api/agent/new";
  const expectedBody = JSON.stringify({ message: "expected" });
  const digest = auth.sha256PihubContent(expectedBody);
  auth.resetPihubAuthRuntimeForTests();
  const authorization = sign(device, url, "POST", now, "F".repeat(22), digest);
  const makeRequest = (body) => new NextRequest(url, {
    method: "POST",
    headers: {
      host: "localhost:30141",
      authorization,
      "content-type": "application/json",
      "x-pihub-content-sha256": digest,
    },
    body,
  });

  assert.equal((await auth.authenticatePihubApiRequest(makeRequest(
    JSON.stringify({ message: "replaced" }),
  ), { statePath, now })).status, "unauthorized");
  assert.equal((await auth.authenticatePihubApiRequest(makeRequest(expectedBody), {
    statePath,
    now,
  })).status, "authenticated");
  assert.equal((await auth.authenticatePihubApiRequest(makeRequest(expectedBody), {
    statePath,
    now,
  })).status, "unauthorized");
  auth.resetPihubAuthRuntimeForTests();
});

test("protected mutations require one canonical lowercase content digest", async (t) => {
  const { statePath, device } = await createDevice(t, ["agents:use"]);
  const now = Math.floor(Date.now() / 1000);
  const url = "http://localhost:30141/api/agent/new";
  auth.resetPihubAuthRuntimeForTests();

  const authenticate = (nonce, digestHeader) => {
    const authorization = sign(device, url, "POST", now, nonce, auth.PIHUB_EMPTY_CONTENT_SHA256);
    return auth.authenticatePihubApiRequest(new NextRequest(url, {
      method: "POST",
      headers: {
        host: "localhost:30141",
        authorization,
        ...(digestHeader === undefined ? {} : { "x-pihub-content-sha256": digestHeader }),
      },
    }), { statePath, now });
  };

  assert.equal((await authenticate("H".repeat(22), undefined)).status, "unauthorized");
  assert.equal((await authenticate("I".repeat(22), auth.PIHUB_EMPTY_CONTENT_SHA256.toUpperCase())).status, "unauthorized");
  assert.equal((await authenticate("J".repeat(22), "UNSIGNED-PAYLOAD")).status, "unauthorized");
  const accepted = await authenticate("K".repeat(22), auth.PIHUB_EMPTY_CONTENT_SHA256);
  assert.equal(accepted.status, "authenticated");
  assert.equal(accepted.expectedContentSha256, auth.PIHUB_EMPTY_CONTENT_SHA256);
  auth.resetPihubAuthRuntimeForTests();
});

test("multipart authentication binds the supplied raw-wire digest without cloning the body", async (t) => {
  const { statePath, device } = await createDevice(t, ["files:write"]);
  const body = Buffer.from(
    "LS1waWh1Yi10ZXN0LWJvdW5kYXJ5DQpDb250ZW50LURpc3Bvc2l0aW9uOiBmb3JtLWRhdGE7IG5hbWU9ImZpbGVzIjsgZmlsZW5hbWU9ImFfYi5iaW4iDQpDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbQ0KDQoA/wENCi0tcGlodWItdGVzdC1ib3VuZGFyeQ0KQ29udGVudC1EaXNwb3NpdGlvbjogZm9ybS1kYXRhOyBuYW1lPSJmaWxlcyI7IGZpbGVuYW1lPSLkvaDlpb0udHh0Ig0KQ29udGVudC1UeXBlOiBhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW0NCg0KaGVsbG8KDQotLXBpaHViLXRlc3QtYm91bmRhcnktLQ0K",
    "base64",
  );
  const digest = "3277a05aa285701981ae8fc7aa7775804e5a3169ed436ae91917671c61c737e7";
  assert.equal(body.byteLength, 303);
  assert.equal(auth.sha256PihubContent(body), digest);

  const now = Math.floor(Date.now() / 1000);
  const url = "http://localhost:30141/api/files/tmp?conflict=error&type=upload";
  auth.resetPihubAuthRuntimeForTests();
  const authorization = sign(device, url, "POST", now, "L".repeat(22), digest);
  const upload = new NextRequest(url, {
    method: "POST",
    headers: {
      host: "localhost:30141",
      authorization,
      "content-type": "multipart/form-data; boundary=pihub-test-boundary",
      "x-pihub-content-sha256": digest,
    },
    body,
  });
  const result = await auth.authenticatePihubApiRequest(upload, { statePath, now });
  assert.equal(result.status, "authenticated");
  assert.equal(result.expectedContentSha256, digest);
  assert.deepEqual(Buffer.from(await upload.arrayBuffer()), body);
  auth.resetPihubAuthRuntimeForTests();
});

test("CLI signer reads secrets from stdin and matches the protocol implementation", () => {
  const device = {
    id: "dev_AAAAAAAAAAAAAAAAAAAAAA",
    secret: `pihub_key_${"B".repeat(43)}`,
  };
  const url = "/api/models?b=2&a=1";
  const timestamp = 1_800_000_000;
  const nonce = "C".repeat(22);
  const epoch = "G".repeat(22);
  const arguments_ = [
    path.join(process.cwd(), "bin", "pihub-sign-request.js"),
    "--credentials", "-",
    "--epoch", epoch,
    "--method", "GET",
    "--url", url,
    "--timestamp", String(timestamp),
    "--nonce", nonce,
  ];
  const result = spawnSync(process.execPath, arguments_, {
    input: JSON.stringify({ deviceId: device.id, secret: device.secret }),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), `Authorization: ${sign(
    device,
    url,
    "GET",
    timestamp,
    nonce,
    undefined,
    epoch,
  )}`);
  assert.equal(arguments_.includes(device.secret), false);

  const unsigned = spawnSync(process.execPath, [
    ...arguments_,
    "--content-sha256", "UNSIGNED-PAYLOAD",
  ], {
    input: JSON.stringify({ deviceId: device.id, secret: device.secret }),
    encoding: "utf8",
  });
  assert.equal(unsigned.status, 1);
  assert.match(unsigned.stderr, /Invalid content digest/);
});
