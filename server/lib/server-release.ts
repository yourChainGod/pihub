import {
  createReleaseTrust,
  fetchAndVerifyReleaseManifest,
  type VerifiedReleaseManifest,
} from "./release-manifest";

export const SERVER_RELEASE_OWNER = "yourChainGod";
export const SERVER_RELEASE_REPO = "pihub";
export const SERVER_RELEASE_CHANNEL = "stable";
export const SERVER_RELEASE_PUBLIC_KEY = "2o1U_BIfYt1G_xYhSQBpAtHiQfTNi2ieUkxhvxBHkHI";
export const SERVER_RELEASE_MANIFEST_URL =
  `https://github.com/${SERVER_RELEASE_OWNER}/${SERVER_RELEASE_REPO}/releases/latest/download/release-manifest.json`;
const SERVER_RELEASE_MANIFEST_CACHE_MS = 30_000;

let cachedManifest: { manifest: VerifiedReleaseManifest; checkedAt: number } | undefined;
let manifestRequest: Promise<VerifiedReleaseManifest> | undefined;
let cacheGeneration = 0;

export function createServerReleaseTrust() {
  return createReleaseTrust({
    owner: SERVER_RELEASE_OWNER,
    repo: SERVER_RELEASE_REPO,
    channel: SERVER_RELEASE_CHANNEL,
    publicKey: SERVER_RELEASE_PUBLIC_KEY,
  });
}

export function fetchVerifiedServerReleaseManifest(): Promise<VerifiedReleaseManifest> {
  const now = Date.now();
  if (
    cachedManifest
    && now >= cachedManifest.checkedAt
    && now - cachedManifest.checkedAt <= SERVER_RELEASE_MANIFEST_CACHE_MS
  ) {
    return Promise.resolve(cachedManifest.manifest);
  }
  if (manifestRequest) return manifestRequest;
  const generation = cacheGeneration;
  const request = fetchAndVerifyReleaseManifest(
    SERVER_RELEASE_MANIFEST_URL,
    createServerReleaseTrust(),
    { timeoutMs: 15_000, maxRedirects: 3, allowToken: false },
  ).then((manifest) => {
    if (generation === cacheGeneration) cachedManifest = { manifest, checkedAt: Date.now() };
    return manifest;
  }).finally(() => {
    if (manifestRequest === request) manifestRequest = undefined;
  });
  manifestRequest = request;
  return request;
}

/** Test seam for deterministic route and cache tests. */
export function resetServerReleaseManifestCacheForTests(): void {
  cacheGeneration += 1;
  cachedManifest = undefined;
  manifestRequest = undefined;
}
