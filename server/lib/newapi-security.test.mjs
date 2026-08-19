import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  normalizeNewApiBaseUrl,
  readNewApiConfig,
  writeNewApiConfig,
} = await jiti.import("./newapi-config-store.ts");
const {
  createNewApiProviderExtension,
  modelUrl,
  newApiOriginFingerprint,
  parseGatewayModels,
  ratioMap,
} = await jiti.import("./newapi-provider.ts");

test("NewAPI base URLs are canonical and /v1 is owned by the provider", () => {
  assert.equal(normalizeNewApiBaseUrl("api.example.com/v1/"), "https://api.example.com");
  assert.equal(normalizeNewApiBaseUrl("https://api.example.com/gateway/v1"), "https://api.example.com/gateway");
  assert.equal(modelUrl("https://api.example.com", "openai-completions"), "https://api.example.com/v1");
  assert.equal(modelUrl("https://api.example.com/v1", "openai-responses"), "https://api.example.com/v1");
  assert.equal(modelUrl("https://api.example.com/v1", "anthropic-messages"), "https://api.example.com");
});

test("NewAPI rejects unsafe base URL forms and keeps Tailnet access explicit", () => {
  for (const value of [
    "http://api.example.com",
    "https://user:pass@api.example.com",
    "https://api.example.com/#fragment",
    "https://api.example.com/?key=secret",
  ]) {
    assert.throws(() => normalizeNewApiBaseUrl(value));
  }
  assert.equal(
    normalizeNewApiBaseUrl("http://100.100.20.30/v1", { allowTailnet: true }),
    "http://100.100.20.30",
  );
});

test("NewAPI ratio metadata accepts only bounded non-negative model rates", () => {
  assert.deepEqual(ratioMap({
    "safe/model": 1.5,
    negative: -1,
    infinite: Number.POSITIVE_INFINITY,
    huge: 1_000_001,
    "../poison": 1,
    ["__proto__"]: 1,
  }), { "safe/model": 1.5 });
});

test("NewAPI model catalogs discard dangerous ids, duplicates and malformed endpoints", () => {
  assert.deepEqual(parseGatewayModels({ data: [
    { id: "vendor/model", supported_endpoint_types: ["openai", 42, "x".repeat(65)] },
    { id: "vendor/model" },
    { id: "../escape" },
    { id: "__proto__" },
    null,
  ] }), [{ id: "vendor/model", supported_endpoint_types: ["openai"] }]);
});

test("NewAPI config persists only canonical URLs and an explicit Tailnet flag", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pihub-newapi-config-"));
  const configPath = path.join(directory, "provider-newapi.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeNewApiConfig({
    providers: {
      public: { baseUrl: "https://api.example.com/v1/", modelOverrides: {} },
      tailnet: { baseUrl: "http://100.100.20.30/v1", modelOverrides: {}, allowTailnet: true },
    },
    settings: {},
  }, configPath);

  const stored = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(stored.providers.public, { baseUrl: "https://api.example.com", modelOverrides: {} });
  assert.deepEqual(stored.providers.tailnet, {
    baseUrl: "http://100.100.20.30",
    modelOverrides: {},
    allowTailnet: true,
  });
  assert.deepEqual(readNewApiConfig(configPath), stored);
});

test("NewAPI registers a native provider and restores cached models without /v1 duplication", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pihub-newapi-provider-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  });
  writeNewApiConfig({
    providers: { gateway: { baseUrl: "https://api.example.com/v1", modelOverrides: {} } },
    settings: {},
  });

  let registered;
  createNewApiProviderExtension()({ registerProvider: (provider) => { registered = provider; } });
  assert.equal(registered.id, "gateway");
  assert.equal(registered.baseUrl, "https://api.example.com");
  assert.equal((await registered.auth.apiKey.resolve({
    credential: { type: "api_key", key: "!literal-not-a-command" },
    ctx: { env: async () => undefined, fileExists: async () => false },
    signal: new AbortController().signal,
  })).auth.apiKey, "!literal-not-a-command");

  const cachedModel = {
    id: "vendor/model-1",
    name: "Cached model",
    api: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  await registered.refreshModels({
    allowNetwork: false,
    signal: new AbortController().signal,
    stored: {
      models: [cachedModel],
      etag: newApiOriginFingerprint({ baseUrl: "https://api.example.com", modelOverrides: {} }),
    },
    publish: async (publication) => {
      publication.update?.();
      return true;
    },
  });
  assert.deepEqual(registered.getModels(), [{ ...cachedModel, provider: "gateway" }]);

  await registered.refreshModels({
    allowNetwork: false,
    signal: new AbortController().signal,
    stored: {
      models: [{ ...cachedModel, id: "stale-model", baseUrl: "https://old-origin.example/v1" }],
      etag: newApiOriginFingerprint({ baseUrl: "https://old-origin.example", modelOverrides: {} }),
    },
    publish: async (publication) => {
      publication.update?.();
      return true;
    },
  });
  assert.deepEqual(registered.getModels(), []);
});
