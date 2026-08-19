import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { requireOwnedSession } = await jiti.import("./session-access.ts");
const { bindSessionOwner } = await jiti.import("./session-ownership.ts");

const SESSION_ID = "70000000-0000-4000-8000-000000000001";
const UNBOUND_ID = "70000000-0000-4000-8000-000000000002";
const OWNER_ID = `dev_${"A".repeat(22)}`;
const OTHER_OWNER_ID = `dev_${"B".repeat(22)}`;

function request(deviceId, capabilities = "sessions:read") {
  return new Request("http://localhost/api/sessions/id", {
    headers: deviceId ? {
      "x-pihub-authenticated-device": deviceId,
      "x-pihub-authenticated-capabilities": capabilities,
    } : undefined,
  });
}

test("session access distinguishes authentication and capability failures but hides ownership", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pihub-session-access-"));
  const previousOwnershipPath = process.env.PIHUB_SESSION_OWNERSHIP_PATH;
  process.env.PIHUB_SESSION_OWNERSHIP_PATH = join(root, "session-ownership.json");
  t.after(() => {
    if (previousOwnershipPath === undefined) delete process.env.PIHUB_SESSION_OWNERSHIP_PATH;
    else process.env.PIHUB_SESSION_OWNERSHIP_PATH = previousOwnershipPath;
    rmSync(root, { recursive: true, force: true });
  });
  await bindSessionOwner(SESSION_ID, OWNER_ID);

  const missing = requireOwnedSession(request(), SESSION_ID, "sessions:read");
  const denied = requireOwnedSession(request(OWNER_ID, "agents:use"), SESSION_ID, "sessions:read");
  const foreign = requireOwnedSession(request(OTHER_OWNER_ID), SESSION_ID, "sessions:read");
  const unbound = requireOwnedSession(request(OWNER_ID), UNBOUND_ID, "sessions:read");
  const malformed = requireOwnedSession(request(OWNER_ID), "../not-a-session", "sessions:read");
  const owned = requireOwnedSession(request(OWNER_ID), SESSION_ID, "sessions:read");

  assert.equal(missing.response.status, 401);
  assert.match(missing.response.headers.get("www-authenticate") ?? "", /PiHub-HMAC-SHA256/);
  assert.equal(denied.response.status, 403);
  assert.equal(foreign.response.status, 404);
  assert.equal(unbound.response.status, 404);
  assert.equal(malformed.response.status, 404);
  for (const result of [missing, denied, foreign, unbound, malformed]) {
    assert.match(result.response.headers.get("cache-control") ?? "", /no-store/);
  }
  assert.equal(owned.context.deviceId, OWNER_ID);

  writeFileSync(process.env.PIHUB_SESSION_OWNERSHIP_PATH, "{corrupt\n");
  const unavailable = requireOwnedSession(request(OWNER_ID), SESSION_ID, "sessions:read");
  assert.equal(unavailable.response.status, 503);
  assert.match(unavailable.response.headers.get("cache-control") ?? "", /no-store/);
});
