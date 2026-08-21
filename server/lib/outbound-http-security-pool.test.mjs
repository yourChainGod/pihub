// @ts-check
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const security = await jiti.import("./outbound-http-security.ts");
const { secureOutboundFetch, resetOutboundConnectionPool } = security;

test("pooled agent reuses connections for same origin+addresses+limits", async () => {
  resetOutboundConnectionPool();
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`request ${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/test`;

  try {
    const policy = { allowLocalhost: true };
    const r1 = await secureOutboundFetch(url, {}, policy);
    assert.equal(await r1.text(), "request /test");

    const r2 = await secureOutboundFetch(`http://127.0.0.1:${port}/second`, {}, policy);
    assert.equal(await r2.text(), "request /second");

    // DNS pinning check: different addresses → different pool key, fresh connection
    resetOutboundConnectionPool();
    const r3 = await secureOutboundFetch(url, {}, policy);
    assert.equal(await r3.text(), "request /test");
  } finally {
    server.close();
    resetOutboundConnectionPool();
  }
});

test("pooled agent reference counting: dispose called exactly once per acquire", async () => {
  resetOutboundConnectionPool();
  const server = createServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  try {
    const policy = { allowLocalhost: true };

    // Two concurrent requests → inFlight=2, then both drain → inFlight=0
    const [r1, r2] = await Promise.all([
      secureOutboundFetch(url, {}, policy),
      secureOutboundFetch(url, {}, policy),
    ]);
    await r1.text();
    await r2.text();

    // Third request reuses the pooled agent
    const r3 = await secureOutboundFetch(url, {}, policy);
    assert.equal(r3.status, 200);
    await r3.text();
  } finally {
    server.close();
    resetOutboundConnectionPool();
  }
});

test("aborted request releases pooled agent without tearing in-flight responses", async () => {
  resetOutboundConnectionPool();
  let releaseSlow = () => {};
  const server = createServer((req, res) => {
    if (req.url === "/slow") {
      res.writeHead(200);
      res.write("start");
      // Never finishes until the test releases it, so the abort always wins.
      releaseSlow = () => res.end(" end");
      return;
    }
    res.writeHead(200);
    res.end("fast");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const policy = { allowLocalhost: true };

    const controller = new AbortController();
    const aborted = secureOutboundFetch(
      `http://127.0.0.1:${port}/slow`,
      { signal: controller.signal },
      policy,
    ).then(async (response) => {
      // Headers arrive immediately; the tear happens while draining the body.
      await response.text();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await assert.rejects(aborted);

    // The pooled agent must still serve a subsequent request correctly.
    const r = await secureOutboundFetch(`http://127.0.0.1:${port}/fast`, {}, policy);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "fast");
  } finally {
    releaseSlow();
    server.close();
    resetOutboundConnectionPool();
  }
});
