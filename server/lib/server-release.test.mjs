import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const serverRelease = await jiti.import("./server-release.ts");
const originalFetch = globalThis.fetch;

test("uses the published stable release as the fixed manifest entrypoint", () => {
  assert.equal(
    serverRelease.SERVER_RELEASE_MANIFEST_URL,
    "https://github.com/yourChainGod/pihub/releases/latest/download/release-manifest.json",
  );
  assert.equal(serverRelease.SERVER_RELEASE_CHANNEL, "stable");
});

test.afterEach(() => {
  serverRelease.resetServerReleaseManifestCacheForTests();
  globalThis.fetch = originalFetch;
});

test("deduplicates concurrent manifest checks without caching verification failures", async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ init, url: String(url) });
    return new Response("{}", { status: 200 });
  };

  const first = serverRelease.fetchVerifiedServerReleaseManifest();
  const second = serverRelease.fetchVerifiedServerReleaseManifest();
  assert.equal(first, second);
  await assert.rejects(first);
  await assert.rejects(second);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, serverRelease.SERVER_RELEASE_MANIFEST_URL);
  const headers = new Headers(requests[0].init.headers);
  assert.equal(headers.get("authorization"), null);
  assert.equal(requests[0].init.credentials, "omit");
  assert.equal(requests[0].init.redirect, "manual");

  await assert.rejects(serverRelease.fetchVerifiedServerReleaseManifest());
  assert.equal(requests.length, 2);
});
