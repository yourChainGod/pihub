import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": new URL("../../", import.meta.url).pathname },
  interopDefault: true,
  moduleCache: false,
});
const DEVICE = "dev_" + "S".repeat(22);

function trustedHeaders(capability) {
  return {
    "x-pihub-authenticated-device": DEVICE,
    "x-pihub-authenticated-capabilities": capability,
  };
}

test("remote package routes contain no npm, npx, Git, or SDK package mutation fallback", async () => {
  const sources = await Promise.all([
    read("./skills/install/route.ts"),
    read("./skills/update/route.ts"),
    read("./skills/search/route.ts"),
    read("./skills/check/route.ts"),
    read("./plugins/route.ts"),
    read("../../lib/skill-updates.ts"),
    read("../../lib/skills-catalog.ts"),
  ]);
  const combined = sources.join("\n");

  assert.doesNotMatch(combined, /SKILLS_API_URL/);
  assert.doesNotMatch(combined, /\b(?:runNpxPackage|runNpmCli|execFile|spawn)\s*\(/);
  assert.doesNotMatch(combined, /node:(?:child_process|https?|net)/);
  assert.doesNotMatch(combined, /\.(?:installAndPersist|removeAndPersist|update)\s*\(/);
  assert.doesNotMatch(combined, /\bgit\s+(?:clone|fetch|pull|ls-remote)\b/i);
  assert.match(combined, /https:\/\/skills\.sh/);
  assert.match(combined, /createSecureOutboundFetch|fetchOutboundJson/);
});

test("dynamic skill install and update endpoints fail closed with structured 410", async () => {
  for (const name of ["install", "update"]) {
    const route = await jiti.import("./skills/" + name + "/route.ts");
    const request = (headers = {}) => new Request("http://localhost/api/skills/" + name, {
      method: "POST",
      headers,
    });
    assert.equal((await route.POST(request())).status, 401);
    assert.equal((await route.POST(request(trustedHeaders("packages:read")))).status, 403);
    const response = await route.POST(request(trustedHeaders("packages:manage")));
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), {
      code: "signed_catalog_required",
      error: name === "install"
        ? "Skill installation is unavailable until a signed immutable catalog is configured"
        : "Skill updates are unavailable until a signed immutable catalog is configured",
    });
    assert.match(response.headers.get("cache-control") ?? "", /private/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("dynamic plugin install, update, and remove endpoints fail closed before using source", async () => {
  const route = await jiti.import("./plugins/route.ts");
  for (const action of ["install", "update", "remove"]) {
    const response = await route.POST(new Request("http://localhost/api/plugins", {
      method: "POST",
      headers: {
        ...trustedHeaders("packages:manage"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action,
        cwd: "/ignored",
        scope: "project",
        source: "git:http://127.0.0.1/attacker#main",
      }),
    }));
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), {
      code: "signed_catalog_required",
      error: "Plugin package mutations are unavailable until a signed immutable catalog is configured",
    });
  }
});

test("every remaining request-scoped child or outbound operation receives client cancellation", async () => {
  const setup = await read("./pihub/setup/route.ts");
  const search = await read("./skills/search/route.ts");
  const check = await read("./skills/check/route.ts");
  const sessionExport = await read("./sessions/[id]/export/route.ts");

  assert.match(setup, /status\(request\.signal\)/);
  assert.match(setup, /signal: request\.signal/);
  assert.match(search, /searchSkillsCatalog\(query, parseLimit\(body\.limit\), req\.signal\)/);
  assert.match(check, /signal: req\.signal/);
  assert.match(sessionExport, /exportSession\(filePath, outputPath, req\.signal\)/);
  assert.match(sessionExport, /signal,/);
});
