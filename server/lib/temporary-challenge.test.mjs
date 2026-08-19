import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  TemporaryChallengeCapacityError,
  TemporaryChallengeError,
  TemporaryChallengeRegistry,
} = await jiti.import("./temporary-challenge.ts");

function tokenFactory() {
  let next = 0;
  return () => {
    next += 1;
    return `${"A".repeat(35)}${String(next).padStart(8, "0")}`;
  };
}

test("default challenges use opaque 256-bit base64url tokens", async () => {
  const registry = new TemporaryChallengeRegistry();
  const first = registry.create("device-a", "provider-a");
  const second = registry.create("device-a", "provider-b");
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.token, second.token);
  first.cancel();
  second.cancel();
  await Promise.allSettled([first.promise, second.promise]);
});

test("wrong device or provider cannot consume another flow's challenge", async () => {
  const registry = new TemporaryChallengeRegistry({ createToken: tokenFactory() });
  const challenge = registry.create("device-a", "provider-a");
  assert.equal(
    registry.consume(challenge.token, "device-b", "provider-a", "forged"),
    "forbidden",
  );
  assert.equal(
    registry.consume(challenge.token, "device-a", "provider-b", "forged"),
    "forbidden",
  );
  assert.equal(registry.stats().pending, 1);

  assert.equal(
    registry.consume(challenge.token, "device-a", "provider-a", "valid-code"),
    "consumed",
  );
  assert.equal(await challenge.promise, "valid-code");
  assert.equal(registry.stats().pending, 0);
  assert.equal(
    registry.consume(challenge.token, "device-a", "provider-a", "replay"),
    "replayed",
  );
  assert.equal(
    registry.consume(challenge.token, "device-b", "provider-a", "replay"),
    "forbidden",
  );
});

test("expired challenges reject waiters and retain a bounded expiry result", async () => {
  let now = 1_000;
  const registry = new TemporaryChallengeRegistry({
    challengeTtlMs: 100,
    tombstoneTtlMs: 200,
    createToken: tokenFactory(),
    now: () => now,
  });
  const challenge = registry.create("device-a", "provider-a");
  now = 1_101;
  assert.equal(
    registry.consume(challenge.token, "device-a", "provider-a", "late"),
    "expired",
  );
  await assert.rejects(challenge.promise, (error) => (
    error instanceof TemporaryChallengeError && error.code === "expired"
  ));
  assert.equal(
    registry.consume(challenge.token, "device-a", "provider-a", "late-again"),
    "expired",
  );
  now = 1_302;
  assert.equal(registry.stats().tombstones, 0);
  assert.equal(
    registry.consume(challenge.token, "device-a", "provider-a", "too-late"),
    "not_found",
  );
});

test("enforces global, device, and device-provider pending limits", async () => {
  const registry = new TemporaryChallengeRegistry({
    createToken: tokenFactory(),
    maxPending: 3,
    maxPendingPerDevice: 2,
    maxPendingPerScope: 1,
  });
  const first = registry.create("device-a", "provider-a");
  assert.throws(
    () => registry.create("device-a", "provider-a"),
    TemporaryChallengeCapacityError,
  );
  const second = registry.create("device-a", "provider-b");
  assert.throws(
    () => registry.create("device-a", "provider-c"),
    TemporaryChallengeCapacityError,
  );
  const third = registry.create("device-b", "provider-a");
  assert.throws(
    () => registry.create("device-c", "provider-a"),
    TemporaryChallengeCapacityError,
  );

  first.cancel();
  const replacement = registry.create("device-a", "provider-c");
  for (const challenge of [second, third, replacement]) challenge.cancel();
  await Promise.allSettled([
    first.promise,
    second.promise,
    third.promise,
    replacement.promise,
  ]);
  assert.equal(registry.stats().pending, 0);
});

test("flow leases enforce all concurrency layers and release idempotently", () => {
  const registry = new TemporaryChallengeRegistry({
    maxFlows: 3,
    maxFlowsPerDevice: 2,
    maxFlowsPerScope: 1,
  });
  const first = registry.acquireFlow("device-a", "provider-a");
  assert.ok(first);
  assert.equal(registry.acquireFlow("device-a", "provider-a"), null);
  const second = registry.acquireFlow("device-a", "provider-b");
  assert.ok(second);
  assert.equal(registry.acquireFlow("device-a", "provider-c"), null);
  const third = registry.acquireFlow("device-b", "provider-a");
  assert.ok(third);
  assert.equal(registry.acquireFlow("device-c", "provider-a"), null);
  assert.equal(registry.stats().flows, 3);

  first.release();
  first.release();
  assert.equal(first.released, true);
  const replacement = registry.acquireFlow("device-a", "provider-c");
  assert.ok(replacement);
  second.release();
  third.release();
  replacement.release();
  assert.equal(registry.stats().flows, 0);
});

test("cancel is idempotent and clears pending counters", async () => {
  const registry = new TemporaryChallengeRegistry({ createToken: tokenFactory() });
  const challenge = registry.create("device-a", "provider-a");
  const rejection = assert.rejects(challenge.promise, (error) => (
    error instanceof TemporaryChallengeError && error.code === "cancelled"
  ));
  challenge.cancel();
  challenge.cancel(new Error("second cancel"));
  await rejection;
  assert.deepEqual(registry.stats(), { pending: 0, tombstones: 1, flows: 0 });
  assert.equal(
    registry.consume(challenge.token, "device-a", "provider-a", "late"),
    "not_found",
  );
});

test("tombstones are finite and registry reset clears timers, promises, and leases", async () => {
  const registry = new TemporaryChallengeRegistry({
    createToken: tokenFactory(),
    maxTombstones: 2,
  });
  for (let index = 0; index < 3; index += 1) {
    const challenge = registry.create(`device-${index}`, "provider-a");
    assert.equal(
      registry.consume(challenge.token, `device-${index}`, "provider-a", "ok"),
      "consumed",
    );
    assert.equal(await challenge.promise, "ok");
  }
  assert.equal(registry.stats().tombstones, 2);

  const pending = registry.create("device-reset", "provider-reset");
  const lease = registry.acquireFlow("device-reset", "provider-reset");
  assert.ok(lease);
  registry.reset();
  await assert.rejects(pending.promise, (error) => (
    error instanceof TemporaryChallengeError && error.code === "reset"
  ));
  assert.deepEqual(registry.stats(), { pending: 0, tombstones: 0, flows: 0 });
  lease.release();
  assert.equal(registry.stats().flows, 0);
});
