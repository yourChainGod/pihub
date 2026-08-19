import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(path);
  } catch {
    return import(path);
  }
}

const { buildModelsListUrl, isSafeModelId, parseDiscoveredModels } = await loadSubject("./model-discovery.ts");
const { resolveModelDiscoveryAuth } = await loadSubject("./model-discovery-auth.ts");

test("builds protocol-appropriate model list URLs", () => {
  assert.equal(buildModelsListUrl("https://api.example.com/v1/", "openai-completions").toString(), "https://api.example.com/v1/models");
  assert.equal(buildModelsListUrl("https://api.anthropic.com", "anthropic-messages").toString(), "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(buildModelsListUrl("https://generativelanguage.googleapis.com", "google-generative-ai").toString(), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
  assert.equal(buildModelsListUrl("https://api.example.com/custom/models", "openai-responses").toString(), "https://api.example.com/custom/models");
});

test("parses OpenAI, Anthropic, Google, and string model lists", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "gpt-5" }, { id: "claude", display_name: "Claude" }] }), [
    { id: "claude", name: "Claude" },
    { id: "gpt-5" },
  ]);
  assert.deepEqual(parseDiscoveredModels({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }), [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ]);
  assert.deepEqual(parseDiscoveredModels(["zeta", "alpha", "alpha"]), [
    { id: "alpha" },
    { id: "zeta" },
  ]);
});

test("rejects model identifiers that can escape paths or poison object maps", () => {
  for (const id of ["../secret", "vendor//model", "vendor\\model", "__proto__", "model?token=secret", "model\nheader"]) {
    assert.equal(isSafeModelId(id), false, id);
  }
  assert.equal(isSafeModelId("vendor/model-1.2:fast"), true);
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "safe/model" }, { id: "../unsafe" }] }), [{ id: "safe/model" }]);
});

test("accepts literal auth but never resolves commands or process environment", async () => {
  const auth = await resolveModelDiscoveryAuth("pi-web-header-only-test", {
    apiKey: "literal-api-key",
    headers: { "X-Discovery-Token": "literal-header" },
  });
  assert.equal(auth.apiKey, "literal-api-key");
  assert.deepEqual(auth.headers, { "x-discovery-token": "literal-header" });

  process.env.PI_WEB_DISCOVERY_TEST_TOKEN = "resolved-token";
  try {
    await assert.rejects(() => resolveModelDiscoveryAuth("pi-web-header-only-test", {
      headers: { "X-Discovery-Token": "$PI_WEB_DISCOVERY_TEST_TOKEN" },
    }), (error) => error.code === "dynamic_credential");
    await assert.rejects(() => resolveModelDiscoveryAuth("pi-web-header-only-test", {
      apiKey: "!printf command-must-not-run",
    }), (error) => error.code === "dynamic_credential");
  } finally {
    delete process.env.PI_WEB_DISCOVERY_TEST_TOKEN;
  }
});

test("redacted credentials resolve only for their exact stored provider target", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pihub-discovery-auth-"));
  const modelsPath = path.join(directory, "models.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(modelsPath, JSON.stringify({
    providers: {
      acme: {
        baseUrl: "https://api.example.com/v1",
        apiKey: "stored-secret",
        headers: { "X-Tenant-Token": "stored-header-secret" },
      },
    },
  }));

  const resolved = await resolveModelDiscoveryAuth("acme", {
    baseUrl: "https://api.example.com/v1/",
    apiKey: "[REDACTED]",
    headers: { "X-Tenant-Token": "[REDACTED]" },
  }, "https://api.example.com/v1/", modelsPath);
  assert.deepEqual(resolved, {
    apiKey: "stored-secret",
    headers: { "x-tenant-token": "stored-header-secret" },
  });

  await assert.rejects(() => resolveModelDiscoveryAuth("acme", {
    baseUrl: "https://attacker.example/v1",
    apiKey: "[REDACTED]",
  }, "https://attacker.example/v1", modelsPath), (error) => (
    error.code === "invalid_input" && !error.message.includes("stored-secret")
  ));
});
