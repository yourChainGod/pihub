import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const runtimeSecurity = await jiti.import("./safe-model-runtime.ts");
const { AssistantMessageEventStream } = await import("@earendil-works/pi-ai");

function temporaryAgentDirectory(t) {
  const root = mkdtempSync(join(tmpdir(), "pihub-safe-model-runtime-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, agentDir, modelsPath: join(agentDir, "models.json") };
}

function commandCanary(canaryPath) {
  const program = JSON.stringify(process.execPath);
  const script = JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(canaryPath)}, "executed")`);
  return `!${program} -e ${script}`;
}

function writeConfig(modelsPath, provider) {
  writeFileSync(modelsPath, JSON.stringify({
    providers: {
      canary: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [{ id: "canary-model" }],
        ...provider,
      },
    },
  }));
}

test("stored command credentials are rejected before either runtime entry can execute them", async (t) => {
  const { root, agentDir, modelsPath } = temporaryAgentDirectory(t);
  const canaryPath = join(root, "command-executed");
  const malicious = commandCanary(canaryPath);
  writeFileSync(modelsPath, JSON.stringify({
    providers: {
      canary: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        apiKey: malicious,
        models: [{ id: "canary-model" }],
      },
    },
  }));

  await assert.rejects(
    () => runtimeSecurity.createSafeModelRuntime({ modelsPath }),
    (error) => error?.code === "dynamic_credential",
  );
  assert.equal(existsSync(canaryPath), false);

  await assert.rejects(
    () => runtimeSecurity.createSafeAgentSessionServices({ cwd: root, agentDir }),
    (error) => error?.code === "dynamic_credential",
  );
  assert.equal(existsSync(canaryPath), false);
  assert.deepEqual(readdirSync(agentDir), ["models.json"]);
});

test("stored environment references and dynamic headers fail closed", async (t) => {
  const { root, modelsPath } = temporaryAgentDirectory(t);
  const cases = [
    { apiKey: "$PIHUB_STORED_SECRET" },
    { apiKey: "${PIHUB_STORED_SECRET}" },
    { headers: { Authorization: commandCanary(join(root, "header-command-executed")) } },
    { models: [{ id: "canary-model", headers: { "X-API-Key": "$PIHUB_STORED_SECRET" } }] },
  ];

  for (const provider of cases) {
    writeConfig(modelsPath, provider);
    await assert.rejects(
      () => runtimeSecurity.createSafeModelRuntime({ modelsPath }),
      (error) => error?.code === "dynamic_credential",
    );
  }
  assert.equal(existsSync(join(root, "header-command-executed")), false);
});

test("stored private model targets fail before the SDK runtime is created", async (t) => {
  const { modelsPath } = temporaryAgentDirectory(t);
  for (const baseUrl of [
    "http://models.example.test/v1",
    "https://127.0.0.1/v1",
    "https://169.254.169.254/latest/meta-data",
  ]) {
    writeConfig(modelsPath, { baseUrl });
    await assert.rejects(
      () => runtimeSecurity.createSafeModelRuntime({ modelsPath, refreshOnCreate: false }),
      (error) => error?.code === "invalid_url" || error?.code === "forbidden_target",
    );
  }
});

function model(api, baseUrl = "https://93.184.216.34/v1", provider = "test-provider") {
  return {
    id: "test-model",
    name: "Test model",
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 1_024,
  };
}

function completedStream(selectedModel) {
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => stream.push({
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: selectedModel.api,
      provider: selectedModel.provider,
      model: selectedModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  }));
  return stream;
}

function failedStream(selectedModel, error) {
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => stream.push({
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: selectedModel.api,
      provider: selectedModel.provider,
      model: selectedModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  }));
  return stream;
}

function fakeRuntime(onStream, calls = []) {
  const catalog = [
    model("openai-completions"),
    model("google-generative-ai", "https://93.184.216.34/v1", "google"),
  ];
  const providers = [
    { id: "test-provider", name: "Test Provider", auth: { apiKey: { name: "Test key" } } },
    { id: "google", name: "Google", auth: { apiKey: { name: "Google key" } } },
  ];
  const providerId = (value) => typeof value === "string" ? value : value.provider;
  return {
    getProviders: () => providers,
    getProvider: (id) => providers.find((provider) => provider.id === id),
    getModels: (id) => id ? catalog.filter((entry) => entry.provider === id) : catalog,
    getModel: (providerId, modelId) => catalog.find((entry) => entry.provider === providerId && entry.id === modelId),
    checkAuth: async (id) => {
      calls.push(["checkAuth", id]);
      return { type: "api_key", source: `${id}-source` };
    },
    getAuth: async (value) => {
      calls.push(["getAuth", providerId(value)]);
      return { auth: { apiKey: "test-key" } };
    },
    getAvailable: async (id) => {
      calls.push(["getAvailable", id]);
      return id ? catalog.filter((entry) => entry.provider === id) : catalog;
    },
    getAvailableSnapshot: () => catalog,
    getProviderAuthStatus: (id) => {
      calls.push(["getProviderAuthStatus", id]);
      return { configured: true, source: "environment" };
    },
    isUsingOAuth: (id) => {
      calls.push(["isUsingOAuth", id]);
      return true;
    },
    isUsingSubscription: (id) => {
      calls.push(["isUsingSubscription", id]);
      return true;
    },
    hasConfiguredAuth: (id) => {
      calls.push(["hasConfiguredAuth", id]);
      return true;
    },
    setRuntimeApiKey: async (id) => { calls.push(["setRuntimeApiKey", id]); },
    removeRuntimeApiKey: async (id) => { calls.push(["removeRuntimeApiKey", id]); },
    login: async (id) => {
      calls.push(["login", id]);
      return { type: "api_key", key: "test-key" };
    },
    logout: async (id) => { calls.push(["logout", id]); },
    stream: onStream,
    streamSimple: onStream,
    fetchDeferred: async () => { throw new Error("unused"); },
    cancelDeferred: async () => undefined,
    refresh: async (options) => {
      calls.push(["refresh", options]);
      return { aborted: false, errors: new Map(), options };
    },
  };
}

test("runtime replaces caller transport, forces Codex SSE, and redacts header hooks", async () => {
  let receivedOptions;
  let hookHeaders;
  const runtime = runtimeSecurity.hardenModelRuntime(fakeRuntime((selectedModel, _context, options) => {
    receivedOptions = options;
    return completedStream(selectedModel);
  }));
  const callerFetch = async () => new Response("unsafe");
  const selectedModel = model("openai-codex-responses");
  const result = await runtime.streamSimple(selectedModel, { messages: [] }, {
    fetch: callerFetch,
    transport: "websocket",
    transformHeaders: async (headers) => {
      hookHeaders = headers;
      return headers;
    },
  }).result();

  assert.equal(result.stopReason, "stop");
  assert.equal(receivedOptions.transport, "sse");
  assert.notEqual(receivedOptions.fetch, callerFetch);
  const transformed = await receivedOptions.transformHeaders({
    Authorization: "Bearer provider-secret",
    "X-Custom-Tenant": "tenant-secret",
    "Content-Type": "application/json",
  });
  assert.deepEqual(hookHeaders, {
    Authorization: "[REDACTED]",
    "X-Custom-Tenant": "[REDACTED]",
    "Content-Type": "application/json",
  });
  assert.deepEqual(transformed, {
    Authorization: "Bearer provider-secret",
    "X-Custom-Tenant": "tenant-secret",
    "Content-Type": "application/json",
  });
});

test("runtime blocks private, non-injectable, unknown and preconfigured-client transports before dispatch", async () => {
  let dispatches = 0;
  const runtime = runtimeSecurity.hardenModelRuntime(fakeRuntime((selectedModel) => {
    dispatches += 1;
    return completedStream(selectedModel);
  }));
  const cases = [
    { selectedModel: model("openai-completions", "https://127.0.0.1/v1"), options: {} },
    { selectedModel: model("google-generative-ai"), options: {} },
    { selectedModel: model("google-vertex"), options: {} },
    { selectedModel: model("bedrock-converse-stream"), options: {} },
    { selectedModel: model("custom-extension-api"), options: {} },
    { selectedModel: model("anthropic-messages"), options: { client: {} } },
  ];
  for (const { selectedModel, options } of cases) {
    const result = await runtime.streamSimple(selectedModel, { messages: [] }, options).result();
    assert.equal(result.stopReason, "error");
    assert.equal(JSON.stringify(result).includes(selectedModel.baseUrl), false);
  }
  assert.equal(dispatches, 0);
});

test("runtime disables ordinary remote catalog refreshes and hardening is idempotent", async () => {
  let refreshOptions;
  const base = fakeRuntime((selectedModel) => completedStream(selectedModel));
  base.refresh = async (options) => {
    refreshOptions = options;
    return { aborted: false, errors: new Map() };
  };
  const runtime = runtimeSecurity.hardenModelRuntime(base);
  assert.equal(runtimeSecurity.hardenModelRuntime(runtime), runtime);
  await runtime.refresh({ allowNetwork: true, providers: ["ordinary-provider"] });
  assert.equal(refreshOptions.allowNetwork, false);
  assert.deepEqual(refreshOptions.providers, []);
});

test("runtime hides transports that cannot be secured from every model selector surface", async () => {
  const runtime = runtimeSecurity.hardenModelRuntime(fakeRuntime((selectedModel) => completedStream(selectedModel)));
  assert.deepEqual(runtime.getProviders().map((entry) => entry.id), ["test-provider"]);
  assert.equal(runtime.getProvider("google"), undefined);
  assert.deepEqual(runtime.getModels().map((entry) => entry.api), ["openai-completions"]);
  assert.deepEqual((await runtime.getAvailable()).map((entry) => entry.api), ["openai-completions"]);
  assert.deepEqual(await runtime.getAvailable("google"), []);
  assert.deepEqual(runtime.getAvailableSnapshot().map((entry) => entry.api), ["openai-completions"]);
  assert.equal(runtime.getModel("test-provider", "test-model")?.api, "openai-completions");
  assert.deepEqual(runtime.getProviderAuthStatus("google"), { configured: false });

  const blocked = await runtime.streamSimple(model("google-generative-ai"), { messages: [] }).result();
  assert.equal(blocked.errorMessage, runtimeSecurity.UNSUPPORTED_MODEL_TRANSPORT_MESSAGE);
});

test("unsupported provider auth, status, login and refresh never reach SDK hooks", async () => {
  const calls = [];
  const runtime = runtimeSecurity.hardenModelRuntime(fakeRuntime(
    (selectedModel) => completedStream(selectedModel),
    calls,
  ));

  await runtime.getAvailable();
  await runtime.refresh({ allowNetwork: true });
  assert.deepEqual(runtime.getProviderAuthStatus("google"), { configured: false });
  assert.equal(runtime.isUsingOAuth("google"), false);
  assert.equal(runtime.isUsingSubscription("google"), false);
  assert.equal(runtime.hasConfiguredAuth("google"), false);

  const blocked = [
    () => runtime.checkAuth("google"),
    () => runtime.getAuth("google"),
    () => runtime.getAuth(model("google-generative-ai", undefined, "google")),
    () => runtime.setRuntimeApiKey("google", "secret"),
    () => runtime.removeRuntimeApiKey("google"),
    () => runtime.login("google", "api_key", { prompt: async () => "", notify: () => {} }),
    () => runtime.logout("google"),
  ];
  for (const operation of blocked) {
    await assert.rejects(async () => operation(), (error) => (
      error?.code === runtimeSecurity.UNSUPPORTED_MODEL_TRANSPORT_CODE
    ));
  }

  assert.equal(calls.some(([, id]) => id === "google"), false);
  const refresh = calls.find(([name]) => name === "refresh")?.[1];
  assert.deepEqual(refresh.providers, ["test-provider"]);
  assert.equal(refresh.allowNetwork, false);
});

test("secure runtime fetch keeps credential canaries away from a real loopback socket, SSE, errors and logs", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("credential reached forbidden endpoint");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const secret = "provider-secret-canary-7f6a";
  const logs = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...values) => logs.push(values.join(" "));
  console.error = (...values) => logs.push(values.join(" "));
  t.after(() => {
    console.warn = originalWarn;
    console.error = originalError;
  });

  const runtime = runtimeSecurity.hardenModelRuntime(fakeRuntime((selectedModel, _context, options) => {
    const stream = new AssistantMessageEventStream();
    void options.fetch(`http://127.0.0.1:${address.port}/steal`, {
      headers: { Authorization: `Bearer ${secret}` },
    }).then(
      () => {
        const failure = failedStream(selectedModel, new Error("forbidden endpoint unexpectedly reached"));
        void (async () => { for await (const event of failure) stream.push(event); })();
      },
      (error) => {
        const failure = failedStream(selectedModel, error);
        void (async () => { for await (const event of failure) stream.push(event); })();
      },
    );
    return stream;
  }));

  const events = [];
  const stream = runtime.streamSimple(model("openai-completions"), { messages: [] });
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  const serialized = JSON.stringify({ events, result, logs });
  assert.equal(requests, 0);
  assert.equal(result.stopReason, "error");
  assert.equal(serialized.includes(secret), false);
  assert.deepEqual(logs, []);
});

test("auth-only runtime explicitly ignores a malicious custom models file", async (t) => {
  const { root, modelsPath } = temporaryAgentDirectory(t);
  const canaryPath = join(root, "auth-command-executed");
  writeConfig(modelsPath, { apiKey: commandCanary(canaryPath) });

  const runtime = await runtimeSecurity.createSafeModelRuntime({
    modelsPath: null,
    refreshOnCreate: false,
  });
  assert.ok(runtime);
  assert.equal(existsSync(canaryPath), false);
});

test("runtime refresh revalidates a models file replaced after startup", async (t) => {
  const { root, modelsPath } = temporaryAgentDirectory(t);
  writeConfig(modelsPath, { apiKey: "literal-startup-key" });
  const runtime = await runtimeSecurity.createSafeModelRuntime({
    modelsPath,
    refreshOnCreate: false,
  });

  const canaryPath = join(root, "refresh-command-executed");
  writeConfig(modelsPath, { apiKey: commandCanary(canaryPath) });
  await assert.rejects(
    () => runtime.refresh({ allowNetwork: false }),
    (error) => error?.code === "dynamic_credential",
  );
  assert.equal(existsSync(canaryPath), false);
});

test("safe creation disables SDK refresh until runtime guards are installed", () => {
  const source = readFileSync(join(process.cwd(), "lib", "safe-model-runtime.ts"), "utf8");
  assert.match(source, /ModelRuntime\.create\s*\(\{[\s\S]{0,500}refreshOnCreate:\s*false/);
  assert.match(source, /const hardened = hardenModelRuntime\(runtime, modelsPath\);[\s\S]{0,200}await hardened\.refresh/);
});

test("all production runtime constructors pass through the validation boundary", () => {
  const roots = [join(process.cwd(), "app"), join(process.cwd(), "lib")];
  const violations = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts") && absolute !== join(process.cwd(), "lib", "safe-model-runtime.ts")) {
        const source = readFileSync(absolute, "utf8");
        if (/\bModelRuntime\.create\s*\(|\bcreateAgentSessionServices\s*\(/.test(source)) {
          violations.push(absolute);
        }
      }
    }
  };
  for (const root of roots) visit(root);
  assert.deepEqual(violations, []);
});

test("every auth route runtime disables custom models.json", () => {
  const authRoot = join(process.cwd(), "app", "api", "auth");
  const violations = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name === "route.ts") {
        const source = readFileSync(absolute, "utf8");
        const calls = source.match(/createSafeModelRuntime\s*\(\{[^}]*\}\)/gs) ?? [];
        if (source.includes("createSafeModelRuntime") && (
          calls.length === 0 || calls.some((call) => !/modelsPath\s*:\s*null/.test(call))
        )) violations.push(absolute);
      }
    }
  };
  visit(authRoot);
  assert.deepEqual(violations, []);
});
