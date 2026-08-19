import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { boundedProcessOutput, redactProcessOutput } = await createJiti(import.meta.url)
  .import("./process-output-security.ts");

test("redacts environment canaries and common credential formats", () => {
  const source = {
    PI_WEB_PASSWORD: "web-password-canary",
    PIHUB_AUTH_SECRET: "auth-secret-canary",
    OPENAI_API_KEY: "provider-secret-canary",
    HTTPS_PROXY: "https://proxy-user:proxy-password@proxy.invalid",
  };
  const output = redactProcessOutput([
    "web-password-canary auth-secret-canary provider-secret-canary",
    "Authorization: Bearer abcdefghijklmnop",
    '{"token":"standalone-token-canary","password":"standalone-password-canary"}',
    "https://user:password@example.invalid/path",
    "pihub_key_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
  ].join("\n"), source);

  for (const canary of [
    "web-password-canary",
    "auth-secret-canary",
    "provider-secret-canary",
    "standalone-token-canary",
    "standalone-password-canary",
    "abcdefghijklmnop",
    "user:password",
  ]) assert.doesNotMatch(output, new RegExp(canary));
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotThrow(() => JSON.parse(output.split("\n")[2]));
});

test("bounds redacted output before it crosses an API boundary", () => {
  const output = boundedProcessOutput(`prefix-secret-canary-${"x".repeat(500)}`, {
    limit: 40,
    source: { SESSION_SECRET: "secret-canary" },
  });
  assert.match(output, /^\[output truncated\]/);
  assert.ok(output.length <= 60);
  assert.doesNotMatch(output, /secret-canary/);
});
