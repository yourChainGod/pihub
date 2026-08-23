#!/usr/bin/env node
"use strict";

/**
 * PiHub node connector: keeps this node's outbound WSS link to the NATS relay
 * and replays relayed traffic to the loopback PiHub server. Runs as a
 * supervised child of bin/pihub-server.js; exits 0 when no connector.json is
 * configured so the supervisor leaves it alone on relay-less installs.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

const { createJiti } = require("jiti");
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

async function main() {
  const jiti = createJiti(__filename, { interopDefault: true });
  const { getServerUpdateDataRoot } = await jiti.import("../lib/server-update-runtime.ts");
  const { loadConnectorConfig, createConnector } = await jiti.import("../lib/connector.ts");
  const dataRoot = getServerUpdateDataRoot({ platform: process.platform });
  const config = loadConnectorConfig(dataRoot);
  if (!config) {
    console.log("pihub-connector: 未配置 state/connector.json，节点不接入 relay。");
    return;
  }

  const { wsconnect } = require("@nats-io/nats-core");
  const connector = await createConnector({
    config,
    connect: (cfg) => wsconnect({
      servers: cfg.relayUrl,
      user: cfg.user,
      pass: cfg.token,
      name: `pihub-connector-${cfg.nodeId}`,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2_000,
    }),
  });

  const shutdown = () => {
    void connector.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  // Never log the config itself: it carries the relay token.
  console.error(`pihub-connector: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
