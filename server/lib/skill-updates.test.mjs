import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  checkSkillUpdate,
  checkSkillUpdates,
  skillUpdateKey,
} = await jiti.import("./skill-updates.ts");

const CURRENT_HASH = "a".repeat(40);
const NEXT_HASH = "b".repeat(40);

function install(overrides = {}) {
  return {
    package: "owner/repo@example-skill",
    scope: "global",
    source: "owner/repo",
    sourceType: "github",
    skillsShUrl: "https://skills.sh/owner/repo/example-skill",
    skillPath: "skills/example-skill/SKILL.md",
    versionHash: CURRENT_HASH,
    canCheckForUpdates: true,
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("compares a global lock version with the remote Git tree", async () => {
  const seen = [];
  const upToDate = await checkSkillUpdate(install(), {
    fetcher: async (url) => {
      seen.push(url);
      return jsonResponse({
        sha: "root-hash",
        tree: [{ type: "tree", path: "skills/example-skill", sha: CURRENT_HASH }],
      });
    },
  });

  assert.equal(upToDate.state, "up-to-date");
  assert.equal(upToDate.latestVersion, CURRENT_HASH);
  assert.match(seen[0], /repos\/owner\/repo\/git\/trees\/HEAD/);

  const available = await checkSkillUpdate(install(), {
    fetcher: async () => jsonResponse({
      sha: "root-hash",
      tree: [{ type: "tree", path: "skills/example-skill", sha: NEXT_HASH }],
    }),
  });
  assert.equal(available.state, "update-available");
  assert.equal(available.currentVersion, CURRENT_HASH);
  assert.equal(available.latestVersion, NEXT_HASH);
});

test("uses the repository hash for a root global skill", async () => {
  const result = await checkSkillUpdate(install({ skillPath: "SKILL.md" }), {
    fetcher: async () => jsonResponse({ sha: NEXT_HASH, tree: [] }),
  });

  assert.equal(result.state, "update-available");
  assert.equal(result.latestVersion, NEXT_HASH);
});

test("compares a project lock version with the skills.sh snapshot", async () => {
  let requestedUrl = "";
  const result = await checkSkillUpdate(install({ scope: "project" }), {
    fetcher: async (url) => {
      requestedUrl = url;
      return jsonResponse({ hash: CURRENT_HASH });
    },
  });

  assert.equal(result.state, "up-to-date");
  assert.equal(
    requestedUrl,
    "https://skills.sh/api/download/owner/repo/example-skill",
  );
});

test("returns unsupported without making a remote request", async () => {
  let called = false;
  const result = await checkSkillUpdate(
    install({ canCheckForUpdates: false, versionHash: undefined }),
    { fetcher: async () => { called = true; return jsonResponse({}); } },
  );

  assert.equal(result.state, "unsupported");
  assert.equal(called, false);
});

test("returns a scoped error when the remote check fails", async () => {
  const result = await checkSkillUpdate(install(), {
    fetcher: async () => jsonResponse({}, 503),
  });

  assert.equal(result.state, "error");
  assert.equal(result.message, "HTTP 503");
  assert.equal(skillUpdateKey(install()), "global\0owner/repo@example-skill");
});

test("never falls back to Git when the GitHub API is rate limited", async () => {
  const result = await checkSkillUpdate(install(), {
    fetcher: async () => jsonResponse({}, 403),
  });

  assert.equal(result.state, "error");
  assert.equal(result.message, "HTTP 403");
});

test("rejects attacker-controlled sources and refs before remote access", async () => {
  for (const overrides of [
    { source: "owner/repo/extra" },
    { source: "https://example.test/repo" },
    { ref: "--upload-pack=attacker" },
    { ref: "refs/heads/main^{tree}" },
    { skillPath: "../outside/SKILL.md" },
  ]) {
    const update = await checkSkillUpdate(install(overrides), {
      fetcher: async () => { throw new Error("fetch must not run"); },
    });
    assert.equal(update.state, "error");
    assert.equal(update.message, "Remote update check failed.");
  }
});

test("reuses one remote request for skills from the same GitHub source", async () => {
  let requests = 0;
  const results = await checkSkillUpdates([
    install(),
    install({
      package: "owner/repo@another-skill",
      skillPath: "skills/another-skill/SKILL.md",
      versionHash: "c".repeat(40),
    }),
  ], {
    fetcher: async () => {
      requests++;
      return jsonResponse({
        sha: "root-hash",
        tree: [
          { type: "tree", path: "skills/example-skill", sha: CURRENT_HASH },
          { type: "tree", path: "skills/another-skill", sha: "c".repeat(40) },
        ],
      });
    },
  });

  assert.equal(requests, 1);
  assert.deepEqual(results.map((item) => item.state), ["up-to-date", "up-to-date"]);
});
