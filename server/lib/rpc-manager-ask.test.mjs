import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

const PI_ASK_STARTED_EVENT = "@eko24ive/pi-ask:started";
const PI_ASK_COMPLETED_EVENT = "@eko24ive/pi-ask:completed";
const PI_ASK_SUBMIT_EVENT = "@eko24ive/pi-ask:submit";
const PI_ASK_SUBMIT_RESULT_EVENT = "@eko24ive/pi-ask:submit-result";

function makeInner(overrides = {}) {
  return {
    sessionId: "ask-test-session",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: undefined,
    modelRuntime: {
      getModel: () => undefined,
      refresh: async () => {},
    },
    sessionManager: { getCwd: () => process.cwd() },
    settingsManager: { setProjectTrusted: () => {} },
    agent: { state: {} },
    extensionRunner: {
      getRegisteredCommands: () => [],
      setUIContext: () => {},
      emit: async () => {},
    },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    subscribe: () => () => {},
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    pendingMessageCount: 0,
    dispose: () => {},
    reload: async () => {},
    ...overrides,
  };
}

function makeBus() {
  const handlers = new Map();
  const emitted = [];
  return {
    emitted,
    on(channel, handler) {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel, data) {
      emitted.push({ channel, data });
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };
}

function startedPayload(overrides = {}) {
  return {
    version: 1,
    flowId: "tool:call-1",
    source: "tool",
    toolCallId: "call-1",
    title: "需要确认",
    createdAt: 1,
    questions: [
      {
        id: "q1",
        label: "方案",
        prompt: "选择实现方案",
        type: "single",
        required: true,
        options: [
          { value: "a", label: "方案 A", description: "简单", recommended: true },
          { value: "b", label: "方案 B" },
        ],
      },
    ],
    ...overrides,
  };
}

function createContext(t, options = {}) {
  const bus = makeBus();
  const events = [];
  const wrapper = new AgentSessionWrapper(makeInner(), { extensionEvents: bus, ...options });
  wrapper.onEvent((event) => events.push(event));
  // The wrapper's idle timer keeps the event loop alive; destroy it after each test.
  t.after(() => wrapper.destroy());
  return { bus, events, wrapper };
}

function askEvents(events) {
  return events.filter((event) => event.type === "extension_ui_request" && event.method === "ask");
}

function customEvents(events) {
  return events.filter((event) => event.type === "extension_ui_request" && event.method === "custom");
}

test("started event becomes a structured ask UI request", (t) => {
  const { bus, events } = createContext(t);

  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());

  const request = askEvents(events).at(-1);
  assert.ok(request);
  assert.equal(request.ask.flowId, "tool:call-1");
  assert.equal(request.ask.title, "需要确认");
  assert.equal(request.ask.source, "tool");
  assert.equal(request.ask.questions.length, 1);
  assert.deepEqual(request.ask.questions[0].options[0], {
    value: "a",
    label: "方案 A",
    description: "简单",
    recommended: true,
  });
});

test("ask UI request replays to late listeners", (t) => {
  const { bus, wrapper } = createContext(t);
  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());

  const replayed = [];
  wrapper.onEvent((event) => replayed.push(event));

  assert.equal(askEvents(replayed).length, 1);
});

test("malformed started events are ignored", (t) => {
  const { bus, events } = createContext(t);

  bus.emit(PI_ASK_STARTED_EVENT, null);
  bus.emit(PI_ASK_STARTED_EVENT, { flowId: "tool:x" });
  bus.emit(PI_ASK_STARTED_EVENT, { flowId: "tool:x", questions: [{ id: "q1" }] });

  assert.equal(askEvents(events).length, 0);
});

test("the matching character custom UI is suppressed", async (t) => {
  const { bus, events, wrapper } = createContext(t);
  const context = wrapper.createExtensionUiContext();

  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());
  let doneCallback;
  const resultPromise = context.custom((tui, theme, keybindings, done) => {
    doneCallback = done;
    return { render: () => ["─ question ─"], dispose: () => {} };
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(customEvents(events).length, 0);
  assert.equal(askEvents(events).length, 1);

  doneCallback({ cancelled: true });
  await resultPromise;
  assert.equal(customEvents(events).length, 0);
});

test("custom UIs without an active ask flow still render", async (t) => {
  const { events, wrapper } = createContext(t);
  const context = wrapper.createExtensionUiContext();

  let doneCallback;
  const resultPromise = context.custom((tui, theme, keybindings, done) => {
    doneCallback = done;
    return { render: () => ["plain"], dispose: () => {} };
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(customEvents(events).length, 1);
  doneCallback(undefined);
  await resultPromise;
});

test("ask responses are forwarded to the extension bus as submit events", async (t) => {
  const { bus, events, wrapper } = createContext(t);
  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());
  const request = askEvents(events).at(-1);

  await wrapper.send({
    type: "extension_ui_response",
    id: request.id,
    ask: { kind: "answer", answers: { q1: { values: ["a"] } }, mode: "submit" },
  });

  const submit = bus.emitted.find((entry) => entry.channel === PI_ASK_SUBMIT_EVENT);
  assert.ok(submit);
  assert.equal(submit.data.version, 1);
  assert.equal(submit.data.flowId, "tool:call-1");
  assert.ok(typeof submit.data.requestId === "string" && submit.data.requestId);
  assert.deepEqual(submit.data.response, {
    kind: "answer",
    answers: { q1: { values: ["a"] } },
    mode: "submit",
  });
});

test("malformed ask responses fall back to cancel", async (t) => {
  const { bus, events, wrapper } = createContext(t);
  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());
  const request = askEvents(events).at(-1);

  await wrapper.send({ type: "extension_ui_response", id: request.id, ask: { nope: true } });

  const submit = bus.emitted.find((entry) => entry.channel === PI_ASK_SUBMIT_EVENT);
  assert.deepEqual(submit.data.response, { kind: "cancel" });
});

test("completed event closes the native ask panel", (t) => {
  const { bus, events, wrapper } = createContext(t);
  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());
  const request = askEvents(events).at(-1);

  bus.emit(PI_ASK_COMPLETED_EVENT, { version: 1, flowId: "tool:call-1", source: "tool", result: {}, completedAt: 2 });

  const closed = askEvents(events).at(-1);
  assert.equal(closed.id, request.id);
  assert.equal(closed.closed, true);
  assert.equal(closed.ask.flowId, "tool:call-1");

  // Once closed, the request no longer replays to late listeners.
  const replayed = [];
  wrapper.onEvent((event) => replayed.push(event));
  assert.equal(askEvents(replayed).length, 0);
});

test("a rejected submit reopens the panel with the failure reason", (t) => {
  const { bus, events } = createContext(t);
  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());
  const request = askEvents(events).at(-1);

  bus.emit(PI_ASK_SUBMIT_RESULT_EVENT, {
    version: 1,
    flowId: "tool:call-1",
    requestId: "submit-1",
    ok: false,
    error: "invalid_answer",
    message: "Unknown question id",
  });

  const reopened = askEvents(events).at(-1);
  assert.equal(reopened.id, request.id);
  assert.equal(reopened.error, "Unknown question id");
  assert.equal(reopened.ask.flowId, "tool:call-1");
});

test("reload closes all pending ask panels", async (t) => {
  const { bus, events, wrapper } = createContext(t);
  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());
  const request = askEvents(events).at(-1);

  await wrapper.send({ type: "reload" });

  const closed = askEvents(events).at(-1);
  assert.equal(closed.id, request.id);
  assert.equal(closed.closed, true);
});

test("completed without a matching start is ignored", (t) => {
  const { bus, events } = createContext(t);

  bus.emit(PI_ASK_COMPLETED_EVENT, { version: 1, flowId: "tool:ghost" });

  assert.equal(askEvents(events).length, 0);
});
