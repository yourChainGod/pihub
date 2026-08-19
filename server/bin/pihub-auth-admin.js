#!/usr/bin/env node
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- published Node CLI is CommonJS */

const fs = require("node:fs");
const path = require("node:path");
const { createJiti } = require("jiti");

const MAX_INPUT_BYTES = 16 * 1024;

function usage() {
  return [
    "Usage:",
    "  pihub-auth-admin list   [--state <path>] --output <path|->",
    "  pihub-auth-admin issue  [--state <path>] --input <path|-> --output <path|->",
    "  pihub-auth-admin rotate [--state <path>] --input <path|-> --output <path|->",
    "  pihub-auth-admin revoke [--state <path>] --input <path|-> --output <path|->",
    "  pihub-auth-admin claim-sessions [--state <path>] [--ownership-state <path>] --input <path|-> --output <path|->",
    "",
    "Inputs and outputs are JSON. Pairing codes and rotated secrets are emitted only",
    "to the explicitly selected output; they are never accepted through argv or env.",
    "Use --show-secret to deliberately emit a new code or secret to stdout.",
  ].join("\n");
}

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const showSecretCount = argv.filter((argument) => argument === "--show-secret").length;
  if (showSecretCount > 1) fail("Invalid command-line arguments");
  const filteredArguments = argv.filter((argument) => argument !== "--show-secret");
  const showSecret = showSecretCount === 1;
  const command = filteredArguments[0];
  if (!["list", "issue", "rotate", "revoke", "claim-sessions"].includes(command)) {
    fail("Invalid administration command");
  }
  const allowed = new Set(["--state", "--ownership-state", "--input", "--output"]);
  const values = new Map();
  for (let index = 1; index < filteredArguments.length; index += 2) {
    const option = filteredArguments[index];
    const value = filteredArguments[index + 1];
    if (!allowed.has(option) || value === undefined || values.has(option)) {
      fail("Invalid command-line arguments");
    }
    values.set(option, value);
  }
  if (!values.has("--output")) fail("An explicit output is required");
  if (command !== "list" && !values.has("--input")) fail("An explicit input is required");
  if (command !== "claim-sessions" && values.has("--ownership-state")) {
    fail("--ownership-state is only valid for claim-sessions");
  }
  if ((command === "issue" || command === "rotate") && values.get("--output") === "-" && !showSecret) {
    fail("Use --show-secret to emit a pairing code or device secret to stdout");
  }
  return {
    help: false,
    command,
    statePath: values.get("--state"),
    ownershipStatePath: values.get("--ownership-state"),
    input: values.get("--input"),
    output: values.get("--output"),
  };
}

function parseSessionClaimInput(input) {
  const allowed = new Set(["deviceId", "sessionIds", "claimAllUnowned"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    fail("Session claim input contains an unknown field");
  }
  if (typeof input.deviceId !== "string") fail("A deviceId is required");
  const hasSessionIds = Object.hasOwn(input, "sessionIds");
  const hasClaimAll = Object.hasOwn(input, "claimAllUnowned");
  if (hasSessionIds === hasClaimAll) {
    fail("Select exactly one of sessionIds or claimAllUnowned");
  }
  if (hasClaimAll) {
    if (input.claimAllUnowned !== true) fail("claimAllUnowned must be true");
    return { deviceId: input.deviceId, claimAllUnowned: true };
  }
  if (!Array.isArray(input.sessionIds) || input.sessionIds.length === 0) {
    fail("sessionIds must be a non-empty array");
  }
  if (!input.sessionIds.every((sessionId) => typeof sessionId === "string")) {
    fail("sessionIds must contain only strings");
  }
  if (new Set(input.sessionIds).size !== input.sessionIds.length) {
    fail("sessionIds must not contain duplicates");
  }
  return { deviceId: input.deviceId, sessionIds: input.sessionIds };
}

async function listAllSessions() {
  const agent = await import("@earendil-works/pi-coding-agent");
  return agent.SessionManager.listAll();
}

async function claimSessions(jiti, authStore, authStoreOptions, options, input) {
  const claimInput = parseSessionClaimInput(input);
  const device = authStore.getActivePihubDevice(claimInput.deviceId, authStoreOptions);
  if (!device) fail("An active device is required to claim sessions");

  const ownership = await jiti.import(path.join(__dirname, "..", "lib", "session-ownership.ts"));
  const ownershipOptions = options.ownershipStatePath
    ? { statePath: options.ownershipStatePath }
    : {};
  const sessions = await listAllSessions();
  const knownSessionIds = new Set(sessions.map((session) => session.id));
  let selectedSessionIds;
  if (claimInput.claimAllUnowned) {
    const currentOwners = ownership.getSessionOwners(undefined, ownershipOptions);
    selectedSessionIds = [...knownSessionIds].filter((sessionId) => !currentOwners.has(sessionId));
  } else {
    selectedSessionIds = claimInput.sessionIds;
    for (const sessionId of selectedSessionIds) {
      if (!ownership.isValidSessionOwnershipSessionId(sessionId)) {
        fail(`Invalid session identifier: ${sessionId}`);
      }
      if (!knownSessionIds.has(sessionId)) fail(`Session not found: ${sessionId}`);
    }
  }

  const result = await ownership.claimUnownedSessions(
    selectedSessionIds,
    claimInput.deviceId,
    ownershipOptions,
  );
  return {
    deviceId: claimInput.deviceId,
    claimedSessionIds: result.claimed,
    alreadyOwnedSessionIds: result.alreadyOwned,
  };
}

async function readStdinBounded() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT_BYTES) fail("Administration input is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length).toString("utf8");
}

async function readInput(location) {
  let contents;
  if (location === "-") {
    contents = await readStdinBounded();
  } else {
    const metadata = fs.lstatSync(location);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_INPUT_BYTES) {
      fail("Administration input must be a small regular file");
    }
    contents = fs.readFileSync(location, "utf8");
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail("Administration input is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("Administration input must be a JSON object");
  }
  return parsed;
}

function writeOutput(location, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (location === "-") {
    process.stdout.write(contents);
    return;
  }
  const parent = path.dirname(path.resolve(location));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.writeFileSync(location, contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  if (process.platform !== "win32") fs.chmodSync(location, 0o600);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const jiti = createJiti(__filename, { interopDefault: true });
  const store = await jiti.import(path.join(__dirname, "..", "lib", "pihub-auth-store.ts"));
  const storeOptions = options.statePath ? { statePath: options.statePath } : {};
  let result;
  if (options.command === "list") {
    result = await store.listPihubAuthState(storeOptions);
  } else {
    const input = await readInput(options.input);
    if (options.command === "issue") {
      result = await store.issuePihubPairingCode({
        label: input.label,
        capabilities: input.capabilities,
        ttlMs: input.ttlSeconds === undefined
          ? undefined
          : typeof input.ttlSeconds === "number"
            ? input.ttlSeconds * 1000
            : Number.NaN,
      }, storeOptions);
    } else if (options.command === "rotate") {
      result = await store.rotatePihubDeviceSecret(input.deviceId, storeOptions);
    } else if (options.command === "revoke") {
      result = await store.revokePihubDevice(input.deviceId, {
        ...storeOptions,
        allowLastManagerRevocation: true,
      });
    } else {
      result = await claimSessions(jiti, store, storeOptions, options, input);
    }
  }
  writeOutput(options.output, result);
}

main().catch((error) => {
  process.stderr.write(`PiHub authentication administration failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
