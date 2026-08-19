#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const serverDirectory = path.join(repositoryRoot, "server");

const CORE_VERSION = "(?:0|[1-9]\\d*)";
const PRERELEASE_IDENTIFIER = "(?:(?:0|[1-9]\\d*)|(?:\\d*[A-Za-z-][0-9A-Za-z-]*))";
const EXACT_SEMVER = new RegExp(
  `^${CORE_VERSION}\\.${CORE_VERSION}\\.${CORE_VERSION}`
  + `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?`
  + "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
);
const SAFE_LINK_SEGMENT = /^[A-Za-z0-9@._+-]+$/;
const CONTROL_CHARACTERS = /\p{Cc}/u;

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, description) {
  if (!isRecord(value)) throw new Error(`${description} must be a JSON object`);
  return value;
}

function assertExactSemver(value, description) {
  if (typeof value !== "string" || !EXACT_SEMVER.test(value)) {
    throw new Error(`${description} must be an exact SemVer version`);
  }
}

function assertPackageIdentity(packageJson, packageLock, rootPackage) {
  if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
    throw new Error("Server package manifest name is invalid");
  }
  assertExactSemver(packageJson.version, "Server package manifest version");
  if (packageLock.name !== packageJson.name || packageLock.version !== packageJson.version) {
    throw new Error("Server package lock identity does not match the package manifest");
  }
  if (rootPackage.name !== packageJson.name || rootPackage.version !== packageJson.version) {
    throw new Error("Server package lock root identity does not match the package manifest");
  }
  for (const field of ["resolved", "integrity", "link", "inBundle"]) {
    if (hasOwn(rootPackage, field)) {
      throw new Error(`Server package lock root contains an invalid ${field} field`);
    }
  }
}

function verifyProductionDependencies(packageJson, rootPackage) {
  const manifestDependencies = requireRecord(
    packageJson.dependencies,
    "Server package manifest dependencies",
  );
  const lockedDependencies = requireRecord(
    rootPackage.dependencies,
    "Server package lock root dependencies",
  );
  const manifestNames = Object.keys(manifestDependencies).sort();
  const lockedNames = Object.keys(lockedDependencies).sort();
  if (
    manifestNames.length !== lockedNames.length
    || manifestNames.some((name, index) => name !== lockedNames[index])
  ) {
    throw new Error("Server package lock production dependency keys do not match the package manifest");
  }
  for (const name of manifestNames) {
    const manifestVersion = manifestDependencies[name];
    assertExactSemver(manifestVersion, `Production dependency ${name}`);
    if (lockedDependencies[name] !== manifestVersion) {
      throw new Error(`Server package lock production dependency ${name} does not match the package manifest`);
    }
  }
  return manifestNames.length;
}

function safePackageSegment(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && value !== "node_modules"
    && value.normalize("NFC") === value
    && !CONTROL_CHARACTERS.test(value)
    && !/[\\:%?#<>"|*]/.test(value)
    && !/[. ]$/.test(value);
}

function parseNodeModulesPath(packagePath) {
  if (typeof packagePath !== "string" || !packagePath.startsWith("node_modules/")) return null;
  const segments = packagePath.split("/");
  const packageNames = [];
  let index = 0;
  while (index < segments.length) {
    if (segments[index] !== "node_modules") return null;
    index += 1;
    const first = segments[index];
    if (!safePackageSegment(first)) return null;
    if (first.startsWith("@")) {
      const second = segments[index + 1];
      if (first === "@" || !safePackageSegment(second) || second.startsWith("@")) return null;
      packageNames.push(`${first}/${second}`);
      index += 2;
    } else {
      packageNames.push(first);
      index += 1;
    }
  }
  return packageNames.length > 0 ? packageNames : null;
}

function assertOfficialRegistryUrl(value, packagePath) {
  if (
    typeof value !== "string"
    || !/^https:\/\/registry\.npmjs\.org(?::443)?\//.test(value)
    || value.includes("\\")
  ) {
    throw new Error(`${packagePath} must resolve through the official npm registry over HTTPS`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${packagePath} must resolve through the official npm registry over HTTPS`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "registry.npmjs.org"
    || (parsed.port !== "" && parsed.port !== "443")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname === "/"
  ) {
    throw new Error(`${packagePath} has an unsafe npm registry URL`);
  }
  const withoutExplicitDefaultPort = value.replace(
    /^https:\/\/registry\.npmjs\.org:443\//,
    "https://registry.npmjs.org/",
  );
  if (parsed.href !== withoutExplicitDefaultPort) {
    throw new Error(`${packagePath} has a non-canonical npm registry URL`);
  }
}

function assertSha512Integrity(value, packagePath) {
  if (typeof value !== "string") {
    throw new Error(`${packagePath} is missing its SHA-512 integrity`);
  }
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error(`${packagePath} must have one canonical SHA-512 integrity token`);
  const decoded = Buffer.from(match[1], "base64");
  if (decoded.length !== 64) throw new Error(`${packagePath} SHA-512 integrity must decode to 64 bytes`);
  if (decoded.toString("base64") !== match[1]) {
    throw new Error(`${packagePath} SHA-512 integrity is not canonical base64`);
  }
}

function assertSafeLinkTarget(value, packagePath) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)
    || value.includes("\\")
    || value.includes("%")
    || value.includes("?")
    || value.includes("#")
    || /^[^/]+@[^/]+(?:\/|$)/.test(value)
    || CONTROL_CHARACTERS.test(value)
    || value.normalize("NFC") !== value
  ) {
    throw new Error(`${packagePath} has an unsafe internal link target`);
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => (
      !SAFE_LINK_SEGMENT.test(segment)
      || segment === "."
      || segment === ".."
      || segment === "node_modules"
      || /[. ]$/.test(segment)
    ))
    || path.posix.normalize(value) !== value
  ) {
    throw new Error(`${packagePath} has an unsafe internal link target`);
  }
  return value;
}

function verifyExternalEntry(packagePath, entry) {
  assertExactSemver(entry.version, `${packagePath} version`);
  if (hasOwn(entry, "link") || hasOwn(entry, "inBundle")) {
    throw new Error(`${packagePath} contains an invalid structural marker`);
  }
  assertOfficialRegistryUrl(entry.resolved, packagePath);
  assertSha512Integrity(entry.integrity, packagePath);
}

function verifyLinkEntry(packagePath, entry) {
  if (
    entry.link !== true
    || hasOwn(entry, "version")
    || hasOwn(entry, "integrity")
    || hasOwn(entry, "inBundle")
  ) {
    throw new Error(`${packagePath} has an invalid internal link record`);
  }
  return assertSafeLinkTarget(entry.resolved, packagePath);
}

function verifyLinkTargetEntry(packagePath, entry) {
  assertSafeLinkTarget(packagePath, packagePath);
  assertExactSemver(entry.version, `${packagePath} linked package version`);
  if (hasOwn(entry, "name") && (typeof entry.name !== "string" || entry.name.length === 0)) {
    throw new Error(`${packagePath} linked package name is invalid`);
  }
  for (const field of ["resolved", "integrity", "link", "inBundle"]) {
    if (hasOwn(entry, field)) throw new Error(`${packagePath} has an invalid linked package ${field} field`);
  }
}

function verifyBundledEntry(packagePath, entry) {
  assertExactSemver(entry.version, `${packagePath} bundled package version`);
  if (
    entry.inBundle !== true
    || hasOwn(entry, "resolved")
    || hasOwn(entry, "integrity")
    || hasOwn(entry, "link")
  ) {
    throw new Error(`${packagePath} has an invalid bundled package record`);
  }
}

function hasProtectedExternalAncestor(packagePath, categories) {
  let boundary = packagePath.lastIndexOf("/node_modules/");
  while (boundary !== -1) {
    const ancestor = packagePath.slice(0, boundary);
    if (categories.get(ancestor) === "external") return true;
    boundary = ancestor.lastIndexOf("/node_modules/");
  }
  return false;
}

export function verifyServerLock({ packageJson, packageLock }) {
  const manifest = requireRecord(packageJson, "Server package manifest");
  const lock = requireRecord(packageLock, "Server package lock");
  if (lock.lockfileVersion !== 3) throw new Error("Server package lock must use lockfileVersion 3");
  const packages = requireRecord(lock.packages, "Server package lock packages");
  if (!hasOwn(packages, "")) throw new Error("Server package lock is missing its root package record");
  const rootPackage = requireRecord(packages[""], "Server package lock root");
  assertPackageIdentity(manifest, lock, rootPackage);
  const productionDependencies = verifyProductionDependencies(manifest, rootPackage);

  const categories = new Map();
  const linkTargets = new Set();
  const localEntries = new Map();
  let externalEntries = 0;
  let linkEntries = 0;
  let bundledEntries = 0;

  for (const [packagePath, candidate] of Object.entries(packages)) {
    if (packagePath === "") continue;
    const entry = requireRecord(candidate, `Server package lock entry ${packagePath}`);
    if (parseNodeModulesPath(packagePath) === null) {
      verifyLinkTargetEntry(packagePath, entry);
      localEntries.set(packagePath, entry);
      continue;
    }
    if (entry.link === true) {
      linkTargets.add(verifyLinkEntry(packagePath, entry));
      categories.set(packagePath, "link");
      linkEntries += 1;
    } else if (entry.inBundle === true) {
      verifyBundledEntry(packagePath, entry);
      categories.set(packagePath, "bundled");
      bundledEntries += 1;
    } else {
      verifyExternalEntry(packagePath, entry);
      categories.set(packagePath, "external");
      externalEntries += 1;
    }
  }

  for (const target of linkTargets) {
    if (!localEntries.has(target)) throw new Error("Server package lock contains a dangling internal link");
  }
  for (const localPath of localEntries.keys()) {
    if (!linkTargets.has(localPath)) {
      throw new Error(`Unexpected package path outside the root/link structure: ${localPath}`);
    }
  }
  for (const [packagePath, category] of categories) {
    if (category === "bundled" && !hasProtectedExternalAncestor(packagePath, categories)) {
      throw new Error(`${packagePath} bundled package has no protected external ancestor`);
    }
  }

  return {
    rootEntries: 1,
    externalEntries,
    linkEntries,
    linkTargetEntries: localEntries.size,
    bundledEntries,
    productionDependencies,
  };
}

function readJsonFile(filename, description) {
  let source;
  try {
    source = fs.readFileSync(filename, "utf8");
  } catch {
    throw new Error(`${description} could not be read`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${description} is not valid JSON`);
  }
}

export function verifyServerLockFiles({
  packageJsonPath = path.join(serverDirectory, "package.json"),
  packageLockPath = path.join(serverDirectory, "package-lock.json"),
} = {}) {
  return verifyServerLock({
    packageJson: readJsonFile(packageJsonPath, "Server package manifest"),
    packageLock: readJsonFile(packageLockPath, "Server package lock"),
  });
}

function main() {
  const args = process.argv.slice(2);
  const json = args.length === 1 && args[0] === "--json";
  if (args.length > (json ? 1 : 0)) {
    throw new Error("Usage: node scripts/verify-server-lock.mjs [--json]");
  }
  const summary = verifyServerLockFiles();
  if (json) {
    console.log(JSON.stringify(summary));
    return;
  }
  console.log(
    `Verified Server package lock (${summary.productionDependencies} production dependencies, `
    + `${summary.externalEntries} external entries; structural exceptions: `
    + `${summary.rootEntries} root, ${summary.linkEntries} links, `
    + `${summary.linkTargetEntries} link targets, ${summary.bundledEntries} bundled)`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Server package lock verification failed");
    process.exitCode = 1;
  }
}
