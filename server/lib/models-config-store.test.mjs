import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  normalizeModelsConfigCosts,
  readPublicModelsConfig,
  readModelsConfig,
  REDACTED_CONFIG_VALUE,
  writeModelsConfig,
} = await jiti.import("./models-config-store.ts");
const { invalidateModelsCache, loadModelsWithCache } = await jiti.import("./models-cache.ts");
const { buildSessionContext, getSessionEntries } = await jiti.import("./session-reader.ts");

function createTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-models-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
    thinkingLevelPins: {},
  };
}

test("saving models.json atomically invalidates the model-list cache", async (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const config = {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [{ id: "acme-2" }],
      },
    },
  };
  let loads = 0;

  invalidateModelsCache();
  await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  writeModelsConfig(config, modelsPath);
  const reloaded = await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));

  assert.equal(loads, 2);
  assert.equal(reloaded.modelList[0].id, "load-2");
  assert.deepEqual(readModelsConfig(modelsPath), config);
  assert.deepEqual(readdirSync(join(root, "agent")), ["models.json"]);
  if (process.platform !== "win32") {
    assert.equal(statSync(modelsPath).mode & 0o777, 0o600);
  }
});

test("models.json writes fill partial cost groups with zero and remove empty groups", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const config = {
    providers: {
      acme: {
        models: [
          { id: "empty-cost", cost: {} },
          { id: "partial-cost", cost: { input: 1, output: 2, cacheRead: 0.1 } },
          { id: "complete-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.1 } },
        ],
        modelOverrides: {
          inherited: { cost: { input: 3 } },
        },
      },
    },
  };

  const normalized = normalizeModelsConfigCosts(config);
  assert.deepEqual(normalized.providers.acme.models, [
    { id: "empty-cost" },
    { id: "partial-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
    { id: "complete-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.1 } },
  ]);
  assert.deepEqual(normalized.providers.acme.modelOverrides, {
    inherited: { cost: { input: 3 } },
  });
  assert.deepEqual(config.providers.acme.models[0], { id: "empty-cost", cost: {} });

  writeModelsConfig(config, modelsPath);
  assert.deepEqual(readModelsConfig(modelsPath), normalized);
});

test("public models config recursively redacts credentials and preserves them on round-trip", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const config = {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        apiKey: "top-secret-api-key",
        headers: {
          Authorization: "Bearer provider-secret",
          "X-Custom-Tenant-Secret": "tenant-secret",
        },
        models: [{
          id: "acme-2",
          headers: { "X-Model-Credential": "model-secret" },
        }],
      },
    },
  };
  writeModelsConfig(config, modelsPath);

  const publicConfig = readPublicModelsConfig(modelsPath);
  const serialized = JSON.stringify(publicConfig);
  for (const secret of ["top-secret-api-key", "provider-secret", "tenant-secret", "model-secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(publicConfig.providers.acme.apiKey, REDACTED_CONFIG_VALUE);
  assert.deepEqual(publicConfig.providers.acme.headers, {
    Authorization: REDACTED_CONFIG_VALUE,
    "X-Custom-Tenant-Secret": REDACTED_CONFIG_VALUE,
  });

  publicConfig.providers.acme.models[0].name = "Edited without exposing secrets";
  writeModelsConfig(publicConfig, modelsPath);
  const stored = readModelsConfig(modelsPath);
  assert.equal(stored.providers.acme.apiKey, "top-secret-api-key");
  assert.equal(stored.providers.acme.headers.Authorization, "Bearer provider-secret");
  assert.equal(stored.providers.acme.models[0].headers["X-Model-Credential"], "model-secret");
  assert.equal(stored.providers.acme.models[0].name, "Edited without exposing secrets");
});

test("models config rejects command and environment-backed credentials before persistence", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const original = {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        apiKey: "safe-literal",
        models: [{ id: "acme-2" }],
      },
    },
  };
  writeModelsConfig(original, modelsPath);

  for (const malicious of [
    { apiKey: "!touch /tmp/pihub-command-must-not-run" },
    { apiKey: "$PIHUB_SECRET" },
    { headers: { Authorization: "Bearer ${PIHUB_SECRET}" } },
    { models: [{ id: "acme-2", headers: { "X-API-Key": "!steal-secret" } }] },
  ]) {
    assert.throws(() => writeModelsConfig({
      providers: {
        acme: {
          baseUrl: "https://models.example.test/v1",
          api: "openai-completions",
          models: [{ id: "acme-2" }],
          ...malicious,
        },
      },
    }, modelsPath), (error) => error.code === "dynamic_credential");
    assert.deepEqual(readModelsConfig(modelsPath), original);
  }
});

test("models config requires public HTTPS and allows only explicit loopback development", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  writeModelsConfig({
    providers: {
      public: { baseUrl: "models.example.test/v1/", models: [] },
    },
  }, modelsPath);
  assert.equal(readModelsConfig(modelsPath).providers.public.baseUrl, "https://models.example.test/v1");

  for (const baseUrl of [
    "http://models.example.test/v1",
    "http://100.100.20.30/v1",
    "https://user:pass@models.example.test/v1",
    "https://models.example.test/v1?token=secret",
    "https://127.0.0.1/v1",
    "https://169.254.169.254/latest/meta-data",
  ]) {
    assert.throws(() => writeModelsConfig({
      providers: { blocked: { baseUrl, allowTailnet: true, models: [] } },
    }, modelsPath));
  }

  const envName = "PIHUB_ALLOW_LOCAL_MODEL_PROVIDER";
  const original = process.env[envName];
  t.after(() => {
    if (original === undefined) delete process.env[envName];
    else process.env[envName] = original;
  });
  process.env[envName] = "1";
  writeModelsConfig({
    providers: { local: { baseUrl: "http://localhost:11434/v1/", models: [] } },
  }, modelsPath);
  assert.equal(readModelsConfig(modelsPath).providers.local.baseUrl, "http://localhost:11434/v1");
});

test("saving models.json drops blank model rows without hiding other schema errors", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");

  writeModelsConfig({
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [
          { id: "working-model", cost: { input: 1 } },
          { id: "" },
          { id: "  " },
          { id: 42 },
          { name: "Missing identifier" },
          null,
        ],
      },
    },
  }, modelsPath);

  assert.deepEqual(readModelsConfig(modelsPath), {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [
          { id: "working-model", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } },
          { id: 42 },
          { name: "Missing identifier" },
          null,
        ],
      },
    },
  });
});

test("an existing session opens after its historical model is removed from config", (t) => {
  const root = createTempRoot(t);
  const sessionPath = join(root, "session.jsonl");
  const modelsPath = join(root, "models.json");
  const records = [
    {
      type: "session",
      version: 3,
      id: "existing-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: root,
    },
    {
      type: "model_change",
      id: "model-old",
      parentId: null,
      provider: "retired-provider",
      modelId: "retired-model",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
    {
      type: "message",
      id: "user-1",
      parentId: "model-old",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: "keep this conversation" },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        provider: "retired-provider",
        model: "retired-model",
        content: [{ type: "text", text: "still readable" }],
      },
    },
  ];
  writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  writeModelsConfig({
    providers: {
      "retired-provider": {
        baseUrl: "https://retired.example.test/v1",
        api: "openai-completions",
        models: [{ id: "retired-model" }],
      },
    },
  }, modelsPath);
  const beforeChange = buildSessionContext(getSessionEntries(sessionPath));
  assert.equal(beforeChange.messages[1].content[0].text, "still readable");

  writeModelsConfig({
    providers: {
      replacement: {
        baseUrl: "https://replacement.example.test/v1",
        api: "openai-completions",
        models: [{ id: "replacement-model" }],
      },
    },
  }, modelsPath);

  const afterChange = buildSessionContext(getSessionEntries(sessionPath));
  assert.deepEqual(afterChange.entryIds, ["user-1", "assistant-1"]);
  assert.equal(afterChange.messages[0].content, "keep this conversation");
  assert.equal(afterChange.messages[1].content[0].text, "still readable");
});
