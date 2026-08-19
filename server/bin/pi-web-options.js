"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

function normalizePort(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Port must be a positive integer.");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be between 1 and 65535.");
  }

  return String(port);
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      "no-open": { type: "boolean" },
    },
    strict: false,
  });

  const requestedHostname = cliArgs.hostname ?? env.PI_WEB_HOSTNAME ?? "127.0.0.1";
  if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(requestedHostname)) {
    throw new Error("PiHub server is Tailnet-only and must bind to loopback. Use tailscale serve instead of --hostname.");
  }

  return {
      port: normalizePort(cliArgs.port ?? env.PORT ?? "30141"),
      hostname: "127.0.0.1",
      openBrowser: !cliArgs["no-open"] && !isEnabled(env.PI_WEB_NO_OPEN),
    };
}

module.exports = { parseLaunchOptions };
