import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import {
  formatReport,
  scanArchiveContent,
  scanPaths,
  scanRepository,
  scanTextContent,
} from "./privacy-scan.mjs";

const execFileAsync = promisify(execFile);
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptsDirectory);
const scannerPath = path.join(scriptsDirectory, "privacy-scan.mjs");
const fixturesPath = path.join(scriptsDirectory, "fixtures", "privacy-scan", "cases.json");
const fixtures = JSON.parse(await readFile(fixturesPath, "utf8"));

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "pihub-privacy-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function rules(findings) {
  return new Set(findings.map((finding) => finding.rule));
}

function tarOctal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function createTar(entries) {
  const chunks = [];
  for (const [name, value] of entries) {
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(tarOctal(0o644, 8), 100, 8, "ascii");
    header.write(tarOctal(0, 8), 108, 8, "ascii");
    header.write(tarOctal(0, 8), 116, 8, "ascii");
    header.write(tarOctal(content.length, 12), 124, 12, "ascii");
    header.write(tarOctal(0, 12), 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function createStoredZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;
  for (const [name, value] of entries) {
    const nameBuffer = Buffer.from(name);
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const localRecord = Buffer.concat([local, nameBuffer, content]);
    localChunks.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralChunks.push(Buffer.concat([central, nameBuffer]));
    localOffset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

test("fixtures cover each high-confidence privacy rule without retaining findings", () => {
  for (const fixture of fixtures.hits) {
    const value = fixture.parts.join("");
    const location = fixture.id === "github-token" ? `archive!${value}.txt` : `${fixture.id}.txt`;
    const findings = scanTextContent(value, { path: location });
    assert.ok(rules(findings).has(fixture.id), `missing ${fixture.id}`);
    assert.equal(JSON.stringify(findings).includes(value), false, `${fixture.id} leaked into findings`);
  }
});

test("documentation placeholders and environment references stay clean", () => {
  for (const value of fixtures.clean) {
    assert.deepEqual(scanTextContent(value, { path: "clean-fixture.txt" }), [], value);
  }
  assert.deepEqual(scanTextContent("package/.next/server/app/api/home/route.js", { path: "archive-member" }), []);
  assert.deepEqual(
    scanTextContent("headers.authorization = headerMap.authorizationHeader;", { path: "runtime.js" }),
    [],
  );
});

test("generic authorization scanning requires a high-entropy quoted literal", () => {
  const literal = ["Aq7v", "9Lm2", "Xz8p", "R4sN", "6TyK", "0WbC"].join("-");
  for (const source of [
    `authorization: "${literal}"`,
    `"authorization": "Bearer ${literal}"`,
    `const header = 'Bearer ${literal}'`,
  ]) {
    assert.ok(rules(scanTextContent(source, { path: "credential.js" })).has("generic-secret"), source);
  }
  assert.deepEqual(scanTextContent(`authorization: ${literal}`, { path: "expression.js" }), []);
});

test("the scanner source and split fixture file do not trigger their own rules", async () => {
  for (const filename of [scannerPath, fixturesPath]) {
    const content = await readFile(filename, "utf8");
    assert.deepEqual(scanTextContent(content, { path: path.basename(filename) }), []);
  }
});

test("filesystem mode skips generated and fixture directories but detects nested Git metadata", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await mkdir(path.join(root, "scripts", "fixtures", "privacy-scan"), { recursive: true });
  await mkdir(path.join(root, "server", ".git"), { recursive: true });
  await writeFile(path.join(root, "source.txt"), "clean source");
  await writeFile(path.join(root, "node_modules", "ignored.txt"), fixtures.hits[1].parts.join(""));
  await writeFile(path.join(root, "scripts", "fixtures", "privacy-scan", "ignored.txt"), fixtures.hits[1].parts.join(""));

  const result = await scanRepository({ root });
  assert.equal(result.source, "filesystem");
  assert.ok(rules(result.findings).has("nested-git"));
  assert.equal(rules(result.findings).has("github-token"), false);
  assert.equal(result.stats.files, 1);
});

test("Git mode scans only git ls-files and blocks tracked build output", async (t) => {
  const root = await temporaryDirectory(t);
  await execFileAsync("git", ["init", "-q", root]);
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "nested", ".git"), { recursive: true });
  await writeFile(path.join(root, "tracked.txt"), fixtures.hits[4].parts.join(""));
  await writeFile(path.join(root, "untracked.txt"), fixtures.hits[1].parts.join(""));
  await writeFile(path.join(root, "dist", "bundle.js"), "generated");
  await execFileAsync("git", ["-C", root, "add", "tracked.txt", "dist/bundle.js"]);
  await execFileAsync("git", [
    "-C",
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${"1".repeat(40)},vendor/legacy`,
  ]);

  const result = await scanRepository({ root });
  const foundRules = rules(result.findings);
  assert.equal(result.source, "git-ls-files");
  assert.ok(foundRules.has("tailnet-hostname"));
  assert.ok(foundRules.has("build-output"));
  assert.ok(foundRules.has("gitlink"));
  assert.ok(foundRules.has("nested-git"));
  assert.equal(foundRules.has("github-token"), false);
});

test("Git mode does not treat the scanner's tracked fixture as build output", async (t) => {
  const root = await temporaryDirectory(t);
  await execFileAsync("git", ["init", "-q", root]);
  await mkdir(path.join(root, "scripts", "fixtures", "privacy-scan"), { recursive: true });
  await writeFile(
    path.join(root, "scripts", "fixtures", "privacy-scan", "cases.json"),
    JSON.stringify({ fixture: ["output=/Users/", "private-builder", "/project/dist"].join("") }),
  );
  await execFileAsync("git", ["-C", root, "add", "scripts/fixtures/privacy-scan/cases.json"]);

  const result = await scanRepository({ root });
  assert.equal(result.source, "git-ls-files");
  assert.equal(rules(result.findings).has("build-output"), false);
});

test("tgz and nested zip members are scanned without extracting them", async () => {
  const nestedZip = createStoredZip([
    ["config.txt", fixtures.hits[3].parts.join("")],
    ["../unsafe.txt", "clean"],
  ]);
  const tgz = gzipSync(createTar([
    ["package/nested.zip", nestedZip],
    ["package/build.txt", fixtures.hits[6].parts.join("")],
  ]));
  const result = scanArchiveContent(tgz, { name: "release.tgz", path: "release.tgz" });
  const foundRules = rules(result.findings);
  assert.ok(foundRules.has("generic-secret"));
  assert.ok(foundRules.has("absolute-user-path"));
  assert.ok(foundRules.has("archive-unsafe-path"));
  assert.equal(result.stats.archives, 2);
});

test("archive member and aggregate limits fail closed", () => {
  const zip = createStoredZip([["large.txt", "0123456789"]]);
  const result = scanArchiveContent(zip, {
    name: "release.zip",
    path: "release.zip",
    limits: { maxArchiveMemberBytes: 4 },
  });
  assert.ok(rules(result.findings).has("archive-member-limit"));
});

test("large regular files warn while incomplete scans fail closed", async (t) => {
  const root = await temporaryDirectory(t);
  const filename = path.join(root, "large.txt");
  await writeFile(filename, "0123456789");
  const result = await scanPaths([filename], {
    root,
    limits: { largeFileBytes: 4, maxFileBytes: 6 },
  });
  assert.ok(result.findings.some((finding) => finding.rule === "large-file" && finding.severity === "warning"));
  assert.ok(result.findings.some((finding) => finding.rule === "content-scan-limit" && finding.severity === "error"));
});

test("CLI fails on a finding and never prints the matched value", async (t) => {
  const root = await temporaryDirectory(t);
  const value = fixtures.hits[1].parts.join("");
  const filename = path.join(root, "candidate.txt");
  await writeFile(filename, value);
  let failure;
  try {
    await execFileAsync(process.execPath, [scannerPath, "--root", root, filename], { cwd: repositoryRoot });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 1);
  assert.match(failure.stdout, /github-token/);
  assert.equal(`${failure.stdout}${failure.stderr}`.includes(value), false);
});

test("formatted JSON contains locations and classifications but no source values", () => {
  const value = fixtures.hits[4].parts.join("");
  const findings = scanTextContent(value, { path: "candidate.txt" });
  const report = formatReport({
    source: "fixture",
    findings,
    stats: { archiveEntries: 0, archives: 0, bytesScanned: value.length, files: 1, skipped: 0 },
  }, { json: true });
  assert.match(report, /tailnet-hostname/);
  assert.equal(report.includes(value), false);
});
