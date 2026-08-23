import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const ciPath = path.join(root, ".github", "workflows", "ci.yml");
const releasePath = path.join(root, ".github", "workflows", "server-release.yml");
const securityPath = path.join(root, ".github", "workflows", "security.yml");

function jobBlock(source, name) {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow job: ${name}`);
  const rest = source.slice(start + marker.length);
  const next = rest.search(/^ {2}[a-z][a-z0-9-]+:\s*$/m);
  return source.slice(start, next === -1 ? source.length : start + marker.length + next);
}

function stepNameAt(source, offset) {
  const prefix = source.slice(0, offset);
  const matches = [...prefix.matchAll(/^ {6}- name: (.+)$/gm)];
  assert.ok(matches.length > 0, "secret reference must belong to a named step");
  return matches.at(-1)[1];
}

function assertOrdered(source, commands, description) {
  let previous = -1;
  for (const command of commands) {
    const offset = source.indexOf(command);
    assert.ok(offset > previous, `${description}: ${command}`);
    previous = offset;
  }
}

test("release workflow binds every privileged job to one immutable tag commit", () => {
  const workflow = fs.readFileSync(releasePath, "utf8");

  assert.match(workflow, /workflow_dispatch:\n {4}inputs:\n {6}release_ref:/);
  assert.match(workflow, /\^refs\/tags\/v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(workflow, /if \[\[ "\$\{GITHUB_EVENT_NAME\}" == "push" && "\$\{GITHUB_REF\}" != "\$\{release_ref\}" \]\]/);
  assert.match(workflow, /git show-ref --verify --quiet "\$\{release_ref\}"/);
  assert.match(jobBlock(workflow, "validate"), /GITHUB_REPOSITORY_VISIBILITY.*public/s);
  assert.match(workflow, /tag_object="\$\(git rev-parse --verify "\$\{release_ref\}"\)"/);
  assert.match(workflow, /commit="\$\(git rev-parse --verify "\$\{release_ref\}\^\{commit\}"\)"/);
  assert.doesNotMatch(workflow, /inputs\.tag\b/);
  assert.doesNotMatch(workflow, /ref: \$\{\{ needs\.validate\.outputs\.tag \}\}/);

  const releaseJobs = [
    "build-server-release",
    "sign-release",
    "publish-draft",
  ];
  for (const name of releaseJobs) {
    const job = jobBlock(workflow, name);
    assert.match(job, /repos\/\$\{GITHUB_REPOSITORY\}\/git\/ref\/tags\/\$\{tag\}/, `${name} must query the exact remote tag ref`);
    assert.match(job, /PIHUB_RELEASE_TAG_OBJECT/, `${name} must compare the original tag object`);
    assert.match(job, /PIHUB_RELEASE_COMMIT/, `${name} must compare the peeled commit`);
    assert.match(job, /compare\/\$\{PIHUB_RELEASE_COMMIT|compare\/\$\{commit/, `${name} must recheck main ancestry`);
  }
  for (const name of ["build-server-release", "sign-release"]) {
    assert.match(jobBlock(workflow, name), /ref: \$\{\{ needs\.validate\.outputs\.commit \}\}/, `${name} must checkout the fixed commit`);
  }
  assert.doesNotMatch(jobBlock(workflow, "publish-draft"), /actions\/checkout/);

  const publish = jobBlock(workflow, "publish-draft");
  assert.match(publish, /releases\?per_page=100/);
  assert.match(publish, /--paginate --slurp/);
  assert.match(publish, /uploads\.github\.com\/repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{release_id\}\/assets/);
  assert.doesNotMatch(publish, /gh release (?:create|download|upload)/);
});

test("release secrets and token powers stay in protected least-privilege jobs", () => {
  const workflow = fs.readFileSync(releasePath, "utf8");
  const sign = jobBlock(workflow, "sign-release");
  const publish = jobBlock(workflow, "publish-draft");
  const build = jobBlock(workflow, "build-server-release");
  const validate = jobBlock(workflow, "validate");

  assert.match(sign, /^ {4}environment: pihub-release-signing$/m);
  assert.match(publish, /^ {4}environment: pihub-release-publishing$/m);
  assert.doesNotMatch(validate, /environment:/);
  assert.doesNotMatch(build, /environment:/);

  assert.doesNotMatch(sign, /^ {6}(?:contents|id-token|attestations): write$/m);
  assert.match(publish, /^ {6}contents: write$/m);
  assert.doesNotMatch(publish, /^ {6}(?:id-token|attestations): write$/m);

  for (const match of workflow.matchAll(/^([ ]*)[^\n]*\$\{\{ secrets\.[^\n]+$/gm)) {
    assert.equal(match[1].length, 10, "signing secrets must be injected through step-level env only");
    assert.equal(stepNameAt(workflow, match.index), "Sign Server manifest", "secret used by unexpected step");
  }
});

test("release workflow ships standalone Server archives with a signed manifest", () => {
  const ci = fs.readFileSync(ciPath, "utf8");
  const release = fs.readFileSync(releasePath, "utf8");
  const retiredEmbeddedPatterns = [
    /server:pack/,
    /bundle:prepare/,
    /--require-resource/,
    /src-tauri\/resources\/pihub-server-/,
    /prepare-server-resource\.mjs/,
  ];
  for (const source of [ci, release]) {
    for (const pattern of retiredEmbeddedPatterns) assert.doesNotMatch(source, pattern);
  }
  // The native smoke runs in the release build job; CI stays on ubuntu only.
  assert.match(release, /smoke-server-resource\.mjs[\s\S]*--archive/);
  assert.match(ci, /node scripts\/verify-icon-assets\.mjs/);

  // The desktop release chain was removed: server assets only.
  assert.doesNotMatch(release, /build-desktop-release|assemble-release|attest-release/);
  assert.doesNotMatch(release, /tauri signer sign|finalize-desktop-release/);

  const sign = jobBlock(release, "sign-release");
  assert.match(sign, /node scripts\/sign-server-release\.mjs server-artifacts/);
});

test("every native Server job verifies and ships the locked default extension bundle", () => {
  const ci = fs.readFileSync(ciPath, "utf8");
  const release = fs.readFileSync(releasePath, "utf8");
  const ciProduct = jobBlock(ci, "product-quality");
  const releaseValidation = jobBlock(release, "validate");
  const releaseServer = jobBlock(release, "build-server-release");

  for (const preflight of [ciProduct, releaseValidation, releaseServer]) {
    assert.match(preflight, /extensions\/package-lock\.json/);
    assert.match(preflight, /node scripts\/default-extension-bundle\.mjs/);
  }
  assertOrdered(releaseServer, [
    "node scripts/default-extension-bundle.mjs",
    "npm run server:build",
    "node scripts/build-server-release.mjs",
    "node scripts/verify-server-release.mjs --directory release-artifacts",
    "node scripts/smoke-server-resource.mjs",
  ], "native Server release gates are out of order");
  for (const identity of [
    "runner: macos-15\n            platform: darwin\n            arch: arm64",
    "runner: macos-15-intel\n            platform: darwin\n            arch: x64",
    "runner: ubuntu-24.04-arm\n            platform: linux\n            arch: arm64",
    "runner: ubuntu-24.04\n            platform: linux\n            arch: x64",
    "runner: windows-11-arm\n            platform: win32\n            arch: arm64",
    "runner: windows-2025\n            platform: win32\n            arch: x64",
  ]) {
    assert.ok(releaseServer.includes(identity), `missing native Server matrix identity: ${identity}`);
  }
});

test("security workflow installs locked verifier dependencies and lints workflows", () => {
  const security = fs.readFileSync(securityPath, "utf8");
  const lockVerification = "node scripts/verify-server-lock.mjs";
  const extensionVerification = "node scripts/default-extension-bundle.mjs";
  const install = "npm ci --prefix server --ignore-scripts --no-audit --no-fund";
  const tests = "scripts/privacy-scan.test.mjs";
  assert.ok(
    security.indexOf(lockVerification) !== -1
      && security.indexOf(lockVerification) < security.indexOf(install),
  );
  assert.ok(
    security.indexOf(extensionVerification) > security.indexOf(lockVerification)
      && security.indexOf(extensionVerification) < security.indexOf(install),
  );
  assert.ok(security.indexOf(install) !== -1 && security.indexOf(install) < security.indexOf(tests));
  for (const testFile of [
    "default-extension-bundle.test.mjs",
    "server-release-sbom.test.mjs",
    "smoke-server-resource.test.mjs",
    "verify-server-lock.test.mjs",
    "verify-server-release.test.mjs",
  ]) {
    assert.ok(security.includes(`scripts/${testFile}`), `missing security test: ${testFile}`);
  }
  const dependencyAudit = jobBlock(security, "dependency-audit");
  assert.match(dependencyAudit, /project: extensions\n {12}directory: extensions/);
  assert.match(dependencyAudit, /npm audit --package-lock-only --omit=peer --audit-level=high/);
  assert.match(security, /readonly version="1\.7\.12"/);
  assert.match(security, /readonly expected="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"/);
  assert.match(security, /"\$\{RUNNER_TEMP\}\/actionlint" -color=false \.github\/workflows\/\*\.yml/);
});

test("security workflow gates GHAS features and covers every first-party language", () => {
  const security = fs.readFileSync(securityPath, "utf8");
  const dependencyReview = jobBlock(security, "dependency-review");
  const codeql = jobBlock(security, "codeql");
  const rustAudit = jobBlock(security, "rust-audit");
  const scheduledRustAudit = jobBlock(security, "rust-audit-scheduled");
  const required = jobBlock(security, "required");

  for (const job of [dependencyReview, codeql]) {
    assert.match(job, /github\.event\.repository\.visibility == 'public'/);
    assert.match(job, /vars\.GHAS_ENABLED == 'true'/);
  }
  for (const language of ["actions", "javascript-typescript", "rust"]) {
    assert.match(codeql, new RegExp(`^ {10}- ${language}$`, "m"));
  }
  assert.match(codeql, /build-mode: none/);
  assert.doesNotMatch(rustAudit, /^ {6}issues: write$/m);
  assert.match(scheduledRustAudit, /^ {6}issues: write$/m);
  assert.match(required, /^ {4}name: Security required$/m);
  assert.match(required, /CODEQL_RESULT/);
  assert.match(required, /RUST_AUDIT_SCHEDULED_RESULT/);
});
