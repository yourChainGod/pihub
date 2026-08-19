import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDirectory = await mkdtemp(path.join(os.tmpdir(), "pihub-newapi-route-"));
process.env.PI_CODING_AGENT_DIR = agentDirectory;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const DEVICE_ID = `dev_${"N".repeat(22)}`;

test.after(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDirectory, { recursive: true, force: true });
});

function request(apiKey) {
  return new Request("http://localhost:30141/api/pihub/newapi", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      "content-type": "application/json",
      "x-pihub-authenticated-device": DEVICE_ID,
      "x-pihub-authenticated-capabilities": "models:manage",
    },
    body: JSON.stringify({
      action: "save",
      name: "security-test-gateway",
      baseUrl: "https://api.example.com/v1",
      apiKey,
    }),
  });
}

test("NewAPI save rejects command and environment credentials before writing", async () => {
  const marker = path.join(agentDirectory, "command-executed");
  for (const value of [`!touch ${marker}`, "$PIHUB_NEWAPI_SECRET", "prefix-${PIHUB_NEWAPI_SECRET}"]) {
    const response = await POST(request(value));
    assert.equal(response.status, 400);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(path.join(agentDirectory, "auth.json")), false);
    assert.equal(existsSync(path.join(agentDirectory, "extensions", "provider-newapi.json")), false);
  }
});
