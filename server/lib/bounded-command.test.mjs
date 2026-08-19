import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { BoundedCommandError, runBoundedCommand } = await jiti.import("./bounded-command.ts");
const { createMinimalProcessEnvironment } = await jiti.import("./process-environment.ts");

const SECRET_SOURCE = {
  ...process.env,
  PI_WEB_PASSWORD: "web-password-child-canary",
  PIHUB_AUTH_SECRET: "auth-child-canary",
  OPENAI_API_KEY: "provider-child-canary",
  HTTPS_PROXY: "https://proxy-user:proxy-child-canary@proxy.invalid",
};

async function waitForChildExit(pid, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`child ${pid} survived cancellation`);
}

async function waitForFile(file, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`child readiness file was not created: ${file}`);
}

test("real child receives only minimal env and arguments never pass through a shell", async () => {
  const shellPayload = "&& echo WINDOWS_CMD_INJECTION_CANARY";
  const result = await runBoundedCommand(process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify({env:process.env,argv:process.argv.slice(1)}))",
    shellPayload,
  ], {
    environment: createMinimalProcessEnvironment(SECRET_SOURCE),
    sourceEnv: SECRET_SOURCE,
    timeout: 10_000,
  });
  const child = JSON.parse(result.stdout);

  assert.deepEqual(child.argv, [shellPayload]);
  assert.equal(child.env.PI_WEB_PASSWORD, undefined);
  assert.equal(child.env.PIHUB_AUTH_SECRET, undefined);
  assert.equal(child.env.OPENAI_API_KEY, undefined);
  assert.equal(child.env.HTTPS_PROXY, undefined);
  assert.equal(result.stderr, "");
});

test("real child failures expose only bounded redacted output", async () => {
  await assert.rejects(
    runBoundedCommand(process.execPath, [
      "-e",
      "process.stderr.write(process.argv[1] + 'x'.repeat(4096)); process.exit(7)",
      "auth-child-canary",
    ], {
      environment: createMinimalProcessEnvironment(SECRET_SOURCE),
      outputLimit: 256,
      sourceEnv: SECRET_SOURCE,
      timeout: 10_000,
    }),
    (error) => {
      assert.ok(error instanceof BoundedCommandError);
      assert.equal(error.message, "External command failed");
      assert.doesNotMatch(error.stderr, /auth-child-canary/);
      assert.ok(error.stderr.length <= 300);
      return true;
    },
  );
});

test("request cancellation terminates a real child immediately", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pihub-cancel-test-"));
  const pidFile = path.join(directory, "child.pid");
  const controller = new AbortController();
  try {
    const running = runBoundedCommand(process.execPath, [
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
      pidFile,
    ], {
      environment: createMinimalProcessEnvironment(SECRET_SOURCE),
      signal: controller.signal,
      timeout: 10_000,
    });
    const rejected = assert.rejects(running, (error) => error instanceof BoundedCommandError);
    const pid = Number(await waitForFile(pidFile));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    controller.abort(new DOMException("client disconnected", "AbortError"));
    await rejected;
    await waitForChildExit(pid);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("timeout kills a real child and redacts a secret split across output chunks", async () => {
  let caught;
  try {
    await runBoundedCommand(process.execPath, [
      "-e",
      "const s=process.argv[1]; process.stdout.write(String(process.pid)); process.stderr.write(s.slice(0,8)); setTimeout(() => process.stderr.write(s.slice(8)), 20); setInterval(() => {}, 1000)",
      "auth-child-canary",
    ], {
      environment: createMinimalProcessEnvironment(SECRET_SOURCE),
      sourceEnv: SECRET_SOURCE,
      timeout: 5000,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof BoundedCommandError);
  const pid = Number(caught.stdout);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.doesNotMatch(caught.stderr, /auth-child-canary/);
  assert.match(caught.stderr, /\[REDACTED\]/);
  await waitForChildExit(pid);
});

test("refuses a symlink command instead of resolving it through a shell or PATH", async (t) => {
  if (process.platform === "win32") return t.skip("Windows symlink creation needs optional privileges");
  const directory = await mkdtemp(path.join(os.tmpdir(), "pihub-command-test-"));
  const linkedNode = path.join(directory, "node-link");
  try {
    await symlink(process.execPath, linkedNode);
    await assert.rejects(
      runBoundedCommand(linkedNode, ["--version"], {
        environment: createMinimalProcessEnvironment(SECRET_SOURCE),
        timeout: 2000,
      }),
      (error) => error instanceof BoundedCommandError && error.message === "External command failed",
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
