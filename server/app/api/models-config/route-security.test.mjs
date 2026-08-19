import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "pihub-model-route-"));
process.env.PI_CODING_AGENT_DIR = agentDirectory;
const modelsPath = path.join(agentDirectory, "models.json");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const DEVICE_ID = `dev_${"M".repeat(22)}`;

test.after(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDirectory, { recursive: true, force: true });
});

function trustedHeaders(capability, json = false) {
  return {
    "x-pihub-authenticated-device": DEVICE_ID,
    "x-pihub-authenticated-capabilities": capability,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function putRequest(body) {
  return new Request("http://localhost:30141/api/models-config", {
    method: "PUT",
    headers: { ...trustedHeaders("models:manage", true), host: "localhost:30141" },
    body: JSON.stringify(body),
  });
}

test("models config GET never exposes provider or model header credentials", async () => {
  const raw = {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        apiKey: "route-api-secret",
        headers: { Authorization: "Bearer route-header-secret" },
        models: [{ id: "acme", headers: { "X-Private": "route-model-secret" } }],
      },
    },
  };
  await writeFile(modelsPath, JSON.stringify(raw), { mode: 0o600 });
  const response = await GET(new Request("http://localhost:30141/api/models-config", {
    headers: trustedHeaders("models:read"),
  }));
  const text = await response.text();
  assert.equal(response.status, 200);
  for (const secret of ["route-api-secret", "route-header-secret", "route-model-secret"]) {
    assert.equal(text.includes(secret), false);
  }
  assert.match(text, /\[REDACTED\]/);
});

test("models config PUT cannot plant command or environment credential values", async () => {
  const original = await readFile(modelsPath, "utf8");
  const marker = path.join(agentDirectory, "command-executed");
  for (const maliciousProvider of [
    { apiKey: `!touch ${marker}` },
    { apiKey: "$PIHUB_ROUTE_SECRET" },
    { headers: { Authorization: "Bearer ${PIHUB_ROUTE_SECRET}" } },
  ]) {
    const response = await PUT(putRequest({
      providers: {
        attacker: {
          baseUrl: "https://attacker.example/v1",
          api: "openai-completions",
          models: [{ id: "attacker-model" }],
          ...maliciousProvider,
        },
      },
    }));
    assert.equal(response.status, 400);
    assert.equal(existsSync(marker), false);
    assert.equal(await readFile(modelsPath, "utf8"), original);
  }
});
