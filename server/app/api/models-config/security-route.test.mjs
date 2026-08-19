import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
const { POST: discoverModels } = await jiti.import("./discover/route.ts");
const { POST: testModel } = await jiti.import("./test/route.ts");
const {
  UNSUPPORTED_MODEL_TRANSPORT_CODE,
  UNSUPPORTED_MODEL_TRANSPORT_MESSAGE,
} = await jiti.import("../../../lib/safe-model-runtime.ts");
const DEVICE_ID = `dev_${"M".repeat(22)}`;

function request(pathname, body) {
  return new Request(`http://localhost:30141${pathname}`, {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-pihub-authenticated-device": DEVICE_ID,
      "x-pihub-authenticated-capabilities": "models:manage",
    },
    body: JSON.stringify(body),
  });
}

test("model handlers reject !command credentials without executing them", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pihub-model-command-test-"));
  const marker = path.join(directory, "executed");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = {
    providerName: "security-test",
    provider: {
      baseUrl: "https://api.example.invalid/v1",
      api: "openai-completions",
      apiKey: `!touch ${marker}`,
    },
    model: { id: "test-model", api: "openai-completions" },
  };

  for (const [pathname, handler] of [
    ["/api/models-config/discover", discoverModels],
    ["/api/models-config/test", testModel],
  ]) {
    const response = await handler(request(pathname, body));
    assert.equal(response.status, 400);
    assert.equal(JSON.stringify(await response.json()).includes(marker), false);
  }
  assert.equal(existsSync(marker), false);
});

test("model discovery neither resolves nor echoes environment-backed header secrets", async () => {
  const secret = "pihub-secret-canary-4c2d1e";
  process.env.PIHUB_MODEL_ROUTE_SECRET = secret;
  try {
    const response = await discoverModels(request("/api/models-config/discover", {
      providerName: "security-test",
      provider: {
        baseUrl: "https://api.example.invalid/v1",
        api: "openai-completions",
        headers: { "X-API-Key": "$PIHUB_MODEL_ROUTE_SECRET" },
      },
    }));
    const result = JSON.stringify(await response.json());
    assert.equal(response.status, 400);
    assert.equal(result.includes(secret), false);
    assert.equal(result.includes("PIHUB_MODEL_ROUTE_SECRET"), false);
  } finally {
    delete process.env.PIHUB_MODEL_ROUTE_SECRET;
  }
});

test("model discovery blocks loopback and metadata targets before transport", async () => {
  for (const baseUrl of ["https://127.0.0.1/v1", "https://169.254.169.254/latest/meta-data"]) {
    const response = await discoverModels(request("/api/models-config/discover", {
      providerName: "security-test",
      provider: { baseUrl, api: "openai-completions", apiKey: "literal-test-key" },
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /invalid|not allowed|non-public/i);
  }
});

test("ordinary model routes reject per-request Tailnet policy injection", async () => {
  for (const allowTailnet of [true, false]) {
    const body = {
      providerName: "security-test",
      provider: {
        baseUrl: "https://api.example.invalid/v1",
        api: "openai-completions",
        apiKey: "literal-test-key",
        allowTailnet,
      },
      model: { id: "test-model", api: "openai-completions" },
    };
    for (const [pathname, handler] of [
      ["/api/models-config/discover", discoverModels],
      ["/api/models-config/test", testModel],
    ]) {
      const response = await handler(request(pathname, body));
      const result = await response.json();
      assert.equal(response.status, 400);
      assert.match(result.error, /allowTailnet.*NewAPI/);
    }
  }
});

test("unsupported provider transports use the shared fail-closed contract", async () => {
  for (const [pathname, handler, api] of [
    ["/api/models-config/discover", discoverModels, "bedrock-converse-stream"],
    ["/api/models-config/test", testModel, "google-generative-ai"],
  ]) {
    const response = await handler(request(pathname, {
      providerName: "security-test",
      provider: {
        baseUrl: "https://api.example.invalid/v1",
        api,
        apiKey: "credential-must-not-be-sent",
      },
      model: { id: "test-model", api },
    }));
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.equal(result.code, UNSUPPORTED_MODEL_TRANSPORT_CODE);
    assert.equal(result.error, UNSUPPORTED_MODEL_TRANSPORT_MESSAGE);
    assert.equal(JSON.stringify(result).includes("credential-must-not-be-sent"), false);
  }
});
