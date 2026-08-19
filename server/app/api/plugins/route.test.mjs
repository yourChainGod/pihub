import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": new URL("../../../", import.meta.url).pathname },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./route.ts");
const { allowFileRoot, revokeFileRoot } = await jiti.import("../../../lib/file-access.ts");

const DEVICE = `dev_${"P".repeat(22)}`;

function trustedHeaders(capability) {
  return {
    "x-pihub-authenticated-device": DEVICE,
    "x-pihub-authenticated-capabilities": capability,
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-plugin-route-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const pluginRoot = path.join(root, "private-user-secret-plugin-source");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "index.js"), "export default () => {};\n");
  fs.writeFileSync(path.join(pluginRoot, "package.json"), JSON.stringify({
    name: "safe-plugin",
    version: "1.2.3",
    pi: { extensions: ["index.js"] },
  }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [pluginRoot],
  }));

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  allowFileRoot(cwd, { ownerId: DEVICE });
  t.after(() => {
    revokeFileRoot(cwd, { ownerId: DEVICE });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { agentDir, cwd, pluginRoot };
}

function assertPrivatePluginContract(body, sensitiveSource, extensions = 1) {
  assert.equal(body.packages.length, 1);
  assert.match(body.packages[0].id, /^pkg_[A-Za-z0-9_-]{43}$/);
  assert.equal(body.packages[0].label, "safe-plugin");
  assert.equal(body.packages[0].version, "1.2.3");
  assert.deepEqual(body.packages[0].counts, {
    extensions,
    skills: 0,
    prompts: 0,
    themes: 0,
  });
  assert.equal("source" in body.packages[0], false);
  assert.equal("installedPath" in body.packages[0], false);
  assert.equal("resources" in body.packages[0], false);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(sensitiveSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(JSON.stringify(body), /private-user-secret-plugin-source/);
}

test("plugin inventory and mutations use opaque handles without disclosing configured paths", async (t) => {
  const { cwd, pluginRoot } = fixture(t);
  const url = `http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`;
  assert.equal((await route.GET(new Request(url))).status, 401);
  assert.equal((await route.GET(new Request(url, {
    headers: trustedHeaders("packages:manage"),
  }))).status, 403);
  const getResponse = await route.GET(new Request(
    url,
    { headers: trustedHeaders("packages:read") },
  ));
  assert.equal(getResponse.status, 200);
  assert.match(getResponse.headers.get("cache-control") ?? "", /private/);
  assert.match(getResponse.headers.get("cache-control") ?? "", /no-store/);
  const initial = await getResponse.json();
  assertPrivatePluginContract(initial, pluginRoot);
  assert.equal(initial.packages[0].status, "loaded");

  const disableResponse = await route.POST(new Request("http://localhost/api/plugins", {
    method: "POST",
    headers: {
      ...trustedHeaders("packages:manage"),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "disable",
      packageId: initial.packages[0].id,
      scope: "global",
      cwd,
    }),
  }));
  assert.equal(disableResponse.status, 200);
  const disabled = await disableResponse.json();
  assertPrivatePluginContract(disabled, pluginRoot, 0);
  assert.equal(disabled.packages[0].status, "disabled");
  assert.equal(disabled.packages[0].disabled, true);

  const rawSourceResponse = await route.POST(new Request("http://localhost/api/plugins", {
    method: "POST",
    headers: {
      ...trustedHeaders("packages:manage"),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "enable",
      source: pluginRoot,
      scope: "global",
      cwd,
    }),
  }));
  assert.equal(rawSourceResponse.status, 400);
  assert.deepEqual(await rawSourceResponse.json(), { error: "packageId required" });
});
