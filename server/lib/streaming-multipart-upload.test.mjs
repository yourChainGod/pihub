import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const upload = await jiti.import("./streaming-multipart-upload.ts");

function multipartBody(boundary, files, { close = true } = {}) {
  const chunks = [];
  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="${file.field ?? "files"}"; filename="${file.name}"\r\n`
      + "Content-Type: application/octet-stream\r\n\r\n",
      "utf8",
    ));
    chunks.push(Buffer.from(file.bytes));
    chunks.push(Buffer.from("\r\n"));
  }
  if (close) chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function digest(body) {
  return createHash("sha256").update(body).digest("hex");
}

function requestFor(body, boundary, {
  chunkSize = body.length,
  contentLength = false,
  onFirstPull,
  signal,
} = {}) {
  let offset = 0;
  let activePulls = 0;
  let maxActivePulls = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      activePulls += 1;
      maxActivePulls = Math.max(maxActivePulls, activePulls);
      if (offset === 0) onFirstPull?.();
      await Promise.resolve();
      if (offset >= body.length) controller.close();
      else {
        const end = Math.min(offset + Math.max(1, chunkSize), body.length);
        controller.enqueue(body.subarray(offset, end));
        offset = end;
      }
      activePulls -= 1;
    },
  });
  const request = new Request("http://localhost/api/files/tmp?type=upload", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      ...(contentLength ? { "content-length": String(body.length) } : {}),
    },
    body: stream,
    duplex: "half",
    signal,
  });
  return { request, maxActivePulls: () => maxActivePulls };
}

function leftovers(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith(".upload"));
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-stream-upload-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("stages exact multipart bytes with backpressure and private temporary files", async (t) => {
  const directory = temporaryDirectory(t);
  const boundary = "pihub-test-boundary";
  const body = multipartBody(boundary, [
    { name: "alpha.bin", bytes: Buffer.from([0, 255, 1]) },
    { name: "你好.txt", bytes: Buffer.from("hello\n") },
  ]);
  const streamed = requestFor(body, boundary, { chunkSize: 1 });
  const files = await upload.stageAuthenticatedMultipartUpload(
    streamed.request,
    directory,
    digest(body),
  );

  assert.deepEqual(files.map(({ name, size }) => ({ name, size })), [
    { name: "alpha.bin", size: 3 },
    { name: "你好.txt", size: 6 },
  ]);
  assert.deepEqual(fs.readFileSync(files[0].temporaryPath), Buffer.from([0, 255, 1]));
  assert.equal(streamed.maxActivePulls(), 1);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(files[0].temporaryPath).mode & 0o777, 0o600);
  }
  assert.equal(fs.existsSync(path.join(directory, "alpha.bin")), false);
  await upload.cleanupStagedUploadFiles(files);
  assert.deepEqual(leftovers(directory), []);
});

test("digest mismatch and malformed multipart leave no temporary files", async (t) => {
  const directory = temporaryDirectory(t);
  const boundary = "cleanup-boundary";
  const valid = multipartBody(boundary, [{ name: "report.txt", bytes: Buffer.from("secret") }]);
  await assert.rejects(
    upload.stageAuthenticatedMultipartUpload(
      requestFor(valid, boundary, { chunkSize: 2 }).request,
      directory,
      "0".repeat(64),
    ),
    (error) => error?.kind === "digest_mismatch",
  );
  assert.deepEqual(leftovers(directory), []);

  const malformed = multipartBody(
    boundary,
    [{ name: "partial.txt", bytes: Buffer.from("partial") }],
    { close: false },
  );
  await assert.rejects(
    upload.stageAuthenticatedMultipartUpload(
      requestFor(malformed, boundary, { chunkSize: 3 }).request,
      directory,
      digest(malformed),
    ),
    (error) => error?.kind === "malformed",
  );
  assert.deepEqual(leftovers(directory), []);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    upload.stageAuthenticatedMultipartUpload(
      requestFor(valid, boundary, { chunkSize: 1, signal: controller.signal }).request,
      directory,
      digest(valid),
    ),
    (error) => error?.kind === "malformed",
  );
  assert.deepEqual(leftovers(directory), []);
});

test("a directory swapped for a symlink before staging receives no upload bytes", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-stream-race-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const directory = path.join(base, "upload");
  const moved = path.join(base, "moved");
  const outside = path.join(base, "outside");
  fs.mkdirSync(directory);
  fs.mkdirSync(outside);
  const probe = path.join(base, "probe");
  try {
    fs.symlinkSync(outside, probe, process.platform === "win32" ? "junction" : "dir");
    fs.unlinkSync(probe);
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }
  const boundary = "directory-race-boundary";
  const body = multipartBody(boundary, [{ name: "secret.txt", bytes: Buffer.from("secret") }]);
  let swapped = false;

  const streamed = requestFor(body, boundary, {
    chunkSize: 1,
    onFirstPull() {
      if (swapped) return;
      fs.renameSync(directory, moved);
      fs.symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
      swapped = true;
    },
  });

  await assert.rejects(
    upload.stageAuthenticatedMultipartUpload(streamed.request, directory, digest(body)),
  );
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(fs.readdirSync(moved), []);
});

test("wire, file, aggregate, and count limits fail closed without residue", async (t) => {
  const directory = temporaryDirectory(t);
  const boundary = "limit-boundary";
  const defaults = upload.DEFAULT_MULTIPART_UPLOAD_LIMITS;
  assert.equal(defaults.maxRequestBytes, 101 * 1024 * 1024);
  assert.equal(defaults.maxFileBytes, 25 * 1024 * 1024);
  assert.equal(defaults.maxTotalFileBytes, 100 * 1024 * 1024);
  assert.equal(defaults.maxFiles, 256);

  const cases = [
    {
      kind: "request_too_large",
      files: [{ name: "one.bin", bytes: Buffer.from("123") }],
      limits: { ...defaults, maxRequestBytes: 20 },
    },
    {
      kind: "file_too_large",
      files: [{ name: "one.bin", bytes: Buffer.from("123") }],
      limits: { ...defaults, maxFileBytes: 2 },
    },
    {
      kind: "total_too_large",
      files: [
        { name: "one.bin", bytes: Buffer.from("123") },
        { name: "two.bin", bytes: Buffer.from("456") },
      ],
      limits: { ...defaults, maxFileBytes: 4, maxTotalFileBytes: 5 },
    },
    {
      kind: "too_many_files",
      files: [
        { name: "one.bin", bytes: Buffer.from("1") },
        { name: "two.bin", bytes: Buffer.from("2") },
      ],
      limits: { ...defaults, maxFiles: 1 },
    },
  ];

  for (const entry of cases) {
    const body = multipartBody(boundary, entry.files);
    await assert.rejects(
      upload.stageAuthenticatedMultipartUpload(
        requestFor(body, boundary, { chunkSize: 1 }).request,
        directory,
        digest(body),
        entry.limits,
      ),
      (error) => error?.kind === entry.kind,
      entry.kind,
    );
    assert.deepEqual(leftovers(directory), [], entry.kind);
  }
});

test("upload implementation never buffers through formData or arrayBuffer", () => {
  const implementation = fs.readFileSync(
    path.join(process.cwd(), "lib", "streaming-multipart-upload.ts"),
    "utf8",
  );
  const route = fs.readFileSync(
    path.join(process.cwd(), "app", "api", "files", "[...path]", "route.ts"),
    "utf8",
  );
  assert.doesNotMatch(implementation, /\.formData\s*\(|\.arrayBuffer\s*\(/);
  assert.doesNotMatch(route, /\.formData\s*\(|\.arrayBuffer\s*\(/);
});
