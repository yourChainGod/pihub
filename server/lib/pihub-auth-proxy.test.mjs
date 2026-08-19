import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const PUBLIC_API = new Set(["GET /api/health", "POST /api/pairing/claim"]);

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const auth = await jiti.import("./pihub-auth.ts");
const store = await jiti.import("./pihub-auth-store.ts");

function walkRoutes(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkRoutes(absolute));
    else if (entry.isFile() && entry.name === "route.ts") result.push(absolute);
  }
  return result;
}

function isExported(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function exportedHttpMethods(file) {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods = new Set();
  for (const statement of sourceFile.statements) {
    if (!isExported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name && HTTP_METHODS.has(statement.name.text)) {
      methods.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && HTTP_METHODS.has(declaration.name.text)) {
          methods.add(declaration.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (HTTP_METHODS.has(element.name.text)) methods.add(element.name.text);
      }
    }
  }
  return [...methods].sort();
}

function routePath(file) {
  const relative = path.relative(path.join(process.cwd(), "app"), path.dirname(file));
  return `/${relative.split(path.sep).map((segment) => {
    if (segment.startsWith("[[...")) return "test";
    if (segment.startsWith("[...")) return "test/path";
    if (segment.startsWith("[")) return "test";
    return segment;
  }).join("/")}`;
}

test("every actual API method has one fail-closed policy and rejects a wrong capability", async (t) => {
  const apiRoot = path.join(process.cwd(), "app", "api");
  const discovered = [];
  for (const file of walkRoutes(apiRoot)) {
    const pathname = routePath(file);
    for (const method of exportedHttpMethods(file)) discovered.push({ file, method, pathname });
  }

  assert.ok(discovered.length > 40, "expected to inspect the complete API route tree");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-route-policy-"));
  const statePath = path.join(root, "auth.json");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provision = async (capability) => {
    const pairing = await store.issuePihubPairingCode({ capabilities: [capability] }, { statePath });
    const device = await store.claimPihubPairingCode(pairing.code, { statePath });
    assert.ok(device);
    return device;
  };
  const sessionsDevice = await provision("sessions:read");
  const managerDevice = await provision("devices:manage");
  const previousPath = process.env.PIHUB_AUTH_STATE_PATH;
  process.env.PIHUB_AUTH_STATE_PATH = statePath;
  auth.resetPihubAuthRuntimeForTests();
  t.after(() => {
    if (previousPath === undefined) delete process.env.PIHUB_AUTH_STATE_PATH;
    else process.env.PIHUB_AUTH_STATE_PATH = previousPath;
    auth.resetPihubAuthRuntimeForTests();
  });

  for (const { file, method, pathname } of discovered) {
    const policy = auth.resolvePihubApiPolicy(method, pathname);
    assert.ok(policy, `${method} ${pathname} from ${file} has no unique API policy`);
    const response = await proxy(new NextRequest(`http://localhost:30141${pathname}`, {
      method,
      headers: { host: "localhost:30141" },
    }));
    const route = `${method} ${pathname}`;
    if (PUBLIC_API.has(route)) {
      assert.equal(policy.access, "public");
      assert.equal(response.status, 200, `${route} from ${file} should be public`);
      assert.equal(response.headers.get("x-middleware-next"), "1");
    } else {
      assert.equal(policy.access, "protected");
      assert.equal(response.status, 401, `${route} from ${file} accepted an unauthenticated request`);
      assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");

      const wrongDevice = policy.capability === "sessions:read" ? managerDevice : sessionsDevice;
      const mutationHeaders = method === "GET" || method === "HEAD"
        ? {}
        : { "x-pihub-content-sha256": auth.PIHUB_EMPTY_CONTENT_SHA256 };
      const authorization = auth.createPihubAuthorization({
        method,
        url: `http://localhost:30141${pathname}`,
        deviceId: wrongDevice.id,
        secret: wrongDevice.secret,
        nonce: randomBytes(18).toString("base64url"),
      });
      const forbidden = await proxy(new NextRequest(`http://localhost:30141${pathname}`, {
        method,
        headers: { host: "localhost:30141", authorization, ...mutationHeaders },
      }));
      assert.equal(forbidden.status, 403, `${route} did not enforce ${policy.capability}`);
    }
  }

  assert.deepEqual(
    discovered.filter(({ method, pathname }) => PUBLIC_API.has(`${method} ${pathname}`))
      .map(({ method, pathname }) => `${method} ${pathname}`)
      .sort(),
    [...PUBLIC_API].sort(),
    "the public API allowlist must correspond to real route exports",
  );
});
