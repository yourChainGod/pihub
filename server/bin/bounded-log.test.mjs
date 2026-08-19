import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { finished } from "node:stream/promises";

const require = createRequire(import.meta.url);
const { createBoundedLogStream } = require("./bounded-log.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-bounded-log-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function write(stream, chunks) {
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await finished(stream);
}

test("rotates at the byte boundary and retains only bounded backups", async (t) => {
  const directory = fixture(t);
  const stream = createBoundedLogStream({
    directory,
    name: "server.log",
    maxBytes: 8,
    backups: 1,
  });

  await write(stream, ["abcde", "fghij", "klmnopqr"]);

  assert.equal(fs.readFileSync(path.join(directory, "server.log.1"), "utf8"), "ijklmnop");
  assert.equal(fs.readFileSync(path.join(directory, "server.log"), "utf8"), "qr");
  assert.ok(fs.statSync(path.join(directory, "server.log.1")).size <= 8);
  assert.ok(fs.statSync(path.join(directory, "server.log")).size <= 8);
});

test("bounds an oversized pre-existing log before accepting new output", async (t) => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, "server.log"), "0123456789abcdef");
  const stream = createBoundedLogStream({
    directory,
    name: "server.log",
    maxBytes: 8,
    backups: 1,
  });

  await write(stream, ["new"]);

  assert.equal(fs.readFileSync(path.join(directory, "server.log.1"), "utf8"), "89abcdef");
  assert.equal(fs.readFileSync(path.join(directory, "server.log"), "utf8"), "new");
});

test("redacts credentials across UTF-8 byte and stream chunk boundaries", async (t) => {
  const directory = fixture(t);
  const deviceSecret = `pihub_key_${"A".repeat(43)}`;
  const pairingSecret = `pihub-${"B".repeat(43)}`;
  const bearerSecret = "bearer-canary-value";
  const basicSecret = "QmFzaWMtQ2FuYXJ5OnNlY3JldA==";
  const hmacSecret = "device-id:1700000000:nonce:1:signature-canary";
  const bareHmacSecret = "bare-device:1700000001:nonce:1:signature-canary";
  const apiKeySecret = "api-key-canary-value";
  const dashedApiKeySecret = "dashed-api-key-canary";
  const compactApiKeySecret = "compact-api-key-canary";
  const passwordSecret = "password-canary-value";
  const accessTokenSecret = "access-token-canary-value";
  const genericSecret = "generic-secret-canary-value";
  const headerSecret = "header-api-key-canary";
  const unterminatedSecret = "unterminated-password-canary";
  const urlPassword = "url-password-canary";
  const queryToken = "query-token-canary";
  const queryApiKey = "query-api-key-canary";
  const secrets = [
    deviceSecret,
    pairingSecret,
    bearerSecret,
    basicSecret,
    hmacSecret,
    bareHmacSecret,
    apiKeySecret,
    dashedApiKeySecret,
    compactApiKeySecret,
    passwordSecret,
    accessTokenSecret,
    genericSecret,
    headerSecret,
    unterminatedSecret,
    urlPassword,
    queryToken,
    queryApiKey,
  ];
  const payload = [
    "utf8=\u4e2d\u6587",
    deviceSecret,
    pairingSecret,
    `Authorization: Bearer ${bearerSecret}`,
    `authorization=Basic ${basicSecret}`,
    `Authorization: PiHub-HMAC-SHA256 ${hmacSecret}`,
    `PiHub-HMAC-SHA256 ${bareHmacSecret}`,
    `{"api_key":"${apiKeySecret}","password":"${passwordSecret}"}`,
    `api-key=${dashedApiKeySecret}`,
    `apikey: ${compactApiKeySecret}`,
    `access_token=${accessTokenSecret}`,
    `secret=${genericSecret}`,
    `x-api-key: ${headerSecret}`,
    `password="${unterminatedSecret}`,
    "visible-after-unterminated-quote=true",
    `endpoint=https://user:${urlPassword}@example.test/path?token=${queryToken}&api_key=${queryApiKey}`,
    "normal=https://example.test:30141/path pihub-server tokenCount=2",
    "",
  ].join("\n");
  const stream = createBoundedLogStream({
    directory,
    name: "server.log",
    maxBytes: 32 * 1024,
    backups: 1,
  });
  const byteChunks = [...Buffer.from(payload, "utf8")].map((byte) => Buffer.of(byte));

  await write(stream, byteChunks);

  const logged = fs.readFileSync(path.join(directory, "server.log"), "utf8");
  for (const secret of secrets) assert.equal(logged.includes(secret), false, secret);
  assert.match(logged, /utf8=\u4e2d\u6587/);
  assert.match(logged, /https:\/\/\[REDACTED\]@example\.test\/path\?token=\[REDACTED\]&api_key=\[REDACTED\]/);
  assert.match(logged, /normal=https:\/\/example\.test:30141\/path pihub-server tokenCount=2/);
  assert.match(logged, /visible-after-unterminated-quote=true/);
  assert.ok(logged.match(/\[REDACTED\]/g).length >= secrets.length);
});

test("redacts an arbitrarily long credential before rotating either log file", async (t) => {
  const directory = fixture(t);
  const stream = createBoundedLogStream({
    directory,
    name: "server.log",
    maxBytes: 64,
    backups: 1,
  });
  const credential = `ROTATION-CANARY-${"x".repeat(256 * 1024)}`;

  await write(stream, [
    "prefix pass",
    "word=",
    credential.slice(0, 17),
    credential.slice(17),
    "\n",
    "safe-output-".repeat(8),
  ]);

  const backup = fs.readFileSync(path.join(directory, "server.log.1"), "utf8");
  const current = fs.readFileSync(path.join(directory, "server.log"), "utf8");
  for (const logged of [backup, current]) {
    assert.equal(logged.includes("ROTATION-CANARY"), false);
    assert.equal(logged.includes("x".repeat(32)), false);
  }
  assert.match(backup + current, /password=\[REDACTED\]/);
  assert.ok(Buffer.byteLength(backup) <= 64);
  assert.ok(Buffer.byteLength(current) <= 64);
  assert.equal(fs.existsSync(path.join(directory, "server.log.2")), false);
});

test("uses private POSIX permissions for the directory and every log", async (t) => {
  if (process.platform === "win32") t.skip("POSIX mode bits are not meaningful on Windows");
  const directory = fixture(t);
  fs.chmodSync(directory, 0o755);
  const stream = createBoundedLogStream({
    directory,
    name: "server-error.log",
    maxBytes: 4,
    backups: 1,
  });

  await write(stream, ["private"]);

  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, "server-error.log")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(directory, "server-error.log.1")).mode & 0o777, 0o600);
});

test("rejects symbolic-link log targets and backup targets", (t) => {
  if (process.platform === "win32") t.skip("symbolic-link creation requires additional privileges on Windows");
  const directory = fixture(t);
  const outside = path.join(directory, "outside");
  fs.writeFileSync(outside, "outside");
  fs.symlinkSync(outside, path.join(directory, "server.log"));
  assert.throws(
    () => createBoundedLogStream({ directory, name: "server.log", maxBytes: 8, backups: 1 }),
    /non-regular file or symbolic link/,
  );

  fs.unlinkSync(path.join(directory, "server.log"));
  fs.writeFileSync(path.join(directory, "server.log"), "12345678");
  fs.symlinkSync(outside, path.join(directory, "server.log.1"));
  assert.throws(
    () => createBoundedLogStream({ directory, name: "server.log", maxBytes: 8, backups: 1 }),
    /non-regular file or symbolic link/,
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
});

test("rejects relative directories, path-like names, and unsafe limits", () => {
  assert.throws(
    () => createBoundedLogStream({ directory: "relative", name: "server.log" }),
    /absolute path/,
  );
  assert.throws(
    () => createBoundedLogStream({ directory: path.resolve("/tmp"), name: "../server.log" }),
    /log name is invalid/,
  );
  assert.throws(
    () => createBoundedLogStream({ directory: path.resolve("/tmp"), name: "server.log", maxBytes: 0 }),
    /size limit is invalid/,
  );
});
