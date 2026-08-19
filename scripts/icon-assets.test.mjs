import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("platform icons are generated from the reviewed pi SVG", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-icon-assets.mjs"], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /pi mark clear at 16\/32px/);
});
