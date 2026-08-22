import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseLaunchOptions } = require("../bin/pi-web-options.js");

test("opens the browser by default", () => {
  assert.deepEqual(parseLaunchOptions([], {}), {
    port: "30141",
    hostname: "127.0.0.1",
    openBrowser: true,
  });
});

test("supports the no-open CLI option", () => {
  assert.equal(parseLaunchOptions(["--no-open"], {}).openBrowser, false);
});

test("supports truthy PIHUB_SERVER_NO_OPEN values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseLaunchOptions([], { PIHUB_SERVER_NO_OPEN: value }).openBrowser, false);
  }
});

test("does not disable browser opening for false PIHUB_SERVER_NO_OPEN values", () => {
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(parseLaunchOptions([], { PIHUB_SERVER_NO_OPEN: value }).openBrowser, true);
  }
});

test("falls back to legacy PI_WEB_NO_OPEN when PIHUB_SERVER_NO_OPEN is unset", () => {
  assert.equal(parseLaunchOptions([], { PI_WEB_NO_OPEN: "1" }).openBrowser, false);
  // The preferred variable wins when both are set.
  assert.equal(
    parseLaunchOptions([], { PIHUB_SERVER_NO_OPEN: "0", PI_WEB_NO_OPEN: "1" }).openBrowser,
    true,
  );
});

test("preserves port but rejects non-loopback hostname options", () => {
  assert.equal(parseLaunchOptions(["-p", "8080"], {}).port, "8080");
  assert.throws(() => parseLaunchOptions(["-H", "0.0.0.0"], {}), /Tailnet-only/);
});

test("rejects port values that could inject cmd arguments", () => {
  assert.throws(
    () => parseLaunchOptions(["-p", "30141&whoami"], {}),
    /Port must be a positive integer/,
  );
  assert.throws(
    () => parseLaunchOptions([], { PORT: "30141&whoami" }),
    /Port must be a positive integer/,
  );
  assert.throws(() => parseLaunchOptions(["-p", "0"], {}), /Port must be between 1 and 65535/);
});

test("rejects PIHUB_SERVER_HOSTNAME outside loopback without trusting ambient HOSTNAME", () => {
  assert.equal(
    parseLaunchOptions([], { HOSTNAME: "container-id" }).hostname,
    "127.0.0.1",
  );
  assert.throws(() => parseLaunchOptions([], { PIHUB_SERVER_HOSTNAME: "0.0.0.0" }), /Tailnet-only/);
});

test("falls back to legacy PI_WEB_HOSTNAME when PIHUB_SERVER_HOSTNAME is unset", () => {
  assert.throws(() => parseLaunchOptions([], { PI_WEB_HOSTNAME: "0.0.0.0" }), /Tailnet-only/);
  // The preferred variable wins when both are set.
  assert.throws(
    () => parseLaunchOptions([], { PIHUB_SERVER_HOSTNAME: "0.0.0.0", PI_WEB_HOSTNAME: "127.0.0.1" }),
    /Tailnet-only/,
  );
});
