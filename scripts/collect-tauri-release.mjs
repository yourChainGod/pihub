import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DESKTOP_PRODUCT_NAME } from "./product-identity.mjs";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function sha256(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function safeBasename(file) {
  const name = path.basename(file);
  if (name !== file && path.resolve(file) === file) {
    // Absolute input paths are expected; only their basename enters the staging directory.
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()+-]*$/.test(name) || name.includes("..")) {
    throw new Error(`Unsafe desktop release filename: ${name}`);
  }
  return name;
}

const platform = argument("--platform");
const arch = argument("--arch");
const outputDirectory = path.resolve(argument("--output"));
const version = packageJson.version;
const desktopPrefix = `${DESKTOP_PRODUCT_NAME.replaceAll(" ", "-")}_${version}`;
const expected = new Map([
  ["darwin/universal", new Map([
    [".dmg", `${desktopPrefix}_universal.dmg`],
    [".app.tar.gz", `${desktopPrefix}_universal.app.tar.gz`],
    [".app.tar.gz.sig", `${desktopPrefix}_universal.app.tar.gz.sig`],
  ])],
  ["windows/x86_64", new Map([
    ["-setup.exe", `${desktopPrefix}_x64-setup.exe`],
    [".nsis.zip", `${desktopPrefix}_x64-setup.nsis.zip`],
    [".nsis.zip.sig", `${desktopPrefix}_x64-setup.nsis.zip.sig`],
  ])],
  ["windows/aarch64", new Map([
    ["-setup.exe", `${desktopPrefix}_arm64-setup.exe`],
    [".nsis.zip", `${desktopPrefix}_arm64-setup.nsis.zip`],
    [".nsis.zip.sig", `${desktopPrefix}_arm64-setup.nsis.zip.sig`],
  ])],
  ["linux/x86_64", new Map([
    [".AppImage", `${desktopPrefix}_x86_64.AppImage`],
    [".deb", `${desktopPrefix}_amd64.deb`],
    [".deb.sig", `${desktopPrefix}_amd64.deb.sig`],
    [".AppImage.tar.gz", `${desktopPrefix}_x86_64.AppImage.tar.gz`],
    [".AppImage.tar.gz.sig", `${desktopPrefix}_x86_64.AppImage.tar.gz.sig`],
  ])],
  ["linux/aarch64", new Map([
    [".AppImage", `${desktopPrefix}_aarch64.AppImage`],
    [".deb", `${desktopPrefix}_arm64.deb`],
    [".deb.sig", `${desktopPrefix}_arm64.deb.sig`],
    [".AppImage.tar.gz", `${desktopPrefix}_aarch64.AppImage.tar.gz`],
    [".AppImage.tar.gz.sig", `${desktopPrefix}_aarch64.AppImage.tar.gz.sig`],
  ])],
]).get(`${platform}/${arch}`);

if (!expected) {
  throw new Error(`Unsupported desktop release target: ${platform}/${arch}`);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Desktop package version is invalid");
}

let artifactPaths;
try {
  artifactPaths = JSON.parse(process.env.PIHUB_TAURI_ARTIFACT_PATHS ?? "");
} catch {
  throw new Error("PIHUB_TAURI_ARTIFACT_PATHS must be the tauri-action artifactPaths JSON output");
}
if (!Array.isArray(artifactPaths) || artifactPaths.length === 0) {
  throw new Error("Tauri did not report any release artifacts");
}

fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
if (fs.readdirSync(outputDirectory).length !== 0) {
  throw new Error(`Desktop release staging directory must be empty: ${outputDirectory}`);
}

const inputs = [];
const inputNames = new Set();
for (const input of artifactPaths) {
  if (typeof input !== "string" || !path.isAbsolute(input)) {
    throw new Error("Tauri artifact paths must be absolute paths");
  }
  const info = fs.lstatSync(input, { throwIfNoEntry: false });
  if (!info || info.isDirectory()) continue;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error(`Tauri artifact must be a non-empty regular file: ${input}`);
  }
  const name = safeBasename(input);
  if (inputNames.has(name)) throw new Error(`Duplicate Tauri artifact filename: ${name}`);
  inputNames.add(name);
  inputs.push({ input, name, info });
}

for (const suffix of expected.keys()) {
  if (inputs.filter((file) => file.name.endsWith(suffix)).length !== 1) {
    throw new Error(`Tauri ${platform}/${arch} output is missing ${suffix}`);
  }
}
if (inputs.length !== expected.size) {
  throw new Error(`Tauri ${platform}/${arch} output contains an unexpected number of files`);
}
for (const file of inputs) {
  if (![...expected.keys()].some((suffix) => file.name.endsWith(suffix))) {
    throw new Error(`Tauri ${platform}/${arch} output contains an unexpected file: ${file.name}`);
  }
}
for (const suffix of [...expected.keys()].filter((value) => value.endsWith(".sig"))) {
  const artifactSuffix = suffix.slice(0, -4);
  const artifact = inputs.find((file) => file.name.endsWith(artifactSuffix));
  const signature = inputs.find((file) => file.name.endsWith(suffix));
  if (!artifact || !signature || signature.name !== `${artifact.name}.sig`) {
    throw new Error(`Tauri ${platform}/${arch} signature does not match its updater artifact`);
  }
}

const files = [];
for (const [suffix, canonicalName] of expected) {
  const source = inputs.find((file) => file.name.endsWith(suffix));
  const destination = path.join(outputDirectory, canonicalName);
  fs.copyFileSync(source.input, destination, fs.constants.COPYFILE_EXCL);
  files.push({ name: canonicalName, size: source.info.size, sha256: sha256(destination) });
}

files.sort((left, right) => left.name.localeCompare(right.name, "en"));
const metadataName = `desktop-${platform}-${arch}.asset.json`;
fs.writeFileSync(path.join(outputDirectory, metadataName), `${JSON.stringify({
  schemaVersion: 1,
  version,
  platform,
  arch,
  files,
}, null, 2)}\n`, { mode: 0o644 });

console.log(`Collected ${files.length} signed desktop artifacts for ${platform}/${arch}`);
