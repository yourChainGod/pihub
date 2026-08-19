import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const DEVICE_ID = `dev_${"L".repeat(22)}`;
const PROVIDER_PARAMS = { params: Promise.resolve({ provider: "openai" }) };

function headers(capability) {
  return {
    "x-pihub-authenticated-device": DEVICE_ID,
    "x-pihub-authenticated-capabilities": capability,
  };
}

function request(pathname, method, capability) {
  return new Request(`http://localhost:30141${pathname}`, {
    method,
    ...(capability ? { headers: headers(capability) } : {}),
  });
}

function assertPrivate(response) {
  const policy = response.headers.get("cache-control") ?? "";
  assert.match(policy, /\bprivate\b/);
  assert.match(policy, /\bno-store\b/);
}

const routeDefinitions = [
  {
    path: "./auth/all-providers/route.ts",
    methods: [{ name: "GET", capability: "providers:manage", pathname: "/api/auth/all-providers" }],
  },
  {
    path: "./auth/providers/route.ts",
    methods: [{ name: "GET", capability: "providers:manage", pathname: "/api/auth/providers" }],
  },
  {
    path: "./auth/api-key/[provider]/route.ts",
    params: PROVIDER_PARAMS,
    methods: [
      { name: "GET", capability: "providers:manage", pathname: "/api/auth/api-key/openai" },
      { name: "POST", capability: "providers:manage", pathname: "/api/auth/api-key/openai" },
      { name: "DELETE", capability: "providers:manage", pathname: "/api/auth/api-key/openai" },
    ],
  },
  {
    path: "./auth/logout/[provider]/route.ts",
    params: PROVIDER_PARAMS,
    methods: [{ name: "POST", capability: "providers:manage", pathname: "/api/auth/logout/openai" }],
  },
  {
    path: "./models-config/route.ts",
    methods: [
      { name: "GET", capability: "models:read", pathname: "/api/models-config" },
      { name: "PUT", capability: "models:manage", pathname: "/api/models-config" },
    ],
  },
  {
    path: "./models-config/catalog/route.ts",
    methods: [{ name: "GET", capability: "models:read", pathname: "/api/models-config/catalog" }],
  },
  {
    path: "./models-config/discover/route.ts",
    methods: [{ name: "POST", capability: "models:manage", pathname: "/api/models-config/discover" }],
  },
  {
    path: "./models-config/test/route.ts",
    methods: [{ name: "POST", capability: "models:manage", pathname: "/api/models-config/test" }],
  },
  {
    path: "./pihub/newapi/route.ts",
    methods: [
      { name: "GET", capability: "models:read", pathname: "/api/pihub/newapi" },
      { name: "POST", capability: "models:manage", pathname: "/api/pihub/newapi" },
    ],
  },
  {
    path: "./pihub/setup/route.ts",
    methods: [
      { name: "GET", capability: "system:manage", pathname: "/api/pihub/setup" },
      { name: "POST", capability: "system:manage", pathname: "/api/pihub/setup" },
    ],
  },
];

test("legacy provider, model, and setup routes enforce route-level capabilities", async () => {
  for (const definition of routeDefinitions) {
    const source = await readFile(new URL(definition.path, import.meta.url), "utf8");
    assert.match(source, /requirePihubRouteCapability\(/, definition.path);
    assert.match(source, /privateRouteJson\(/, definition.path);

    const route = await jiti.import(definition.path);
    for (const method of definition.methods) {
      const invoke = (capability) => route[method.name](
        request(method.pathname, method.name, capability),
        definition.params,
      );
      const unauthenticated = await invoke(undefined);
      assert.equal(unauthenticated.status, 401, `${method.name} ${method.pathname}`);
      assertPrivate(unauthenticated);

      const forbidden = await invoke(
        method.capability === "models:read" ? "models:manage" : "devices:manage",
      );
      assert.equal(forbidden.status, 403, `${method.name} ${method.pathname}`);
      assertPrivate(forbidden);
    }
  }
});

test("external catalog and NewAPI refresh are bounded and cannot load caller-selected projects", async () => {
  const catalog = await readFile(new URL("./models-config/catalog/route.ts", import.meta.url), "utf8");
  assert.match(catalog, /fetchOutboundJson\(/);
  assert.match(catalog, /maxResponseBytes: MAX_CATALOG_BYTES/);
  assert.match(catalog, /entries\.length > MAX_CATALOG_ENTRIES/);
  assert.doesNotMatch(catalog, /response\.json\(\)/);

  const newApi = await readFile(new URL("./pihub/newapi/route.ts", import.meta.url), "utf8");
  assert.match(newApi, /cwd: process\.cwd\(\)/);
  assert.match(newApi, /noExtensions: true/);
  assert.match(newApi, /noContextFiles: true/);
  assert.match(newApi, /readBoundedJsonRequest\(req, 64 \* 1024\)/);
  assert.doesNotMatch(newApi, /body\.cwd/);
  assert.doesNotMatch(newApi, /error: String\(error\)/);
});

test("credential routes do not reflect provider runtime errors", async () => {
  for (const relative of [
    "./auth/api-key/[provider]/route.ts",
    "./auth/logout/[provider]/route.ts",
    "./auth/all-providers/route.ts",
    "./auth/providers/route.ts",
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(source, /error:\s*(?:String\(error\)|error\.message)/, relative);
    assert.doesNotMatch(source, /Unknown provider:\s*\$\{provider\}/, relative);
  }
});
