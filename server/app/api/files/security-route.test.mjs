import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./[...path]/route.ts");
const { allowFileRoot, revokeFileRoot } = await jiti.import("../../../lib/file-access.ts");
const fileRouteSecurity = await jiti.import("../../../lib/file-route-security.ts");
const sessionOwnership = await jiti.import("../../../lib/session-ownership.ts");
const sessionReader = await jiti.import("../../../lib/session-reader.ts");

const deviceId = `dev_${"A".repeat(22)}`;
const otherDeviceId = `dev_${"B".repeat(22)}`;
const scope = { ownerId: deviceId };

function trustedHeaders(capability = "files:read", authenticatedDeviceId = deviceId) {
  return {
    host: "localhost",
    "x-pihub-authenticated-device": authenticatedDeviceId,
    "x-pihub-authenticated-capabilities": capability,
  };
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "");
    const flags = entry.flags ?? 0x800;
    const method = entry.method ?? 0;
    const compressedSize = data.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function multipartBody(boundary, files, { close = true } = {}) {
  const chunks = [];
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="files"; filename="${file.name}"\r\n`
      + "Content-Type: application/octet-stream\r\n\r\n",
    ));
    chunks.push(Buffer.from(file.bytes));
    chunks.push(Buffer.from("\r\n"));
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function uploadRequest(directory, body, boundary, expectedDigest = sha256(body), conflict = "error") {
  return route.POST(new NextRequest(
    `http://localhost/api/files/upload?type=upload&conflict=${conflict}`,
    {
      method: "POST",
      headers: {
        ...trustedHeaders("files:write"),
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "x-pihub-authenticated-content-sha256": expectedDigest,
      },
      body,
    },
  ), {
    params: Promise.resolve({ path: directory.split(path.sep).filter(Boolean) }),
  });
}

function uploadTemporaryFiles(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith(".upload"));
}

test("file route exports only supported Next handlers", () => {
  assert.deepEqual(Object.keys(route).sort(), ["GET", "POST"]);
});

test("file response policy makes SVG private, sandboxed, nosniff, and attachment-only", () => {
  const headers = fileRouteSecurity.getFileResponseHeaders("/tmp/active.svg", "image/svg+xml");
  assert.match(headers["Cache-Control"], /private/);
  assert.match(headers["Cache-Control"], /no-store/);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.match(headers["Content-Disposition"], /^attachment;/);
  assert.match(headers["Content-Security-Policy"], /sandbox/);
  assert.match(headers["Content-Security-Policy"], /default-src 'none'/);
});

test("session file capabilities exclude listing/watching and cap every response", () => {
  assert.equal(fileRouteSecurity.isSessionReferenceRequestType("read"), true);
  assert.equal(fileRouteSecurity.isSessionReferenceRequestType("download"), true);
  assert.equal(fileRouteSecurity.isSessionReferenceRequestType("list"), false);
  assert.equal(fileRouteSecurity.isSessionReferenceRequestType("watch"), false);
  assert.equal(fileRouteSecurity.isSessionReferencedResponseSizeAllowed(100 * 1024 * 1024), true);
  assert.equal(fileRouteSecurity.isSessionReferencedResponseSizeAllowed(100 * 1024 * 1024 + 1), false);
  assert.equal(fileRouteSecurity.canUseSessionFileReference("read", ["files:read"]), false);
  assert.equal(fileRouteSecurity.canUseSessionFileReference("read", ["files:read", "sessions:read"]), true);
  assert.equal(fileRouteSecurity.canUseSessionFileReference("watch", ["files:read", "sessions:read"]), false);
});

test("an external session file capability is bound to the authenticated session owner", async (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pihub-session-file-owner-"));
  const target = path.join(root, "outside-report.txt");
  const sessionPath = path.join(root, "session.jsonl");
  const ownershipPath = path.join(root, "private", "session-ownership.json");
  const sessionId = "550e8400-e29b-41d4-a716-446655440010";
  const timestamp = "2026-01-01T00:00:00.000Z";
  fs.writeFileSync(target, "owner-only contents");
  fs.writeFileSync(sessionPath, [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: root },
    {
      type: "message",
      id: "call-entry",
      parentId: null,
      timestamp,
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          toolCallId: "write-call",
          toolName: "write",
          input: { path: target },
        }],
      },
    },
    {
      type: "message",
      id: "result-entry",
      parentId: "call-entry",
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: "write-call",
        toolName: "write",
        content: [],
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await sessionOwnership.bindSessionOwner(sessionId, otherDeviceId, { statePath: ownershipPath });
  sessionReader.cacheSessionPath(sessionId, sessionPath);
  const previousOwnershipPath = process.env.PIHUB_SESSION_OWNERSHIP_PATH;
  process.env.PIHUB_SESSION_OWNERSHIP_PATH = ownershipPath;
  t.after(() => {
    sessionReader.invalidateSessionPathCache(sessionId);
    if (previousOwnershipPath === undefined) delete process.env.PIHUB_SESSION_OWNERSHIP_PATH;
    else process.env.PIHUB_SESSION_OWNERSHIP_PATH = previousOwnershipPath;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const routeParams = { params: Promise.resolve({ path: target.split(path.sep).filter(Boolean) }) };
  const ownedResponse = await route.GET(new NextRequest(
    `http://localhost/api/files/outside-report.txt?type=read&sessionId=${sessionId}`,
    { headers: trustedHeaders("files:read,sessions:read", otherDeviceId) },
  ), routeParams);
  assert.equal(ownedResponse.status, 200);
  assert.equal((await ownedResponse.json()).content, "owner-only contents");

  const crossOwnerResponse = await route.GET(new NextRequest(
    `http://localhost/api/files/outside-report.txt?type=read&sessionId=${sessionId}`,
    { headers: trustedHeaders("files:read,sessions:read", deviceId) },
  ), routeParams);
  assert.equal(crossOwnerResponse.status, 403);
  assert.match(crossOwnerResponse.headers.get("cache-control"), /private/);
  assert.match(crossOwnerResponse.headers.get("cache-control"), /no-store/);
});

test("the GET route applies the active-content policy to a real SVG response", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-file-route-"));
  const svg = path.join(root, "active.svg");
  fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  allowFileRoot(root, scope);
  t.after(() => {
    revokeFileRoot(root, scope);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const request = new NextRequest("http://localhost/api/files/active.svg?type=read", {
    headers: trustedHeaders(),
  });
  const response = await route.GET(request, {
    params: Promise.resolve({ path: svg.split(path.sep).filter(Boolean) }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
  assert.match(await response.text(), /<script>/);
});

test("unauthenticated file errors are private and non-cacheable", async () => {
  const response = await route.GET(
    new NextRequest("http://localhost/api/files/tmp/missing?type=read", { headers: { host: "localhost" } }),
    { params: Promise.resolve({ path: ["tmp", "missing"] }) },
  );
  assert.equal(response.status, 401);
  assert.match(response.headers.get("cache-control"), /private/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("bounded fd reads reject a path whose inode changed after authorization", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-file-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "report.txt");
  const previous = path.join(root, "previous.txt");
  fs.writeFileSync(target, "old");
  const expected = fs.statSync(target);
  fs.renameSync(target, previous);
  fs.writeFileSync(target, "new");

  assert.throws(
    () => fileRouteSecurity.readVerifiedFile(target, expected, 1024),
    /changed before it could be read/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "new");
});

test("bounded fd reads never follow a late symbolic-link replacement", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-file-link-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "report.txt");
  const previous = path.join(root, "previous.txt");
  fs.writeFileSync(target, "old");
  const expected = fs.statSync(target);
  fs.renameSync(target, previous);
  try {
    fs.symlinkSync("previous.txt", target);
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.throws(() => fileRouteSecurity.readVerifiedFile(target, expected, 1024));
});

test("download streams pull bounded chunks and reject growth after the authorized snapshot", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-file-stream-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "report.bin");
  fs.writeFileSync(target, Buffer.alloc(128 * 1024 + 7, 0x61));
  const expected = fs.statSync(target);
  const reader = fileRouteSecurity.createVerifiedFileBodyStream(target, expected).getReader();

  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(first.value.byteLength, 64 * 1024);
  fs.appendFileSync(target, "late growth");
  await assert.rejects(reader.read(), /changed before it could be streamed/);
});

test("DOCX central-directory validation rejects bounded metadata bombs before decompression", async () => {
  const valid = makeZip([
    { name: "[Content_Types].xml", data: "types" },
    { name: "_rels/.rels", data: "relationships" },
    { name: "word/document.xml", data: "document" },
  ]);
  assert.deepEqual(fileRouteSecurity.validateDocxPreviewArchive(valid), { ok: true });

  const excessiveRatio = makeZip([{
    name: "word/document.xml",
    data: Buffer.alloc(1),
    method: 8,
    uncompressedSize: 201,
  }]);
  assert.deepEqual(
    fileRouteSecurity.validateDocxPreviewArchive(excessiveRatio),
    { ok: false, reason: "resource_limit" },
  );

  const underreportedExpansion = makeZip([{
    name: "word/document.xml",
    data: deflateRawSync(Buffer.alloc(64 * 1024)),
    method: 8,
    uncompressedSize: 128,
  }]);
  assert.deepEqual(
    fileRouteSecurity.validateDocxPreviewArchive(underreportedExpansion),
    { ok: false, reason: "resource_limit" },
  );

  const excessiveTotal = makeZip([0, 1, 2].map((index) => ({
    name: `word/part-${index}.xml`,
    data: Buffer.alloc(64 * 1024),
    method: 8,
    uncompressedSize: 12 * 1024 * 1024,
  })));
  assert.deepEqual(
    fileRouteSecurity.validateDocxPreviewArchive(excessiveTotal),
    { ok: false, reason: "resource_limit" },
  );

  const tooManyEntries = makeZip(Array.from({ length: 1_025 }, (_, index) => ({
    name: `word/empty-${index}.xml`,
  })));
  assert.deepEqual(
    fileRouteSecurity.validateDocxPreviewArchive(tooManyEntries),
    { ok: false, reason: "resource_limit" },
  );

  const unsafePath = makeZip([{ name: "../outside.xml", data: "x" }]);
  const encrypted = makeZip([{ name: "word/document.xml", data: "x", flags: 0x801 }]);
  assert.deepEqual(fileRouteSecurity.validateDocxPreviewArchive(unsafePath), { ok: false, reason: "invalid" });
  assert.deepEqual(fileRouteSecurity.validateDocxPreviewArchive(encrypted), { ok: false, reason: "invalid" });
});

test("the DOCX preview route returns 413 for advertised expansion before invoking Mammoth", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-docx-limit-"));
  const target = path.join(root, "bomb.docx");
  fs.writeFileSync(target, makeZip([{
    name: "word/document.xml",
    data: Buffer.alloc(96 * 1024),
    method: 8,
    uncompressedSize: 16 * 1024 * 1024 + 1,
  }]));
  allowFileRoot(root, scope);
  t.after(() => {
    revokeFileRoot(root, scope);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const response = await route.GET(new NextRequest(
    "http://localhost/api/files/bomb.docx?type=preview",
    { headers: trustedHeaders() },
  ), { params: Promise.resolve({ path: target.split(path.sep).filter(Boolean) }) });
  assert.equal(response.status, 413);
  assert.match(response.headers.get("cache-control"), /private/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await response.json(), { error: "DOCX exceeds safe preview limits" });
});

test("directory listings stop after the hard entry ceiling", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-directory-limit-"));
  allowFileRoot(root, scope);
  t.after(() => {
    revokeFileRoot(root, scope);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let index = 0; index <= 10_000; index += 1) {
    fs.closeSync(fs.openSync(path.join(root, `entry-${index}`), "w"));
  }

  const response = await route.GET(new NextRequest(
    "http://localhost/api/files/root?type=list",
    { headers: trustedHeaders() },
  ), { params: Promise.resolve({ path: root.split(path.sep).filter(Boolean) }) });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Directory contains more than 10000 entries" });
});

test("file watcher slots enforce per-device and global ceilings and release once", () => {
  fileRouteSecurity.resetFileWatcherRuntimeForTests();
  const perDeviceReleases = Array.from({ length: 16 }, () => fileRouteSecurity.tryAcquireFileWatcher(deviceId));
  assert.ok(perDeviceReleases.every(Boolean));
  assert.equal(fileRouteSecurity.tryAcquireFileWatcher(deviceId), null);
  perDeviceReleases[0]();
  perDeviceReleases[0]();
  const replacement = fileRouteSecurity.tryAcquireFileWatcher(deviceId);
  assert.equal(typeof replacement, "function");
  for (const release of perDeviceReleases.slice(1)) release();
  replacement();

  fileRouteSecurity.resetFileWatcherRuntimeForTests();
  const globalReleases = [];
  for (let device = 0; device < 8; device += 1) {
    for (let slot = 0; slot < 16; slot += 1) {
      globalReleases.push(fileRouteSecurity.tryAcquireFileWatcher(`device-${device}`));
    }
  }
  assert.ok(globalReleases.every(Boolean));
  assert.equal(fileRouteSecurity.tryAcquireFileWatcher("one-more-device"), null);
  for (const release of globalReleases) release();
  fileRouteSecurity.resetFileWatcherRuntimeForTests();
});

test("authenticated multipart upload publishes only after raw digest verification", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-route-upload-"));
  const authorizedRoot = allowFileRoot(root, scope);
  t.after(() => {
    revokeFileRoot(root, scope);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const boundary = "route-success-boundary";
  const body = multipartBody(boundary, [
    { name: "alpha.bin", bytes: Buffer.from([0, 255, 1]) },
    { name: "notes.txt", bytes: Buffer.from("hello") },
  ]);

  const response = await uploadRequest(authorizedRoot, body, boundary);
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(fs.readFileSync(path.join(root, "alpha.bin")), Buffer.from([0, 255, 1]));
  assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf8"), "hello");
  assert.deepEqual(uploadTemporaryFiles(root), []);
});

test("digest mismatch, malformed input, and missing trusted digest leave destinations untouched", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-route-upload-fail-"));
  const authorizedRoot = allowFileRoot(root, scope);
  fs.writeFileSync(path.join(root, "keep.txt"), "original");
  t.after(() => {
    revokeFileRoot(root, scope);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const boundary = "route-failure-boundary";
  const overwrite = multipartBody(boundary, [{ name: "keep.txt", bytes: Buffer.from("replacement") }]);
  const mismatch = await uploadRequest(authorizedRoot, overwrite, boundary, "0".repeat(64), "overwrite");
  assert.equal(mismatch.status, 401);
  assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "original");
  assert.deepEqual(uploadTemporaryFiles(root), []);

  const replaced = await uploadRequest(authorizedRoot, overwrite, boundary, sha256(overwrite), "overwrite");
  assert.equal(replaced.status, 200, await replaced.text());
  assert.equal(fs.readFileSync(path.join(root, "keep.txt"), "utf8"), "replacement");
  assert.deepEqual(uploadTemporaryFiles(root), []);

  const malformed = multipartBody(
    boundary,
    [{ name: "partial.txt", bytes: Buffer.from("partial") }],
    { close: false },
  );
  const malformedResponse = await uploadRequest(authorizedRoot, malformed, boundary);
  assert.equal(malformedResponse.status, 400);
  assert.equal(fs.existsSync(path.join(root, "partial.txt")), false);
  assert.deepEqual(uploadTemporaryFiles(root), []);

  const missingDigest = await route.POST(new NextRequest(
    "http://localhost/api/files/upload?type=upload&conflict=error",
    {
      method: "POST",
      headers: {
        ...trustedHeaders("files:write"),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: overwrite,
    },
  ), { params: Promise.resolve({ path: authorizedRoot.split(path.sep).filter(Boolean) }) });
  assert.equal(missingDigest.status, 401);
  assert.deepEqual(uploadTemporaryFiles(root), []);
});

test("error conflict policy publishes none of a validated batch", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-route-upload-conflict-"));
  const authorizedRoot = allowFileRoot(root, scope);
  fs.writeFileSync(path.join(root, "exists.txt"), "old");
  t.after(() => {
    revokeFileRoot(root, scope);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const boundary = "route-conflict-boundary";
  const body = multipartBody(boundary, [
    { name: "new.txt", bytes: Buffer.from("new") },
    { name: "exists.txt", bytes: Buffer.from("replace") },
  ]);
  const response = await uploadRequest(authorizedRoot, body, boundary, sha256(body), "error");
  assert.equal(response.status, 409);
  assert.equal(fs.existsSync(path.join(root, "new.txt")), false);
  assert.equal(fs.readFileSync(path.join(root, "exists.txt"), "utf8"), "old");
  assert.deepEqual(uploadTemporaryFiles(root), []);
});

test("overwrite uploads reject existing case and Unicode portable aliases", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-route-upload-portable-"));
  const authorizedRoot = allowFileRoot(root, scope);
  fs.writeFileSync(path.join(root, "alpha.txt"), "case-original");
  fs.writeFileSync(path.join(root, "\u00e9.txt"), "unicode-original");
  t.after(() => {
    revokeFileRoot(root, scope);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const unicodeActual = fs.readdirSync(root).find((name) => name !== "alpha.txt");
  const unicodeAlias = unicodeActual === "\u00e9.txt" ? "e\u0301.txt" : "\u00e9.txt";
  const boundary = "route-portable-boundary";
  const body = multipartBody(boundary, [
    { name: "ALPHA.TXT", bytes: Buffer.from("case-replacement") },
    { name: unicodeAlias, bytes: Buffer.from("unicode-replacement") },
  ]);

  const response = await uploadRequest(authorizedRoot, body, boundary, sha256(body), "overwrite");
  const result = await response.json();
  assert.equal(response.status, 207, JSON.stringify(result));
  assert.match(response.headers.get("cache-control"), /private/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(result.uploaded, []);
  assert.deepEqual(result.errors.map((entry) => entry.name), ["ALPHA.TXT", unicodeAlias]);
  assert.equal(fs.readFileSync(path.join(root, "alpha.txt"), "utf8"), "case-original");
  assert.equal(fs.readFileSync(path.join(root, unicodeActual), "utf8"), "unicode-original");
  assert.equal(fs.readdirSync(root).includes("ALPHA.TXT"), false);
  assert.deepEqual(uploadTemporaryFiles(root), []);
});
