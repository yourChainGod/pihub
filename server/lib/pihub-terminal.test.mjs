import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

async function loadSubject() {
  return jiti.import("./pihub-terminal.ts");
}

class FakePty {
  pid = 123;
  cols = 100;
  rows = 30;
  process = "fake-shell";
  handleFlowControl = false;
  killed = false;
  writes = [];
  resizes = [];
  dataListeners = new Set();
  exitListeners = new Set();

  onData = (listener) => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  };

  onExit = (listener) => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };

  emitData(data) {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  emitExit(exitCode) {
    for (const listener of [...this.exitListeners]) listener({ exitCode });
  }

  write(data) { this.writes.push(data); }
  resize(columns, rows) { this.resizes.push([columns, rows]); }
  kill() { this.killed = true; }
  clear() {}
  pause() {}
  resume() {}
}

class FakeScheduler {
  tasks = new Set();
  unrefCount = 0;

  setTimeout(callback, delayMs) {
    const handle = {
      callback,
      delayMs,
      unref: () => { this.unrefCount += 1; },
    };
    this.tasks.add(handle);
    return handle;
  }

  clearTimeout(handle) {
    this.tasks.delete(handle);
  }

  fireLatest() {
    const handle = [...this.tasks].at(-1);
    assert.ok(handle, "expected an active timer");
    this.tasks.delete(handle);
    handle.callback();
  }
}

function fakeManagerOptions(overrides = {}) {
  const ptys = [];
  let nextId = 0;
  return {
    ptys,
    options: {
      env: { PATH: "/usr/bin", HOME: "/tmp/test-home" },
      resolveShell: () => ({ file: "/bin/sh", args: ["-l"], kind: "unix" }),
      spawn: () => {
        const child = new FakePty();
        ptys.push(child);
        return child;
      },
      randomId: () => `terminal-${++nextId}`,
      ...overrides,
    },
  };
}

test("Linux safely probes executable fallback shells when SHELL is absent or invalid", async () => {
  const { resolveTerminalShell } = await loadSubject();
  const probed = [];
  const shell = resolveTerminalShell({
    platform: "linux",
    env: { SHELL: "missing-shell", PATH: "/untrusted/bin" },
    isExecutable(candidate) {
      probed.push(candidate);
      return candidate === "/bin/sh";
    },
  });

  assert.deepEqual(shell, { file: "/bin/sh", args: ["-l"], kind: "unix" });
  assert.deepEqual(probed, ["/bin/bash", "/usr/bin/bash", "/bin/sh"]);
});

test("Windows honors configured shell and assigns known shell arguments", async () => {
  const { resolveTerminalShell } = await loadSubject();
  const configured = resolveTerminalShell({
    platform: "win32",
    env: { PIHUB_WINDOWS_SHELL: "C:\\Tools\\pwsh.exe" },
    isExecutable: (candidate) => candidate === "C:\\Tools\\pwsh.exe",
  });
  assert.deepEqual(configured, {
    file: "C:\\Tools\\pwsh.exe",
    args: ["-NoLogo"],
    kind: "pwsh",
  });

  const custom = resolveTerminalShell({
    platform: "win32",
    env: { PIHUB_WINDOWS_SHELL: "nu.exe", Path: "C:\\Shells" },
    isExecutable: (candidate) => candidate === "C:\\Shells\\nu.exe",
  });
  assert.deepEqual(custom, {
    file: "C:\\Shells\\nu.exe",
    args: [],
    kind: "custom-windows",
  });
});

test("Windows falls back through pwsh, Windows PowerShell, then cmd", async () => {
  const { resolveTerminalShell } = await loadSubject();
  const powershell = resolveTerminalShell({
    platform: "win32",
    env: { PATH: "C:\\PowerShell;C:\\Windows\\System32" },
    isExecutable: (candidate) => candidate === "C:\\PowerShell\\powershell.exe",
  });
  assert.deepEqual(powershell, {
    file: "C:\\PowerShell\\powershell.exe",
    args: ["-NoLogo"],
    kind: "powershell",
  });

  const cmd = resolveTerminalShell({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    isExecutable: (candidate) => candidate === "C:\\Windows\\System32\\cmd.exe",
  });
  assert.deepEqual(cmd, {
    file: "C:\\Windows\\System32\\cmd.exe",
    args: ["/D", "/Q"],
    kind: "cmd",
  });

  const comspec = resolveTerminalShell({
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    isExecutable: (candidate) => candidate === "C:\\Windows\\System32\\cmd.exe",
  });
  assert.deepEqual(comspec, {
    file: "C:\\Windows\\System32\\cmd.exe",
    args: ["/D", "/Q"],
    kind: "cmd",
  });
});

test("UTF-16 ring buffer never retains a split surrogate and exposes absolute cursors", async () => {
  const { TerminalOutputBuffer } = await loadSubject();
  const buffer = new TerminalOutputBuffer(4);
  buffer.append("ab😀c");
  assert.equal(buffer.output, "b😀c");
  assert.equal(buffer.dropped, 1);
  assert.equal(buffer.cursor, 5);

  buffer.append("😀");
  assert.equal(buffer.output, "c😀");
  assert.equal(buffer.dropped, 4);
  assert.equal(buffer.cursor, 7);
  assert.deepEqual(buffer.read(1), { chunk: "c😀", cursor: 7, reset: true });
  assert.deepEqual(buffer.read(4), { chunk: "c😀", cursor: 7, reset: false });
  assert.deepEqual(buffer.read(5), { chunk: "😀", cursor: 7, reset: false });
  assert.deepEqual(buffer.read(8), { chunk: "c😀", cursor: 7, reset: true });
});

test("manager uses ConPTY and a minimal environment on Windows", async () => {
  const { TerminalManager } = await loadSubject();
  let invocation;
  const child = new FakePty();
  const manager = new TerminalManager({
    platform: "win32",
    env: {
      Path: "C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\pi",
      PI_WEB_PASSWORD: "must-not-leak",
      SERVICE_API_KEY: "must-not-leak",
    },
    resolveShell: () => ({ file: "pwsh.exe", args: ["-NoLogo"], kind: "pwsh" }),
    spawn(file, args, options) {
      invocation = { file, args, options };
      return child;
    },
    randomId: () => "terminal-win",
  });

  manager.create("C:\\work", "device-a");
  assert.equal(invocation.file, "pwsh.exe");
  assert.deepEqual(invocation.args, ["-NoLogo"]);
  assert.equal(invocation.options.useConpty, true);
  assert.equal(invocation.options.encoding, "utf8");
  assert.equal(invocation.options.env.Path, "C:\\Windows\\System32");
  assert.equal(invocation.options.env.TERM, "xterm-256color");
  assert.equal(invocation.options.env.COLORTERM, "truecolor");
  assert.equal(invocation.options.env.TERM_PROGRAM, "PiHub");
  assert.equal(invocation.options.env.PI_WEB_PASSWORD, undefined);
  assert.equal(invocation.options.env.SERVICE_API_KEY, undefined);
  manager.shutdown();
});

test("manager enforces per-owner and process-wide terminal limits", async () => {
  const { TerminalCapacityError, TerminalManager } = await loadSubject();
  const { options } = fakeManagerOptions({
    maxTerminalsPerOwner: 1,
    maxTerminalsPerProcess: 2,
  });
  const manager = new TerminalManager(options);
  manager.create("/work/a", "device-a");
  assert.throws(
    () => manager.create("/work/b", "device-a"),
    (error) => error instanceof TerminalCapacityError && error.code === "OWNER_LIMIT",
  );
  manager.create("/work/b", "device-b");
  assert.throws(
    () => manager.create("/work/c", "device-c"),
    (error) => error instanceof TerminalCapacityError && error.code === "PROCESS_LIMIT",
  );
  manager.shutdown();
});

test("terminal access is owner-isolated and input, resize, and reads touch the session", async () => {
  const { TerminalManager } = await loadSubject();
  let now = 10;
  const { options, ptys } = fakeManagerOptions({ now: () => now });
  const manager = new TerminalManager(options);
  const session = manager.create("/work", "device-a");
  const child = ptys[0];
  child.emitData("hello");

  assert.equal(manager.get(session.id, "device-b"), undefined);
  assert.equal(manager.write(session.id, "device-b", "bad"), false);
  assert.equal(manager.resize(session.id, "device-b", 80, 24), false);
  assert.equal(manager.close(session.id, "device-b"), false);
  assert.deepEqual(child.writes, []);

  now = 20;
  assert.equal(manager.write(session.id, "device-a", "ok"), true);
  assert.equal(session.lastTouchedAt, 20);
  now = 30;
  assert.equal(manager.resize(session.id, "device-a", 80, 24), true);
  assert.equal(session.lastTouchedAt, 30);
  now = 40;
  assert.deepEqual(manager.read(session.id, "device-a", 0), {
    chunk: "hello",
    cursor: 5,
    reset: false,
  });
  assert.equal(session.lastTouchedAt, 40);
  assert.deepEqual(child.writes, ["ok"]);
  assert.deepEqual(child.resizes, [[80, 24]]);
  manager.shutdown();
});

test("idle timers are unrefed and close inactive terminals", async () => {
  const { TerminalManager } = await loadSubject();
  let now = 0;
  const scheduler = new FakeScheduler();
  const { options, ptys } = fakeManagerOptions({
    now: () => now,
    scheduler,
    idleTtlMs: 1_000,
  });
  const manager = new TerminalManager(options);
  const session = manager.create("/work", "device-a");
  assert.equal(scheduler.unrefCount, 1);

  now = 900;
  assert.ok(manager.get(session.id, "device-a"));
  now = 1_900;
  scheduler.fireLatest();
  assert.equal(manager.count(), 0);
  assert.equal(ptys[0].killed, true);
});

test("active subscriptions prevent idle close and unsubscribe rearms cleanup", async () => {
  const { TerminalManager } = await loadSubject();
  let now = 0;
  const scheduler = new FakeScheduler();
  const { options, ptys } = fakeManagerOptions({
    now: () => now,
    scheduler,
    idleTtlMs: 1_000,
  });
  const manager = new TerminalManager(options);
  const session = manager.create("/work", "device-a");
  const unsubscribe = manager.subscribe(session.id, "device-a", () => {});
  assert.ok(unsubscribe);

  now = 1_000;
  scheduler.fireLatest();
  assert.equal(manager.count(), 1);
  assert.equal([...scheduler.tasks].at(-1).delayMs, 1_000);
  unsubscribe();
  now = 2_000;
  scheduler.fireLatest();
  assert.equal(manager.count(), 0);
  assert.equal(ptys[0].killed, true);
});

test("subscriber limits bound persistent SSE ownership", async () => {
  const { TerminalCapacityError, TerminalManager } = await loadSubject();
  const { options } = fakeManagerOptions({ maxSubscribersPerTerminal: 1 });
  const manager = new TerminalManager(options);
  const session = manager.create("/work", "device-a");
  const unsubscribe = manager.subscribe(session.id, "device-a", () => {});
  assert.ok(unsubscribe);
  assert.throws(
    () => manager.subscribe(session.id, "device-a", () => {}),
    (error) => error instanceof TerminalCapacityError && error.code === "SUBSCRIBER_LIMIT",
  );
  unsubscribe();
  manager.shutdown();
});

test("exit, close, and shutdown remove sessions, listeners, and PTYs exactly once", async () => {
  const { TerminalManager } = await loadSubject();
  const { options, ptys } = fakeManagerOptions();
  const manager = new TerminalManager(options);
  const natural = manager.create("/natural", "device-a");
  const close = manager.create("/close", "device-a");
  const shutdown = manager.create("/shutdown", "device-b");
  const events = [];
  manager.subscribe(natural.id, "device-a", (event) => events.push(event));
  ptys[0].emitExit(7);
  assert.deepEqual(events.at(-1), { type: "exit", data: 7, reason: "exit" });
  assert.equal(ptys[0].killed, false);
  assert.equal(ptys[0].dataListeners.size, 0);
  assert.equal(ptys[0].exitListeners.size, 0);

  assert.equal(manager.close(close.id, "device-a"), true);
  assert.equal(manager.close(close.id, "device-a"), false);
  assert.equal(ptys[1].killed, true);
  manager.shutdown();
  assert.equal(manager.count(), 0);
  assert.equal(ptys[2].killed, true);
  assert.equal(manager.get(shutdown.id, "device-b"), undefined);
  assert.throws(() => manager.create("/after-shutdown", "device-a"), /shut down/);
});
