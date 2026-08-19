#!/usr/bin/env node
"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const INTERNAL_NEXT_SENTINEL = "--pihub-internal-next-runtime-v1";
const packageRoot = path.join(__dirname, "..");

function regularRuntimeFile(parts, description) {
  const file = path.join(packageRoot, ...parts);
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${description} is missing or unsafe`);
  }
  return file;
}

async function runRuntimeEntry(argv = process.argv) {
  if (argv[2] === INTERNAL_NEXT_SENTINEL) {
    argv.splice(2, 1);
    const next = regularRuntimeFile(
      ["node_modules", "next", "dist", "bin", "next"],
      "PiHub Next.js runtime",
    );
    require(next);
    return "server";
  }

  const pi = regularRuntimeFile(
    ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"],
    "PiHub bundled Pi CLI",
  );
  await import(pathToFileURL(pi).href);
  return "pi";
}

if (require.main === module) {
  runRuntimeEntry().catch((error) => {
    console.error(error instanceof Error ? error.message : "PiHub runtime entry failed");
    process.exitCode = 1;
  });
}

module.exports = {
  INTERNAL_NEXT_SENTINEL,
  runRuntimeEntry,
};
