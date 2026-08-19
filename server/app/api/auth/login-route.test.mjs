import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: true,
  tsconfigPaths: true,
});
const route = await jiti.import("./login/[provider]/route.ts");
const challenges = await jiti.import("../../../lib/temporary-challenge.ts");
const { ModelRuntime } = await jiti.import("@earendil-works/pi-coding-agent");
const source = await readFile(new URL("./login/[provider]/route.ts", import.meta.url), "utf8");

const DEVICE_A = `dev_${"A".repeat(22)}`;
const DEVICE_B = `dev_${"B".repeat(22)}`;

afterEach(() => {
  challenges.resetTemporaryChallengeRuntimeForTests();
});

function headers(deviceId = DEVICE_A, capability = "providers:manage", json = true) {
  return {
    "x-pihub-authenticated-device": deviceId,
    "x-pihub-authenticated-capabilities": capability,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function post(provider, body, options = {}) {
  return route.POST(new Request(`http://localhost:30141/api/auth/login/${provider}`, {
    method: "POST",
    headers: options.headers ?? headers(options.deviceId, options.capability, options.json),
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ provider }) });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("OAuth callback requires trusted provider-management identity before consuming", async () => {
  const challenge = challenges.createTemporaryChallenge(DEVICE_A, "provider-a");
  const missing = await post("provider-a", { token: challenge.token, code: "code" }, {
    headers: { "content-type": "application/json" },
  });
  const denied = await post("provider-a", { token: challenge.token, code: "code" }, {
    capability: "models:read",
  });
  assert.equal(missing.status, 401);
  assert.equal(denied.status, 403);
  assert.equal(challenges.getTemporaryChallengeStats().pending, 1);

  const accepted = await post("provider-a", { token: challenge.token, code: "code" });
  assert.equal(accepted.status, 200);
  assert.equal(await challenge.promise, "code");
});

test("forged device or provider cannot consume a pending challenge", async () => {
  const challenge = challenges.createTemporaryChallenge(DEVICE_A, "provider-a");
  const wrongDevice = await post("provider-a", { token: challenge.token, code: "forged" }, {
    deviceId: DEVICE_B,
  });
  const wrongProvider = await post("provider-b", { token: challenge.token, code: "forged" });
  assert.equal(wrongDevice.status, 404);
  assert.equal(wrongProvider.status, 404);
  assert.equal(challenges.getTemporaryChallengeStats().pending, 1);

  const accepted = await post("provider-a", { token: challenge.token, code: "valid" });
  assert.equal(accepted.status, 200);
  assert.equal(await challenge.promise, "valid");
});

test("a consumed OAuth response is explicitly rejected on replay", async () => {
  const challenge = challenges.createTemporaryChallenge(DEVICE_A, "provider-a");
  const first = await post("provider-a", { token: challenge.token, code: "once" });
  const replay = await post("provider-a", { token: challenge.token, code: "twice" });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 409);
  assert.match(replay.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(await challenge.promise, "once");
});

test("OAuth callback requires bounded JSON object input", async () => {
  const challenge = challenges.createTemporaryChallenge(DEVICE_A, "provider-a");
  const wrongType = await post("provider-a", { token: challenge.token, code: "code" }, {
    json: false,
  });
  const oversized = await post("provider-a", {
    token: challenge.token,
    code: "x".repeat(25 * 1024),
  });
  const missingCode = await post("provider-a", { token: challenge.token });
  assert.equal(wrongType.status, 400);
  assert.equal(oversized.status, 400);
  assert.equal(missingCode.status, 400);
  assert.equal(challenges.getTemporaryChallengeStats().pending, 1);
  challenge.cancel();
  await Promise.allSettled([challenge.promise]);
});

test("pre-aborted OAuth GET releases its flow lease before runtime creation", async () => {
  const abort = new AbortController();
  abort.abort();
  const response = await route.GET(new Request(
    "http://localhost:30141/api/auth/login/provider-a",
    { headers: headers(DEVICE_A, "providers:manage", false), signal: abort.signal },
  ), { params: Promise.resolve({ provider: "provider-a" }) });
  assert.equal(response.status, 204);
  assert.deepEqual(challenges.getTemporaryChallengeStats(), {
    pending: 0,
    tombstones: 0,
    flows: 0,
  });
});

test("aborted runtime initialization stays bounded until detached work settles", async (t) => {
  const originalCreate = ModelRuntime.create;
  const startup = deferred();
  let createCalls = 0;
  ModelRuntime.create = async () => {
    createCalls += 1;
    return startup.promise;
  };
  t.after(() => { ModelRuntime.create = originalCreate; });

  const openAndAbort = async () => {
    const response = await route.GET(new Request(
      "http://localhost:30141/api/auth/login/provider-a",
      { headers: headers(DEVICE_A, "providers:manage", false) },
    ), { params: Promise.resolve({ provider: "provider-a" }) });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    await response.body.cancel();
  };
  await openAndAbort();
  await openAndAbort();
  assert.equal(createCalls, 2);
  assert.equal(challenges.getTemporaryChallengeStats().flows, 2);

  const limited = await route.GET(new Request(
    "http://localhost:30141/api/auth/login/provider-a",
    { headers: headers(DEVICE_A, "providers:manage", false) },
  ), { params: Promise.resolve({ provider: "provider-a" }) });
  assert.equal(limited.status, 429);
  assert.equal(createCalls, 2);

  startup.resolve({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(challenges.getTemporaryChallengeStats().flows, 0);
});

test("OAuth route uses bounded challenges and admits flows before creating runtime", () => {
  assert.match(source, /getTrustedPihubRequestContext\(req\)/);
  assert.match(source, /readPihubAuthJsonBody\(req, MAX_LOGIN_BODY_BYTES\)/);
  assert.match(source, /consumeTemporaryChallenge\(token, trusted\.deviceId, provider/);
  assert.match(source, /acquireTemporaryChallengeFlow\(trusted\.deviceId, provider\)/);
  assert.match(source, /new SseReplayChannel/);
  assert.doesNotMatch(source, /Math\.random/);
  assert.doesNotMatch(source, /__piLoginCallbacks/);
  assert.doesNotMatch(source, /authenticatePihubApiRequest/);
  assert.ok(
    source.indexOf("const flowLease = acquireTemporaryChallengeFlow")
      < source.indexOf("createSafeModelRuntime({ modelsPath: null, signal: abort.signal })"),
  );
});
