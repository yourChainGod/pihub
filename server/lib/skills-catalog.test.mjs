import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { searchSkillsCatalog, SKILLS_CATALOG_ORIGIN } = await jiti.import("./skills-catalog.ts");
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

test("skills search is fixed to skills.sh and validates bounded catalog records", async () => {
  process.env.SKILLS_API_URL = "http://127.0.0.1:9";
  let requested = "";
  const results = await searchSkillsCatalog("typescript", 10, new AbortController().signal, {
    __test: {
      resolver: publicDns,
      transport: async (input) => {
        requested = String(input);
        return json({
          skills: [
            { id: "owner/repo/safe-skill", installs: 1200, name: "safe-skill", source: "owner/repo" },
            { id: "bad", installs: 99, name: "../escape", source: "http://127.0.0.1/repo" },
          ],
        });
      },
    },
  });
  delete process.env.SKILLS_API_URL;

  assert.equal(new URL(requested).origin, SKILLS_CATALOG_ORIGIN);
  assert.equal(new URL(requested).pathname, "/api/search");
  assert.deepEqual(results, [{
    package: "owner/repo@safe-skill",
    installs: "1.2K installs",
    url: "https://skills.sh/owner/repo/safe-skill",
  }]);
});

test("skills search blocks redirects, oversized bodies, invalid JSON, timeout, and abort", async () => {
  await assert.rejects(
    () => searchSkillsCatalog("safe", 10, new AbortController().signal, {
      __test: {
        resolver: publicDns,
        transport: async () => new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/internal" },
        }),
      },
    }),
    (error) => error?.code === "redirect_blocked" || error?.code === "forbidden_target",
  );

  await assert.rejects(
    () => searchSkillsCatalog("safe", 10, new AbortController().signal, {
      maxResponseBytes: 32,
      __test: {
        resolver: publicDns,
        transport: async () => json({ skills: [] }, {
          headers: { "content-length": "1024" },
        }),
      },
    }),
    (error) => error?.code === "response_too_large",
  );

  await assert.rejects(
    () => searchSkillsCatalog("safe", 10, new AbortController().signal, {
      __test: {
        resolver: publicDns,
        transport: async () => new Response("<html>bad</html>", {
          headers: { "content-type": "text/html" },
        }),
      },
    }),
    (error) => error?.code === "invalid_json",
  );

  await assert.rejects(
    () => searchSkillsCatalog("safe", 10, new AbortController().signal, {
      timeoutMs: 10,
      __test: { resolver: async () => new Promise(() => undefined) },
    }),
    (error) => error?.code === "timeout",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => searchSkillsCatalog("safe", 10, controller.signal, {
      __test: { resolver: publicDns, transport: async () => json({ skills: [] }) },
    }),
    (error) => error?.code === "timeout",
  );
});

test("skills search route requires trusted packages:read before any network work", async () => {
  const { POST } = await jiti.import("../app/api/skills/search/route.ts");
  const request = (headers = {}) => new Request("http://localhost/api/skills/search", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query: "safe" }),
  });
  assert.equal((await POST(request())).status, 401);
  assert.equal((await POST(request({
    "x-pihub-authenticated-device": "dev_" + "R".repeat(22),
    "x-pihub-authenticated-capabilities": "devices:manage",
  }))).status, 403);
});
