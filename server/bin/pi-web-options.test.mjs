import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseLaunchOptions } = require("./pi-web-options.js");

test("normalizes every accepted loopback alias to the supervisor health address", () => {
  for (const hostname of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
    assert.deepEqual(parseLaunchOptions(["--hostname", hostname, "--port", "30141", "--no-open"], {}), {
      hostname: "127.0.0.1",
      openBrowser: false,
      port: "30141",
    });
  }
});

test("rejects dynamic, out-of-range, and non-loopback listener configuration", () => {
  for (const port of ["0", "65536", "-1", "3.5", ""] ) {
    assert.throws(() => parseLaunchOptions(["--port", port], {}), /Port must/);
  }
  for (const hostname of ["0.0.0.0", "192.168.1.2", "example.com"]) {
    assert.throws(() => parseLaunchOptions(["--hostname", hostname], {}), /must bind to loopback/);
  }
});
