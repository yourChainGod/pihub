import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const release = await jiti.import("./release-manifest.ts");

const OWNER = "pihub-project";
const REPO = "pihub";
const CHANNEL = "stable";
const VERSION = "0.0.1";
const RELEASE_URL = `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/pihub-server.tgz`;
const LATEST_MANIFEST_URL = `https://github.com/${OWNER}/${REPO}/releases/latest/download/release-manifest.json`;
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const trust = release.createReleaseTrust({
  owner: OWNER,
  repo: REPO,
  channel: CHANNEL,
  publicKey,
});

function hasCode(code) {
  return (error) => error instanceof release.ReleaseManifestError && error.code === code;
}

function createSignedAsset(overrides = {}, signingKey = privateKey) {
  const { signature: suppliedSignature, ...unsignedOverrides } = overrides;
  const unsigned = {
    version: VERSION,
    platform: "darwin",
    arch: "arm64",
    url: RELEASE_URL,
    sha256: "a".repeat(64),
    size: 1_024,
    ...unsignedOverrides,
  };
  return {
    ...unsigned,
    signature: suppliedSignature ?? sign(
      null,
      release.releaseAssetSigningPayload(unsigned),
      signingKey,
    ).toString("base64url"),
  };
}

function createSignedManifest(overrides = {}, signingKey = privateKey) {
  const { signature: suppliedSignature, ...unsignedOverrides } = overrides;
  const unsigned = {
    schemaVersion: release.RELEASE_MANIFEST_SCHEMA_VERSION,
    owner: OWNER,
    repo: REPO,
    channel: CHANNEL,
    version: VERSION,
    assets: [createSignedAsset()],
    ...unsignedOverrides,
  };
  return {
    ...unsigned,
    signature: suppliedSignature ?? sign(
      null,
      release.releaseManifestSigningPayload(unsigned),
      signingKey,
    ).toString("base64url"),
  };
}

function encodeManifest(manifest) {
  return release.canonicalizeReleaseJson(manifest);
}

function redirect(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

test("accepts a canonical manifest only when both manifest and asset signatures verify", () => {
  const manifest = createSignedManifest();
  const encoded = encodeManifest(manifest);
  const verified = release.parseAndVerifyReleaseManifest(Buffer.from(encoded, "utf8"), trust);

  assert.equal(verified.version, VERSION);
  assert.equal(verified.assets[0].url, RELEASE_URL);
  assert.equal(release.selectReleaseAsset(verified, "darwin", "arm64"), verified.assets[0]);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.assets), true);
  assert.equal(Object.isFrozen(verified.assets[0]), true);

  assert.throws(
    () => release.parseAndVerifyReleaseManifest(`${encoded}\n`, trust),
    hasCode("non_canonical_json"),
  );
});

test("rejects cryptographically wrong and permissively encoded signatures", () => {
  const otherKey = generateKeyPairSync("ed25519").privateKey;
  const wrongManifestSignature = createSignedManifest({}, otherKey);
  assert.throws(
    () => release.parseAndVerifyReleaseManifest(encodeManifest(wrongManifestSignature), trust),
    hasCode("invalid_signature"),
  );

  const wrongAsset = createSignedAsset({}, otherKey);
  const validOuterSignature = createSignedManifest({ assets: [wrongAsset] });
  assert.throws(
    () => release.parseAndVerifyReleaseManifest(encodeManifest(validOuterSignature), trust),
    hasCode("invalid_signature"),
  );

  const valid = createSignedManifest();
  for (const signature of [
    valid.signature.slice(0, -1),
    `${valid.signature}=`,
    `+${valid.signature.slice(1)}`,
    "_".repeat(86),
  ]) {
    assert.throws(
      () => release.parseAndVerifyReleaseManifest(
        encodeManifest({ ...valid, signature }),
        trust,
      ),
      hasCode("invalid_signature"),
      signature,
    );
  }
});

test("rejects signed manifests for the wrong owner, repository, or channel", () => {
  for (const override of [
    { owner: "another-owner" },
    { repo: "another-repo" },
    { channel: "beta" },
  ]) {
    const manifest = createSignedManifest(override);
    assert.throws(
      () => release.parseAndVerifyReleaseManifest(encodeManifest(manifest), trust),
      hasCode("untrusted_release"),
    );
  }
});

test("rejects unknown schema fields, schema versions, and duplicate assets", () => {
  const valid = createSignedManifest();
  const unknownRoot = { ...valid, unexpected: true };
  assert.throws(
    () => release.parseAndVerifyReleaseManifest(encodeManifest(unknownRoot), trust),
    hasCode("invalid_schema"),
  );

  const unknownAsset = { ...createSignedAsset(), unexpected: true };
  assert.throws(
    () => release.parseAndVerifyReleaseManifest(
      encodeManifest(createSignedManifest({ assets: [unknownAsset] })),
      trust,
    ),
    hasCode("invalid_schema"),
  );

  assert.throws(
    () => release.parseAndVerifyReleaseManifest(
      encodeManifest(createSignedManifest({ schemaVersion: 2 })),
      trust,
    ),
    hasCode("invalid_schema"),
  );

  const duplicate = createSignedAsset({
    url: `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/duplicate.tgz`,
  });
  assert.throws(
    () => release.parseAndVerifyReleaseManifest(
      encodeManifest(createSignedManifest({ assets: [createSignedAsset(), duplicate] })),
      trust,
    ),
    hasCode("invalid_schema"),
  );
});

test("detects literal and escaped duplicate JSON keys before parsing", () => {
  const canonical = encodeManifest(createSignedManifest());
  const literalDuplicate = canonical.replace(
    '"channel":"stable"',
    '"channel":"stable","channel":"stable"',
  );
  const escapedDuplicate = canonical.replace(
    '"channel":"stable"',
    '"channel":"stable","chan\\u006eel":"stable"',
  );

  assert.throws(
    () => release.parseAndVerifyReleaseManifest(literalDuplicate, trust),
    hasCode("duplicate_key"),
  );
  assert.throws(
    () => release.parseAndVerifyReleaseManifest(escapedDuplicate, trust),
    hasCode("duplicate_key"),
  );
});

test("rejects control characters and manifest or asset limit violations", () => {
  const canonical = encodeManifest(createSignedManifest());
  const escapedControl = canonical.replace(
    `"owner":"${OWNER}"`,
    `"owner":"${OWNER}\\u0001"`,
  );
  assert.throws(
    () => release.parseAndVerifyReleaseManifest(escapedControl, trust),
    hasCode("invalid_schema"),
  );

  assert.throws(
    () => release.parseAndVerifyReleaseManifest(
      Buffer.alloc(release.MAX_RELEASE_MANIFEST_BYTES + 1, 0x20),
      trust,
    ),
    hasCode("manifest_too_large"),
  );
  assert.throws(
    () => release.parseAndVerifyReleaseManifest(
      encodeManifest(createSignedManifest({ assets: [createSignedAsset({ size: release.MAX_RELEASE_ASSET_BYTES + 1 })] })),
      trust,
    ),
    hasCode("invalid_schema"),
  );
  assert.throws(
    () => release.parseAndVerifyReleaseManifest(
      encodeManifest(createSignedManifest({ assets: Array.from({ length: 33 }, () => createSignedAsset()) })),
      trust,
    ),
    hasCode("invalid_schema"),
  );
});

test("allows only pinned HTTPS GitHub repository URLs", () => {
  for (const url of [
    RELEASE_URL,
    LATEST_MANIFEST_URL,
    `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`,
    `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/123`,
    `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/release-manifest.json`,
  ]) {
    assert.equal(release.assertPinnedGithubUrl(url, trust).toString(), url);
  }

  for (const url of [
    RELEASE_URL.replace("https:", "http:"),
    RELEASE_URL.replace("https://", "https://user:secret@"),
    RELEASE_URL.replace("github.com", "github.com.evil.example"),
    RELEASE_URL.replace(`/${OWNER}/`, "/another-owner/"),
    RELEASE_URL.replace(`/${REPO}/`, "/another-repo/"),
    `${RELEASE_URL}?token=secret`,
    `${RELEASE_URL}#fragment`,
  ]) {
    assert.throws(() => release.assertPinnedGithubUrl(url, trust), hasCode("invalid_url"), url);
  }
});

test("accepts the pinned latest manifest redirect chain without weakening immutable asset URLs", async () => {
  const taggedManifestUrl = `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/release-manifest.json`;
  const cdnUrl = "https://release-assets.githubusercontent.com/github-production-release-asset/release-manifest.json?sp=read";
  const requests = [];
  const response = await release.fetchPinnedGithubResource(LATEST_MANIFEST_URL, trust, {
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (requests.length === 1) return redirect(taggedManifestUrl);
      if (requests.length === 2) return redirect(cdnUrl);
      return new Response("ok");
    },
  });

  assert.equal(await response.text(), "ok");
  assert.deepEqual(requests, [LATEST_MANIFEST_URL, taggedManifestUrl, cdnUrl]);

  const mutableAsset = createSignedAsset({
    url: `https://github.com/${OWNER}/${REPO}/releases/latest/download/pihub-server.tgz`,
  });
  assert.throws(
    () => release.parseAndVerifyReleaseManifest(
      encodeManifest(createSignedManifest({ assets: [mutableAsset] })),
      trust,
    ),
    hasCode("untrusted_release"),
  );
});

test("rejects GitHub tokens by default before making a request", async () => {
  let calls = 0;
  await assert.rejects(
    () => release.fetchPinnedGithubResource(
      `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`,
      trust,
      {
        token: "secret-token",
        fetchImpl: async () => {
          calls += 1;
          return new Response("unexpected");
        },
      },
    ),
    hasCode("token_rejected"),
  );
  assert.equal(calls, 0);
});

test("blocks excessive and malicious redirects", async () => {
  let redirectCalls = 0;
  await assert.rejects(
    () => release.fetchPinnedGithubResource(RELEASE_URL, trust, {
      maxRedirects: 1,
      fetchImpl: async () => {
        redirectCalls += 1;
        return redirect(RELEASE_URL);
      },
    }),
    hasCode("redirect_blocked"),
  );
  assert.equal(redirectCalls, 2);

  let maliciousCalls = 0;
  await assert.rejects(
    () => release.fetchPinnedGithubResource(RELEASE_URL, trust, {
      fetchImpl: async () => {
        maliciousCalls += 1;
        return redirect("https://evil.example/payload.tgz");
      },
    }),
    hasCode("redirect_blocked"),
  );
  assert.equal(maliciousCalls, 1);
});

test("permanently strips Authorization after a cross-origin redirect", async () => {
  const requests = [];
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/123`;
  const cdnUrl = "https://release-assets.githubusercontent.com/github-production-release-asset/file.tgz?sp=read";

  const response = await release.fetchPinnedGithubResource(apiUrl, trust, {
    token: "secret-token",
    allowToken: true,
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init.headers).get("authorization"),
      });
      return requests.length === 1 ? redirect(cdnUrl) : new Response("ok");
    },
  });

  assert.equal(await response.text(), "ok");
  assert.deepEqual(requests, [
    { url: apiUrl, authorization: "Bearer secret-token" },
    { url: cdnUrl, authorization: null },
  ]);
});

test("enforces declared and streamed response body limits", async () => {
  await assert.rejects(
    () => release.fetchPinnedGithubResource(RELEASE_URL, trust, {
      maxBodyBytes: 4,
      fetchImpl: async () => new Response("12345", {
        headers: { "Content-Length": "5" },
      }),
    }),
    hasCode("response_too_large"),
  );

  const response = await release.fetchPinnedGithubResource(RELEASE_URL, trust, {
    maxBodyBytes: 4,
    fetchImpl: async () => new Response("12345"),
  });
  await assert.rejects(() => response.text(), hasCode("response_too_large"));
});

test("enforces one total request timeout", async () => {
  const keepAlive = setInterval(() => undefined, 100);
  try {
    await assert.rejects(
      () => release.fetchPinnedGithubResource(RELEASE_URL, trust, {
        timeoutMs: 10,
        fetchImpl: async () => new Promise(() => undefined),
      }),
      hasCode("timeout"),
    );
  } finally {
    clearInterval(keepAlive);
  }
});
