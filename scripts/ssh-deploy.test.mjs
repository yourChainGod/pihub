import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildExtensionSelection,
  buildRemoteFetchCommand,
  buildUrlInstallCommand,
  compareVersions,
  decideAction,
  parseArchiveUrl,
  parseProbeOutput,
  parseSetupConstants,
  parseSidecar,
  platformFromUname,
  renderStandaloneBootstrap,
  renderUnixBootstrap,
  selectArchive,
} from "./ssh-deploy.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const setupSource = fs.readFileSync(path.join(REPO_ROOT, "src-tauri", "src", "setup.rs"), "utf8");
const standaloneTemplate = fs.readFileSync(path.join(REPO_ROOT, "src-tauri", "src", "standalone_bootstrap.mjs"), "utf8");
const unixTemplate = fs.readFileSync(path.join(REPO_ROOT, "src-tauri", "src", "bootstrap_unix.sh"), "utf8");

const { constants, extensionPackages } = parseSetupConstants(setupSource);

test("parseSetupConstants reads every constant the bootstrap render needs", () => {
  assert.match(constants.PIHUB_SERVER_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(constants.PIHUB_SERVER_RELEASE_CHANNEL, "stable");
  assert.match(constants.PIHUB_SERVER_RELEASE_PUBLIC_KEY, /^[A-Za-z0-9_-]{43}$/);
  assert.match(constants.PIHUB_NODE_VERSION, /^v22\./);
  for (const key of [
    "PIHUB_NODE_LINUX_X64_SHA256",
    "PIHUB_NODE_LINUX_ARM64_SHA256",
    "PIHUB_NODE_DARWIN_ARM64_SHA256",
    "PIHUB_NODE_DARWIN_X64_SHA256",
  ]) {
    assert.match(constants[key], /^[a-f0-9]{64}$/);
  }
  assert.equal(extensionPackages.length, 7);
  assert.ok(extensionPackages.some((pkg) => pkg.name === "@eko24ive/pi-ask"));
});

test("renderStandaloneBootstrap replaces every placeholder", () => {
  const rendered = renderStandaloneBootstrap(standaloneTemplate, constants, extensionPackages);
  assert.equal(/__[A-Z0-9_]+__/.test(rendered), false);
  assert.ok(rendered.includes(constants.PIHUB_SERVER_RELEASE_PUBLIC_KEY));
  assert.ok(rendered.includes(constants.PIHUB_PI_AGENT_VERSION));
});

test("renderUnixBootstrap replaces every placeholder and embeds the archive sha", () => {
  const standalone = renderStandaloneBootstrap(standaloneTemplate, constants, extensionPackages);
  const sha256 = "a".repeat(64);
  const rendered = renderUnixBootstrap(unixTemplate, standalone, {
    constants,
    extensionSelection: null,
    allowRoot: true,
    localArchiveSha256: sha256,
    autoPair: true,
  });
  assert.equal(/__[A-Z0-9_]+__/.test(rendered), false);
  assert.ok(rendered.includes(`PIHUB_LOCAL_ARCHIVE_SHA256="${sha256}"`));
  assert.ok(rendered.includes('export PIHUB_ALLOW_ROOT="1"'));
  assert.ok(rendered.includes('export PIHUB_AUTO_PAIR="1"'));
});

test("buildExtensionSelection validates against the signed package list", () => {
  const all = buildExtensionSelection(null, extensionPackages);
  assert.ok(all);
  assert.deepEqual(JSON.parse(Buffer.from(all, "base64url").toString("utf8")).length, 7);

  const subset = buildExtensionSelection(["pi-todo-rail"], extensionPackages);
  assert.deepEqual(JSON.parse(Buffer.from(subset, "base64url").toString("utf8")), [
    { name: "pi-todo-rail", version: extensionPackages.find((p) => p.name === "pi-todo-rail").version },
  ]);

  assert.throws(() => buildExtensionSelection(["pi-todo-rail", "pi-todo-rail"], extensionPackages), /重复/);
  assert.throws(() => buildExtensionSelection(["evil-package"], extensionPackages), /签名清单/);
  assert.equal(buildExtensionSelection([], extensionPackages), null);
});

test("compareVersions orders semantic versions", () => {
  assert.ok(compareVersions("0.0.4", "0.0.3") > 0);
  assert.ok(compareVersions("0.0.10", "0.0.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("0.0.4", "0.0.4"), 0);
  assert.ok(compareVersions("0.0.3", "0.0.4") < 0);
});

function makeArchive(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  fs.writeFileSync(`${file}.sha256`, `${sha256}  ${name}\n`);
  return { file, sha256 };
}

test("selectArchive picks the latest matching platform build and verifies sha256", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-ssh-deploy-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  makeArchive(dir, "pihub-server-0.0.2-linux-x64.tar.gz", "old-linux");
  makeArchive(dir, "pihub-server-0.0.4-linux-x64.tar.gz", "new-linux");
  makeArchive(dir, "pihub-server-0.0.9-darwin-arm64.tar.gz", "other-platform");
  fs.writeFileSync(path.join(dir, "pihub-server-9.9.9-linux-x64.tar.gz.sha256"), `${"b".repeat(64)}  missing.tar.gz\n`);

  const chosen = selectArchive(dir, "linux", "x64");
  assert.equal(chosen.version, "0.0.4");
  assert.equal(chosen.bytes.toString(), "new-linux");

  assert.throws(() => selectArchive(dir, "linux", "arm64"), /没有匹配/);
});

test("selectArchive rejects a tampered archive", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-ssh-deploy-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = "pihub-server-0.0.4-linux-x64.tar.gz";
  fs.writeFileSync(path.join(dir, name), "tampered");
  fs.writeFileSync(path.join(dir, `${name}.sha256`), `${"a".repeat(64)}  ${name}\n`);

  assert.throws(() => selectArchive(dir, "linux", "x64"), /校验和不一致/);
});

test("parseProbeOutput parses key=value lines and defaults", () => {
  const probe = parseProbeOutput([
    "PROBE_UNAME=Linux x86_64",
    "PROBE_UID=0",
    "PROBE_HOME=/root",
    "PROBE_NODE=v22.23.2",
    "PROBE_PIHUB_VERSION=0.0.4",
    "PROBE_PIHUB_VERSIONS=0.0.3 0.0.4 ",
    "PROBE_PIHUB_RUNNING=0.0.4",
    "PROBE_LEGACY=pihub-server.service",
    "PROBE_TAILSCALE=yes",
    "PROBE_SERVE=mounted",
    "PROBE_TMP_KB=4096",
  ].join("\n"));
  assert.equal(probe.uname, "Linux x86_64");
  assert.equal(probe.uid, "0");
  assert.equal(probe.node, "v22.23.2");
  assert.equal(probe.pihubVersion, "0.0.4");
  assert.deepEqual(probe.pihubVersions, ["0.0.3", "0.0.4"]);
  assert.deepEqual(probe.legacyConflicts, ["pihub-server.service"]);
  assert.equal(probe.tailscale, true);
  assert.equal(probe.serveMounted, true);

  assert.throws(() => parseProbeOutput("garbage"), /探测失败/);
});

test("platformFromUname maps uname to release asset suffixes", () => {
  assert.deepEqual(platformFromUname("Linux x86_64"), { platform: "linux", arch: "x64" });
  assert.deepEqual(platformFromUname("Linux aarch64"), { platform: "linux", arch: "arm64" });
  assert.deepEqual(platformFromUname("Darwin arm64"), { platform: "darwin", arch: "arm64" });
  assert.throws(() => platformFromUname("FreeBSD x86_64"), /不支持/);
});

test("decideAction distinguishes install, upgrade and blocked cases", () => {
  const fresh = { pihubVersion: null };
  assert.deepEqual(decideAction(fresh, "0.0.4"), { action: "install" });

  const older = { pihubVersion: "0.0.3" };
  assert.deepEqual(decideAction(older, "0.0.4"), { action: "upgrade", from: "0.0.3", to: "0.0.4" });

  const same = { pihubVersion: "0.0.4" };
  assert.equal(decideAction(same, "0.0.4").action, "blocked");
  assert.deepEqual(decideAction(same, "0.0.4", { force: true }), { action: "reinstall", from: "0.0.4", to: "0.0.4" });

  const newer = { pihubVersion: "0.0.5" };
  assert.equal(decideAction(newer, "0.0.4").action, "blocked");
});

test("parseArchiveUrl validates and splits the asset name", () => {
  const info = parseArchiveUrl("http://100.100.100.1:10086/pihub-server-0.0.5-linux-x64.tar.gz");
  assert.equal(info.version, "0.0.5");
  assert.equal(info.platform, "linux");
  assert.equal(info.arch, "x64");
  assert.equal(info.sidecarUrl, "http://100.100.100.1:10086/pihub-server-0.0.5-linux-x64.tar.gz.sha256");

  assert.throws(() => parseArchiveUrl("not-a-url"), /合法 URL/);
  assert.throws(() => parseArchiveUrl("ftp://host/pihub-server-0.0.5-linux-x64.tar.gz"), /http/);
  assert.throws(() => parseArchiveUrl("http://host/other.tar.gz"), /文件名不符合/);
});

test("parseSidecar enforces format and filename binding", () => {
  const sha = "a".repeat(64);
  assert.equal(parseSidecar(`${sha}  pihub-server-0.0.5-linux-x64.tar.gz\n`, "pihub-server-0.0.5-linux-x64.tar.gz"), sha);
  assert.throws(() => parseSidecar(`${sha}  other.tar.gz`, "pihub-server-0.0.5-linux-x64.tar.gz"), /无效或文件名/);
  assert.throws(() => parseSidecar("garbage", "pihub-server-0.0.5-linux-x64.tar.gz"), /无效或文件名/);
});

test("remote fetch and install commands carry url, sha256 and flags", () => {
  const sha = "b".repeat(64);
  const fetch = buildRemoteFetchCommand({
    url: "http://100.100.100.1:10086/pihub-server-0.0.5-linux-x64.tar.gz",
    sha256: sha,
    stageDir: "/root/.pihub-update",
  });
  assert.ok(fetch.includes("curl -fsSL"));
  assert.ok(fetch.includes(`${sha}  server.tgz`));
  assert.ok(fetch.includes("sha256sum -c"));

  const install = buildUrlInstallCommand({
    stageDir: "/root/.pihub-update",
    sha256: sha,
    allowRoot: true,
    autoPair: false,
    extensionSelection: "c2Vs",
  });
  assert.ok(install.includes(`PIHUB_LOCAL_ARCHIVE_SHA256='${sha}'`));
  assert.ok(install.includes("PIHUB_ALLOW_ROOT=1"));
  assert.ok(install.includes("PIHUB_AUTO_PAIR=0"));
  assert.ok(install.includes("--with-extensions=c2Vs"));
  assert.ok(install.includes("pi-node/node-*/bin"));
});
