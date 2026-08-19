import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createSharedAbortableOperation } = await createJiti(import.meta.url)
  .import("./shared-abortable-operation.ts");

function deferredOperation() {
  const entries = [];
  let active = 0;
  let maxActive = 0;
  const operation = (signal) => new Promise((resolve, reject) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const entry = {
      aborted: false,
      resolve(value) {
        active -= 1;
        resolve(value);
      },
    };
    entries.push(entry);
    const abort = () => {
      if (entry.aborted) return;
      entry.aborted = true;
      active -= 1;
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  return { entries, get maxActive() { return maxActive; }, operation };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("one cancelled subscriber does not abort shared work still in use", async () => {
  const deferred = deferredOperation();
  const run = createSharedAbortableOperation(deferred.operation);
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = run(firstController.signal);
  const second = run(secondController.signal);
  await nextTurn();

  assert.equal(deferred.entries.length, 1);
  firstController.abort(new DOMException("first disconnected", "AbortError"));
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(deferred.entries[0].aborted, false);
  deferred.entries[0].resolve("installed");
  assert.equal(await second, "installed");
});

test("the last cancellation aborts the child and a successor waits for cleanup", async () => {
  const deferred = deferredOperation();
  const run = createSharedAbortableOperation(deferred.operation);
  const firstController = new AbortController();
  const first = run(firstController.signal);
  await nextTurn();
  firstController.abort(new DOMException("only subscriber disconnected", "AbortError"));
  const second = run();

  await assert.rejects(first, { name: "AbortError" });
  await nextTurn();
  assert.equal(deferred.entries[0].aborted, true);
  assert.equal(deferred.entries.length, 2);
  assert.equal(deferred.maxActive, 1);
  deferred.entries[1].resolve("restarted");
  assert.equal(await second, "restarted");
});

test("a pre-aborted subscriber never starts shared work", async () => {
  const deferred = deferredOperation();
  const run = createSharedAbortableOperation(deferred.operation);
  const controller = new AbortController();
  controller.abort(new DOMException("already gone", "AbortError"));
  await assert.rejects(run(controller.signal), { name: "AbortError" });
  assert.equal(deferred.entries.length, 0);
});
