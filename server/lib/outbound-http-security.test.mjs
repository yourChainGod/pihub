import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const security = await jiti.import("./outbound-http-security.ts");

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

test("canonical outbound URLs default to HTTPS and reject URL smuggling", () => {
  assert.equal(security.canonicalizeOutboundUrl("api.example.com/v1").toString(), "https://api.example.com/v1");
  for (const url of [
    "http://api.example.com/v1",
    "https://user:secret@api.example.com/v1",
    "https://api.example.com/v1#fragment",
    "https://api.example.com/v1\nInjected: yes",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => security.canonicalizeOutboundUrl(url), security.OutboundRequestError);
  }
});

test("configured base URLs reject query credentials and private IP literals", () => {
  assert.equal(
    security.canonicalizeOutboundBaseUrl("api.example.com/v1/").toString(),
    "https://api.example.com/v1/",
  );
  for (const url of [
    "https://api.example.com/v1?token=secret",
    "https://127.0.0.1/v1",
    "https://169.254.169.254/latest/meta-data",
  ]) {
    assert.throws(() => security.canonicalizeOutboundBaseUrl(url), security.OutboundRequestError);
  }
});

test("localhost is available only through the explicit development policy", async () => {
  for (const url of ["http://localhost:11434/v1", "https://127.0.0.1:11434/v1", "http://[::1]:11434/v1"]) {
    assert.throws(() => security.canonicalizeOutboundBaseUrl(url), (error) => error.code === "forbidden_target" || error.code === "invalid_url");
    assert.doesNotThrow(() => security.canonicalizeOutboundBaseUrl(url, { allowLocalhost: true }));
  }

  const allowed = await security.assertOutboundUrlAllowed("http://localhost:11434/v1", {
    allowLocalhost: true,
    __test: { resolver: async () => [{ address: "127.0.0.1", family: 4 }] },
  });
  assert.equal(allowed.protocol, "http:");

  await assert.rejects(() => security.assertOutboundUrlAllowed("https://attacker.example/v1", {
    allowLocalhost: true,
    __test: { resolver: async () => [{ address: "127.0.0.1", family: 4 }] },
  }), (error) => error.code === "forbidden_target");
  await assert.rejects(() => security.assertOutboundUrlAllowed("https://dev.localhost/v1", {
    allowLocalhost: true,
    __test: { resolver: publicDns },
  }), (error) => error.code === "forbidden_target");
});

test("address classification blocks metadata, loopback, private and documentation ranges", () => {
  for (const address of [
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1",
    "192.168.1.1", "198.18.0.1", "203.0.113.4", "::1", "fe80::1", "::ffff:127.0.0.1",
  ]) {
    assert.equal(security.classifyOutboundAddress(address), "blocked", address);
  }
  assert.equal(security.classifyOutboundAddress("100.64.0.1"), "tailnet");
  assert.equal(security.classifyOutboundAddress("fd7a:115c:a1e0::1"), "tailnet");
  assert.equal(security.classifyOutboundAddress("93.184.216.34"), "public");
  assert.equal(security.classifyOutboundAddress("2606:2800:220:1:248:1893:25c8:1946"), "public");
});

test("DNS results are all checked and Tailnet access requires an explicit exception", async () => {
  await assert.rejects(() => security.assertOutboundUrlAllowed("https://mixed.example", {
    __test: { resolver: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] },
  }), (error) => error.code === "forbidden_target");

  await assert.rejects(() => security.assertOutboundUrlAllowed("https://gateway.tailnet", {
    __test: { resolver: async () => [{ address: "100.100.10.20", family: 4 }] },
  }), (error) => error.code === "forbidden_target");
  assert.equal((await security.assertOutboundUrlAllowed("http://gateway.tailnet", {
    allowTailnet: true,
    __test: { resolver: async () => [{ address: "100.100.10.20", family: 4 }] },
  })).protocol, "http:");
});

test("credential and header validation rejects command and environment resolution syntax", () => {
  for (const value of ["!touch /tmp/pwned", "$HOME", "prefix-${API_TOKEN}"]) {
    assert.throws(() => security.assertLiteralCredential(value), (error) => error.code === "dynamic_credential");
  }
  assert.throws(() => security.sanitizeOutboundHeaders({ Authorization: "$SECRET" }), (error) => error.code === "dynamic_credential");
  assert.throws(() => security.sanitizeOutboundHeaders({ Host: "metadata.google.internal" }), (error) => error.code === "invalid_input");
  assert.deepEqual(security.sanitizeOutboundHeaders({ "X-API-Key": "literal-token" }), { "x-api-key": "literal-token" });
});

test("cross-origin redirects never forward headers or request bodies", async () => {
  const requested = [];
  await assert.rejects(() => security.secureOutboundFetch("https://api.example/v1/models", {
    method: "POST",
    body: "prompt-body-canary",
  }, {
    __test: {
      resolver: publicDns,
      transport: async (url, init) => {
        requested.push({ url: String(url), body: init?.body });
        return Response.redirect("https://evil.example/steal", 307);
      },
    },
  }), (error) => error.code === "redirect_blocked");
  assert.deepEqual(requested, [{
    url: "https://api.example/v1/models",
    body: "prompt-body-canary",
  }]);
});

test("each same-origin redirect is re-resolved and rebound private DNS is blocked", async () => {
  let resolutions = 0;
  let requests = 0;
  await assert.rejects(() => security.secureOutboundFetch("https://api.example/v1/models", {}, {
    __test: {
      resolver: async () => {
        resolutions += 1;
        return [{ address: resolutions === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
      },
      transport: async () => {
        requests += 1;
        return Response.redirect("https://api.example/v2/models", 302);
      },
    },
  }), (error) => error.code === "forbidden_target");
  assert.equal(requests, 1);
  assert.equal(resolutions, 2);
});

test("bounded response reader rejects declared and streamed oversized bodies", async () => {
  await assert.rejects(() => security.secureOutboundFetch("https://api.example/models", {}, {
    maxResponseBytes: 8,
    __test: {
      resolver: publicDns,
      transport: async () => new Response("0123456789", { headers: { "Content-Length": "10" } }),
    },
  }), (error) => error.code === "response_too_large");

  const response = await security.secureOutboundFetch("https://api.example/models", {}, {
    maxResponseBytes: 8,
    __test: {
      resolver: publicDns,
      transport: async () => new Response("0123456789"),
    },
  });
  await assert.rejects(() => response.text(), (error) => error.code === "response_too_large");
});

test("streaming mode keeps long active responses alive and enforces body idleness", async () => {
  const activeBody = new ReadableStream({
    start(controller) {
      setTimeout(() => controller.enqueue(new TextEncoder().encode("active")), 30);
      setTimeout(() => controller.close(), 60);
    },
  });
  const active = await security.secureOutboundFetch("https://api.example/stream", {}, {
    timeoutMs: 10,
    idleTimeoutMs: 80,
    streamResponse: true,
    __test: { resolver: publicDns, transport: async () => new Response(activeBody) },
  });
  assert.equal(await active.text(), "active");

  const idle = await security.secureOutboundFetch("https://api.example/stream", {}, {
    timeoutMs: 100,
    idleTimeoutMs: 10,
    streamResponse: true,
    __test: {
      resolver: publicDns,
      transport: async () => new Response(new ReadableStream({ pull: () => new Promise(() => undefined) })),
    },
  });
  await assert.rejects(() => idle.text(), (error) => error.code === "timeout");
});

test("provider responses strip credential headers and query strings", async () => {
  const upstream = new Response("ok", {
    headers: {
      Authorization: "Bearer response-secret",
      "Set-Cookie": "session=response-secret",
      "X-Request-Id": "request-123",
    },
  });
  Object.defineProperty(upstream, "url", {
    value: "https://api.example/v1?api_key=response-secret",
  });
  const response = await security.secureOutboundFetch("https://api.example/v1", {}, {
    __test: { resolver: publicDns, transport: async () => upstream },
  });
  assert.equal(response.headers.get("authorization"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-request-id"), "request-123");
  assert.equal(response.url, "https://api.example/v1");
  assert.equal(await response.text(), "ok");

  const empty = await security.secureOutboundFetch("https://api.example/empty", {}, {
    __test: {
      resolver: publicDns,
      transport: async () => new Response(null, {
        status: 204,
        headers: { "Set-Cookie": "empty-secret", "X-Request-Id": "empty-123" },
      }),
    },
  });
  assert.equal(empty.headers.get("set-cookie"), null);
  assert.equal(empty.headers.get("x-request-id"), "empty-123");
});

test("outbound policy enforces total resolution timeout and request body limits", async () => {
  const keepAlive = setInterval(() => undefined, 100);
  try {
    await assert.rejects(() => security.assertOutboundUrlAllowed("https://slow.example", {
      timeoutMs: 10,
      __test: { resolver: async () => new Promise(() => undefined) },
    }), (error) => error.code === "timeout");
  } finally {
    clearInterval(keepAlive);
  }

  await assert.rejects(() => security.secureOutboundFetch("https://api.example/upload", {
    method: "POST",
    body: "0123456789",
  }, {
    maxRequestBytes: 8,
    __test: { resolver: publicDns, transport: async () => new Response("ok") },
  }), (error) => error.code === "request_too_large");
});

test("outbound errors never echo URL credentials or upstream response bodies", async () => {
  const secret = "secret-canary-value";
  const failure = await security.fetchOutboundJson("https://api.example/models", {
    headers: { Authorization: `Bearer ${secret}` },
  }, {
    __test: {
      resolver: publicDns,
      transport: async () => new Response(`failure includes ${secret}`, { status: 401 }),
    },
  });
  assert.deepEqual({ ok: failure.ok, status: failure.status }, { ok: false, status: 401 });
  assert.equal(JSON.stringify(failure).includes(secret), false);
});
