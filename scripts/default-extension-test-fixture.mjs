import fs from "node:fs";
import path from "node:path";

import {
  canonicalExtensionJson,
  createDefaultExtensionInventory,
  createDefaultExtensionNotices,
  DEFAULT_EXTENSION_HOST_PI_PACKAGES,
  DEFAULT_EXTENSION_HOST_PI_VERSION,
  DEFAULT_EXTENSION_NOTICE_FILE,
  DEFAULT_EXTENSION_PACKAGES,
  DEFAULT_EXTENSION_RESOURCE_LAYOUT,
  DEFAULT_EXTENSION_SOURCE_DIRECTORY,
  verifyDefaultExtensionBundle,
} from "./default-extension-bundle.mjs";

const PI_PEERS = Object.freeze({
  "@cortexkit/pi-magic-context": {
    "@earendil-works/pi-coding-agent": "^0.80.2",
    "@earendil-works/pi-tui": "^0.80.2",
  },
  "pi-todo-rail": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    typebox: "*",
  },
  "@ff-labs/pi-fff": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  },
  "pi-simplify": {
    "@earendil-works/pi-ai": ">=0.74.0",
    "@earendil-works/pi-coding-agent": ">=0.74.0",
    "@earendil-works/pi-tui": ">=0.74.0",
  },
  "@gotgenes/pi-permission-system": {
    "@earendil-works/pi-coding-agent": ">=0.79.0",
    "@earendil-works/pi-tui": ">=0.79.0",
  },
  "@eko24ive/pi-ask": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  },
  "@gotgenes/pi-subagents": {
    "@earendil-works/pi-ai": ">=0.75.0",
    "@earendil-works/pi-coding-agent": ">=0.80.5",
    "@earendil-works/pi-tui": ">=0.75.0",
  },
});

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function packageDirectory(root, packageName) {
  return path.join(root, "node_modules", ...packageName.split("/"));
}

export async function addDefaultExtensionFixture(serverRoot, { version } = {}) {
  const extensionsVersion = version
    ?? (JSON.parse(fs.readFileSync(path.join(DEFAULT_EXTENSION_SOURCE_DIRECTORY, "package.json"), "utf8"))).version;
  const manifestPath = path.join(serverRoot, "package.json");
  const serverManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  serverManifest.dependencies = {
    ...(serverManifest.dependencies ?? {}),
    ...Object.fromEntries(
      DEFAULT_EXTENSION_HOST_PI_PACKAGES.map((name) => [name, DEFAULT_EXTENSION_HOST_PI_VERSION]),
    ),
  };
  writeJson(manifestPath, serverManifest);

  for (const packageName of DEFAULT_EXTENSION_HOST_PI_PACKAGES) {
    writeJson(path.join(packageDirectory(serverRoot, packageName), "package.json"), {
      name: packageName,
      version: DEFAULT_EXTENSION_HOST_PI_VERSION,
    });
  }

  const extensionRoot = path.join(serverRoot, "extensions");
  fs.mkdirSync(extensionRoot);
  for (const name of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(DEFAULT_EXTENSION_SOURCE_DIRECTORY, name), path.join(extensionRoot, name));
  }

  for (const extension of DEFAULT_EXTENSION_PACKAGES) {
    const root = packageDirectory(extensionRoot, extension.name);
    writeJson(path.join(root, "package.json"), {
      name: extension.name,
      version: extension.version,
      license: "MIT",
      peerDependencies: PI_PEERS[extension.name],
    });
    for (const resources of Object.values(DEFAULT_EXTENSION_RESOURCE_LAYOUT[extension.name])) {
      for (const relative of resources) {
        const target = path.join(root, ...relative.split("/"));
        if (path.extname(relative)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, "export default function fixture() {}\n");
        } else {
          fs.mkdirSync(path.join(target, "fixture"), { recursive: true });
          fs.writeFileSync(path.join(target, "fixture", "SKILL.md"), "# Fixture\n");
        }
      }
    }
  }

  const treeSitterRoot = packageDirectory(extensionRoot, "tree-sitter-bash");
  writeJson(path.join(treeSitterRoot, "package.json"), {
    name: "tree-sitter-bash",
    version: "0.25.1",
    license: "MIT",
  });
  fs.writeFileSync(path.join(treeSitterRoot, "tree-sitter-bash.wasm"), "fixture wasm");

  const onnxRoot = packageDirectory(extensionRoot, "onnxruntime-node");
  writeJson(path.join(onnxRoot, "package.json"), {
    name: "onnxruntime-node",
    version: "1.24.3",
    license: "MIT",
    scripts: { postinstall: "node ./script/install" },
  });

  const sharpRoot = packageDirectory(extensionRoot, "sharp");
  writeJson(path.join(sharpRoot, "package.json"), {
    name: "sharp",
    version: "0.34.5",
    license: "Apache-2.0",
    scripts: { install: "node install/check.js || npm run build" },
  });

  const inventory = await createDefaultExtensionInventory(extensionRoot);
  fs.writeFileSync(path.join(extensionRoot, "inventory.json"), canonicalExtensionJson(inventory));
  const verification = await verifyDefaultExtensionBundle(extensionRoot, {
    expectedVersion: extensionsVersion,
    serverRoot,
  });
  fs.writeFileSync(
    path.join(serverRoot, DEFAULT_EXTENSION_NOTICE_FILE),
    createDefaultExtensionNotices(verification),
  );
  return { extensionRoot, inventory, verification };
}
