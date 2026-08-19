#!/usr/bin/env node
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- published Node CLI is CommonJS */

const { createHash, createHmac, randomBytes } = require("node:crypto");
const fs = require("node:fs");

const MAX_CREDENTIAL_BYTES = 4 * 1024;
const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{22}$/;
const DEVICE_SECRET_PATTERN = /^pihub_key_[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,86}$/;
const AUTH_EPOCH_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CONTENT_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EMPTY_CONTENT_SHA256 = createHash("sha256").update("").digest("hex");

function usage() {
  return [
    "Usage: pihub-sign-request --credentials <path|-> --epoch <epoch> --method <METHOD> --url <URL-or-path>",
    "",
    "The credential JSON must contain deviceId and secret. Use '-' to read it",
    "from stdin. The secret is deliberately never accepted as a command-line argument.",
  ].join("\n");
}

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const allowed = new Set([
    "--credentials",
    "--epoch",
    "--method",
    "--url",
    "--timestamp",
    "--nonce",
    "--content-sha256",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(option) || value === undefined || values.has(option)) {
      fail("Invalid command-line arguments");
    }
    values.set(option, value);
  }
  for (const required of ["--credentials", "--epoch", "--method", "--url"]) {
    if (!values.has(required)) fail("Missing required command-line argument");
  }
  return {
    help: false,
    credentials: values.get("--credentials"),
    epoch: values.get("--epoch"),
    method: values.get("--method"),
    url: values.get("--url"),
    timestamp: values.get("--timestamp"),
    nonce: values.get("--nonce"),
    contentSha256: values.get("--content-sha256"),
  };
}

async function readStdinBounded() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_CREDENTIAL_BYTES) fail("Credential input is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

async function readCredentials(location) {
  let contents;
  if (location === "-") {
    contents = await readStdinBounded();
  } else {
    const metadata = fs.lstatSync(location);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CREDENTIAL_BYTES) {
      fail("Credential path must be a small regular file");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      fail("Credential file permissions must be 0600 or stricter");
    }
    contents = fs.readFileSync(location, "utf8");
  }

  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail("Credential input is not valid JSON");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || !DEVICE_ID_PATTERN.test(parsed.deviceId)
    || !DEVICE_SECRET_PATTERN.test(parsed.secret)
  ) {
    fail("Credential input is invalid");
  }
  return { deviceId: parsed.deviceId, secret: parsed.secret };
}

function canonicalPathname(pathname) {
  return pathname.split("/").map((segment) => {
    const decoded = decodeURIComponent(segment);
    return encodeURIComponent(decoded).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
  }).join("/");
}

function canonicalRequestTarget(input) {
  const url = new URL(input, "http://pihub.invalid");
  if (url.username || url.password || url.hash) fail("Invalid request URL");
  const pathname = canonicalPathname(url.pathname || "/");
  url.searchParams.sort();
  const query = url.searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { deviceId, secret } = await readCredentials(options.credentials);
  const method = options.method.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method)) fail("Invalid HTTP method");

  const timestamp = options.timestamp === undefined
    ? Math.floor(Date.now() / 1000)
    : Number(options.timestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || String(timestamp) !== String(options.timestamp ?? timestamp)) {
    fail("Invalid authentication timestamp");
  }
  const nonce = options.nonce ?? randomBytes(18).toString("base64url");
  if (!NONCE_PATTERN.test(nonce)) fail("Invalid authentication nonce");
  if (!AUTH_EPOCH_PATTERN.test(options.epoch)) fail("Invalid authentication epoch");
  const contentSha256 = options.contentSha256
    ?? EMPTY_CONTENT_SHA256;
  if (!CONTENT_SHA256_PATTERN.test(contentSha256)) {
    fail("Invalid content digest");
  }

  const payload = [
    "pihub-request-v3",
    method,
    canonicalRequestTarget(options.url),
    contentSha256,
    String(timestamp),
    nonce,
    options.epoch,
    deviceId,
  ].join("\n");
  const signature = createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
  process.stdout.write(`Authorization: PiHub-HMAC-SHA256 ${deviceId}:${timestamp}:${nonce}:${options.epoch}:${signature}\n`);
  if (method !== "GET" && method !== "HEAD") {
    process.stdout.write(`X-PiHub-Content-SHA256: ${contentSha256}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`Unable to sign request: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
