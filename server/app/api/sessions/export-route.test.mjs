import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[id]/export/route.ts", import.meta.url), "utf8");

test("session exports keep their inline UI inside an opaque offline sandbox", () => {
  assert.match(source, /sandbox allow-scripts allow-downloads/);
  assert.doesNotMatch(source, /sandbox[^";]*allow-same-origin/);
  assert.match(source, /script-src 'unsafe-inline'/);
  assert.match(source, /connect-src 'none'/);
  assert.match(source, /object-src 'none'/);
  assert.match(source, /form-action 'none'/);
  assert.match(source, /"Cross-Origin-Opener-Policy": "same-origin"/);
  assert.match(source, /"Referrer-Policy": "no-referrer"/);
  assert.match(source, /pihubNoStoreHeaders\(/);
});
