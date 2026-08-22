import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const UUID_URL_NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
const PACKAGE_PATH_PROPERTY = "cdx:npm:package:path";
const EXTENSION_PACKAGE_NAME = "@pihub/default-extensions";
const EXTENSION_DIRECTORY = "extensions";
const RELEASE_PROPERTY_NAMES = Object.freeze({
  archive: "pihub:release:archive:name",
  sha256: "pihub:release:archive:sha256",
  size: "pihub:release:archive:size",
  platform: "pihub:release:platform",
  arch: "pihub:release:arch",
});
const UNORDERED_ARRAY_KEYS = new Set([
  "authors",
  "components",
  "dependencies",
  "dependsOn",
  "externalReferences",
  "hashes",
  "licenses",
  "lifecycles",
  "properties",
  "tools",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectedRootComponentName(packageName) {
  return packageName.includes("/") ? packageName.slice(packageName.lastIndexOf("/") + 1) : packageName;
}

function expectedPackagePurl(packageName, version) {
  const encodedName = packageName.startsWith("@")
    ? `${encodeURIComponent(packageName.slice(0, packageName.indexOf("/")))}/${encodeURIComponent(packageName.slice(packageName.indexOf("/") + 1))}`
    : encodeURIComponent(packageName);
  return `pkg:npm/${encodedName}@${version}`;
}

function deterministicSerialNumber(archiveSha256) {
  const digest = createHash("sha1")
    .update(UUID_URL_NAMESPACE)
    .update(`pihub-server-archive:${archiveSha256}`, "utf8")
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalize(value, key = "") {
  if (Array.isArray(value)) {
    const result = value.map((entry) => canonicalize(entry));
    if (UNORDERED_ARRAY_KEYS.has(key)) {
      result.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
    }
    return result;
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((name) => [name, canonicalize(value[name], name)]),
  );
}

function readBoundedJson(filename, description, maxBytes) {
  const info = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0 || info.size > maxBytes) {
    throw new Error(`${description} does not resolve to bounded regular JSON`);
  }
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    throw new Error(`${description} is invalid JSON`);
  }
}

function readPackageMetadata(filename) {
  return readBoundedJson(filename, "Server SBOM component package metadata", 256 * 1024);
}

function readPackageLock(treeRoot) {
  const lock = readBoundedJson(path.join(treeRoot, "package-lock.json"), "Server SBOM package lock", 16 * 1024 * 1024);
  if (!isRecord(lock) || !isRecord(lock.packages) || !isRecord(lock.packages[""])) {
    throw new Error("Server SBOM package lock has no package tree");
  }
  return lock;
}

function componentPackagePaths(component) {
  if (!isRecord(component) || !Array.isArray(component.properties)) {
    throw new Error("Server SBOM component is missing its installed package path");
  }
  const paths = component.properties
    .filter((property) => property?.name === PACKAGE_PATH_PROPERTY)
    .map((property) => property.value);
  if (paths.length === 0 || paths.some((relative) => typeof relative !== "string")) {
    throw new Error("Server SBOM component package path is ambiguous");
  }
  const unique = new Set();
  for (const relative of paths) {
    if (
      relative.includes("\\")
      || relative.startsWith("/")
      || relative.normalize("NFC") !== relative
      || Buffer.byteLength(relative, "utf8") > 2_048
    ) {
      throw new Error("Server SBOM component package path is unsafe");
    }
    const segments = relative === "" ? [] : relative.split("/");
    if (
      segments.some((segment) => !segment || segment === "." || segment === "..")
      || unique.has(relative)
    ) {
      throw new Error("Server SBOM component package path is unsafe");
    }
    unique.add(relative);
  }
  return [...unique].sort((left, right) => left.localeCompare(right, "en"));
}

function isNpmPackageTreePath(relative) {
  const segments = relative.split("/");
  let index = 0;
  while (index < segments.length) {
    if (segments[index] !== "node_modules") return false;
    index += 1;
    if (index >= segments.length) return false;
    if (segments[index].startsWith("@")) {
      if (index + 1 >= segments.length) return false;
      index += 2;
    } else {
      index += 1;
    }
  }
  return true;
}

function componentIdentity(component) {
  return canonicalize({
    ...component,
    properties: component.properties.filter((property) => property?.name !== PACKAGE_PATH_PROPERTY),
  });
}

function validateDependencyIdentity(component) {
  if (
    !isRecord(component)
    || typeof component.name !== "string"
    || !component.name
    || typeof component.version !== "string"
    || !component.version
    || component["bom-ref"] !== `${component.name}@${component.version}`
    || component.purl !== expectedPackagePurl(component.name, component.version)
  ) {
    throw new Error("Server SBOM dependency identity is invalid");
  }
  componentPackagePaths(component);
}

function validateGeneratedDocument(document, packageName, version) {
  if (
    !isRecord(document)
    || document.bomFormat !== "CycloneDX"
    || typeof document.specVersion !== "string"
    || !/^1\.[5-9]$/.test(document.specVersion)
    || document.version !== 1
    || !Array.isArray(document.components)
    || document.components.length === 0
    || !Array.isArray(document.dependencies)
    || !isRecord(document.metadata)
    || !isRecord(document.metadata.component)
  ) {
    throw new Error("npm generated an invalid CycloneDX Server SBOM");
  }
  const rootComponent = document.metadata.component;
  const generatedName = rootComponent.name;
  if (
    rootComponent["bom-ref"] !== `${packageName}@${version}`
    || typeof generatedName !== "string"
    || generatedName.length === 0
    || Buffer.byteLength(generatedName, "utf8") > 255
    || generatedName.includes("\0")
    || rootComponent.version !== version
    || rootComponent.purl !== expectedPackagePurl(packageName, version)
    || JSON.stringify(componentPackagePaths(rootComponent)) !== '[""]'
  ) {
    throw new Error("Server SBOM root identity is invalid");
  }
  for (const component of document.components) validateDependencyIdentity(component);
}

function installedPackageMetadata(treeRoot, relative) {
  const packageDirectory = path.join(treeRoot, ...relative.split("/").filter(Boolean));
  const directoryInfo = fs.lstatSync(packageDirectory, { throwIfNoEntry: false });
  if (!directoryInfo) return null;
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("Server SBOM component package directory is invalid");
  }
  return readPackageMetadata(path.join(packageDirectory, "package.json"));
}

function prefixedPackagePath(prefix, relative) {
  if (!prefix) return relative;
  return relative ? `${prefix}/${relative}` : prefix;
}

function mergeComponent(target, component, paths) {
  const reference = component["bom-ref"];
  const identity = componentIdentity(component);
  const existing = target.get(reference);
  if (existing && JSON.stringify(existing.identity) !== JSON.stringify(identity)) {
    throw new Error("Server SBOM reuses a component reference for different metadata");
  }
  const installedPaths = existing?.paths ?? new Set();
  for (const relative of paths) installedPaths.add(relative);
  target.set(reference, { component: existing?.component ?? component, identity, paths: installedPaths });
}

function materializeComponents(components) {
  return [...components.values()].map(({ component, paths }) => ({
    ...component,
    properties: [
      ...component.properties.filter((property) => property?.name !== PACKAGE_PATH_PROPERTY),
      ...[...paths]
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((value) => ({ name: PACKAGE_PATH_PROPERTY, value })),
    ],
  }));
}

function validateGeneratedGraph(document) {
  const rootReference = document.metadata.component["bom-ref"];
  const known = new Set([rootReference, ...document.components.map((component) => component["bom-ref"])]);
  const graph = new Map();
  for (const dependency of document.dependencies) {
    if (
      !isRecord(dependency)
      || typeof dependency.ref !== "string"
      || !known.has(dependency.ref)
      || !Array.isArray(dependency.dependsOn)
      || dependency.dependsOn.some((reference) => typeof reference !== "string" || !known.has(reference))
    ) {
      throw new Error("Server SBOM dependency graph is invalid");
    }
    const dependencies = graph.get(dependency.ref) ?? new Set();
    for (const reference of dependency.dependsOn) dependencies.add(reference);
    graph.set(dependency.ref, dependencies);
  }
  if ([...known].some((reference) => !graph.has(reference))) {
    throw new Error("Server SBOM dependency graph is incomplete");
  }
  return graph;
}

function packageNameFromTreePath(relative) {
  const segments = String(relative).split("/");
  const marker = segments.lastIndexOf("node_modules");
  if (marker < 0 || marker + 1 >= segments.length) return "";
  const rest = segments.slice(marker + 1);
  return rest[0].startsWith("@") ? `${rest[0]}/${rest[1] ?? ""}` : rest[0];
}

function normalizeInstalledTree(document, { packageName, pathPrefix, stagingDirectory, version, prunedPackages }) {
  const treeRoot = pathPrefix ? path.join(stagingDirectory, pathPrefix) : stagingDirectory;
  const rootInfo = fs.lstatSync(treeRoot, { throwIfNoEntry: false });
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Server SBOM staging package tree is invalid");
  }
  const lock = readPackageLock(treeRoot);
  const rootMetadata = installedPackageMetadata(treeRoot, "");
  if (rootMetadata?.name !== packageName || rootMetadata.version !== version) {
    throw new Error("Server SBOM root component does not match the staged package");
  }
  const rawGraph = validateGeneratedGraph(document);
  const components = new Map();
  const retainedReferences = new Set([document.metadata.component["bom-ref"]]);
  for (const component of document.components) {
    const installedPaths = [];
    for (const relative of componentPackagePaths(component)) {
      if (!isNpmPackageTreePath(relative)) {
        throw new Error("Server SBOM dependency is outside an npm package tree");
      }
      const metadata = installedPackageMetadata(treeRoot, relative);
      if (!metadata) {
        const lockEntry = lock.packages[relative];
        if (isRecord(lockEntry) && (lockEntry.peer === true || lockEntry.optional === true)) continue;
        // Platform pruning intentionally removes non-target native packages
        // from the physical tree; they stay in the lock graph. Nested
        // dependencies of a pruned package (e.g. onnxruntime-common under
        // onnxruntime-web) disappear with it.
        if (prunedPackages) {
          const name = packageNameFromTreePath(relative);
          const pruned = [...prunedPackages].some((pkg) => {
            const dir = `node_modules/${pkg}`;
            return name === pkg || relative.includes(`${dir}/`);
          });
          if (pruned) continue;
        }
        throw new Error(`Server SBOM required dependency does not resolve to a physical package: ${relative}`);
      }
      if (component.name !== metadata.name || component.version !== metadata.version) {
        throw new Error("Server SBOM dependency does not match its installed package");
      }
      installedPaths.push(prefixedPackagePath(pathPrefix, relative));
    }
    if (installedPaths.length === 0) continue;
    mergeComponent(components, component, installedPaths);
    retainedReferences.add(component["bom-ref"]);
  }
  if (components.size === 0) throw new Error("Server SBOM contains no installed dependencies");

  const dependencies = new Map();
  for (const [reference, dependsOn] of rawGraph) {
    if (!retainedReferences.has(reference)) continue;
    dependencies.set(
      reference,
      new Set([...dependsOn].filter((dependencyReference) => retainedReferences.has(dependencyReference))),
    );
  }
  const rootComponent = {
    ...document.metadata.component,
    name: expectedRootComponentName(packageName),
    properties: [
      ...document.metadata.component.properties.filter((property) => property?.name !== PACKAGE_PATH_PROPERTY),
      { name: PACKAGE_PATH_PROPERTY, value: prefixedPackagePath(pathPrefix, "") },
    ],
  };
  return { components, dependencies, rootComponent };
}

function mergeDependencyGraphs(...graphs) {
  const merged = new Map();
  for (const graph of graphs) {
    for (const [reference, dependsOn] of graph) {
      const dependencies = merged.get(reference) ?? new Set();
      for (const dependencyReference of dependsOn) dependencies.add(dependencyReference);
      merged.set(reference, dependencies);
    }
  }
  return merged;
}

function dependencyRecords(graph) {
  return [...graph].map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn] }));
}

function validateComponentPathDomains(document, options) {
  const extensionReference = `${EXTENSION_PACKAGE_NAME}@${options.version}`;
  const components = [document.metadata.component, ...document.components];
  const seenPaths = new Set();
  for (const [index, component] of components.entries()) {
    const componentPaths = componentPackagePaths(component);
    if (index === 0) {
      if (JSON.stringify(componentPaths) !== '[""]') {
        throw new Error("Server SBOM root component does not match the release package");
      }
    } else if (component["bom-ref"] === extensionReference) {
      if (JSON.stringify(componentPaths) !== `["${EXTENSION_DIRECTORY}"]`) {
        throw new Error("Server SBOM extension root path is invalid");
      }
    } else if (componentPaths.some((relative) => (
      relative.startsWith(`${EXTENSION_DIRECTORY}/`)
        ? !isNpmPackageTreePath(relative.slice(EXTENSION_DIRECTORY.length + 1))
        : !isNpmPackageTreePath(relative)
    ))) {
      throw new Error("Server SBOM dependency is outside the installed package trees");
    }
    for (const relative of componentPaths) {
      if (seenPaths.has(relative)) throw new Error("Server SBOM contains duplicate installed package paths");
      seenPaths.add(relative);
    }
  }
}

function validateInstalledComponents(document, stagingDirectory, options) {
  const staging = path.resolve(stagingDirectory);
  const stagingInfo = fs.lstatSync(staging, { throwIfNoEntry: false });
  if (!stagingInfo?.isDirectory() || stagingInfo.isSymbolicLink()) {
    throw new Error("Server SBOM staging directory is invalid");
  }
  const extensionReference = `${EXTENSION_PACKAGE_NAME}@${options.version}`;
  const components = [document.metadata.component, ...document.components];
  for (const [index, component] of components.entries()) {
    for (const relative of componentPackagePaths(component)) {
      const metadata = installedPackageMetadata(staging, relative);
      if (!metadata) throw new Error("Server SBOM component has no physical package metadata");
      if (index === 0) {
        if (metadata.name !== options.packageName || metadata.version !== options.version) {
          throw new Error("Server SBOM root component does not match the release package");
        }
      } else if (component["bom-ref"] === extensionReference) {
        if (metadata.name !== EXTENSION_PACKAGE_NAME || metadata.version !== options.version) {
          throw new Error("Server SBOM extension root does not match the staged package");
        }
      } else if (component.name !== metadata.name || component.version !== metadata.version) {
        throw new Error("Server SBOM dependency does not match its installed package");
      }
    }
  }
}

function validateReferences(document) {
  const componentReferences = [document.metadata.component, ...document.components]
    .map((component) => component?.["bom-ref"]);
  if (
    componentReferences.some((reference) => typeof reference !== "string" || !reference)
    || new Set(componentReferences).size !== componentReferences.length
  ) {
    throw new Error("Server SBOM component references are not unique");
  }
  const known = new Set(componentReferences);
  const graphReferences = new Set();
  for (const dependency of document.dependencies) {
    if (
      !isRecord(dependency)
      || typeof dependency.ref !== "string"
      || graphReferences.has(dependency.ref)
      || !known.has(dependency.ref)
      || !Array.isArray(dependency.dependsOn)
      || dependency.dependsOn.some((reference) => typeof reference !== "string" || !known.has(reference))
      || new Set(dependency.dependsOn).size !== dependency.dependsOn.length
      || dependency.dependsOn.includes(dependency.ref)
    ) {
      throw new Error("Server SBOM dependency references are invalid");
    }
    graphReferences.add(dependency.ref);
  }
  if (graphReferences.size !== known.size) throw new Error("Server SBOM dependency graph is incomplete");
}

function validateExtensionIntegration(document, options) {
  const extensionReference = `${EXTENSION_PACKAGE_NAME}@${options.version}`;
  const extensionComponents = document.components.filter((component) => component["bom-ref"] === extensionReference);
  if (extensionComponents.length !== 1) throw new Error("Server SBOM extension root is missing or duplicated");
  const extension = extensionComponents[0];
  if (
    extension.name !== expectedRootComponentName(EXTENSION_PACKAGE_NAME)
    || extension.version !== options.version
    || extension.purl !== expectedPackagePurl(EXTENSION_PACKAGE_NAME, options.version)
  ) {
    throw new Error("Server SBOM extension root identity is invalid");
  }
  const serverRoot = document.dependencies.find((dependency) => dependency.ref === document.metadata.component["bom-ref"]);
  if (!serverRoot?.dependsOn.includes(extensionReference)) {
    throw new Error("Server SBOM root dependency on default extensions is missing");
  }
}

function validateArchiveInventory(document, archiveInventory) {
  if (archiveInventory === undefined) return;
  const files = Array.isArray(archiveInventory) ? archiveInventory : archiveInventory?.files;
  if (!Array.isArray(files)) throw new Error("Server SBOM archive inventory is invalid");
  const paths = new Set();
  for (const file of files) {
    const relative = file?.path;
    if (
      typeof relative !== "string"
      || !relative
      || relative.startsWith("/")
      || relative.includes("\\")
      || relative.normalize("NFC") !== relative
      || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || paths.has(relative)
    ) {
      throw new Error("Server SBOM archive inventory is invalid");
    }
    paths.add(relative);
  }
  for (const component of [document.metadata.component, ...document.components]) {
    for (const relative of componentPackagePaths(component)) {
      const packageJson = relative ? `${relative}/package.json` : "package.json";
      if (!paths.has(packageJson)) {
        throw new Error("Server SBOM package path is missing from the release archive inventory");
      }
    }
  }
}

function validateOptions(options) {
  if (
    typeof options?.archiveName !== "string"
    || !/^pihub-server-[A-Za-z0-9._-]+-(?:darwin|linux|win32)-(?:arm64|x64)\.tar\.gz$/.test(options.archiveName)
    || !SHA256_PATTERN.test(options.archiveSha256)
    || !Number.isSafeInteger(options.archiveSize)
    || options.archiveSize <= 0
    || options.packageName !== "@pihub/server"
    || !VERSION_PATTERN.test(options.version)
    || !new Set(["darwin", "linux", "win32"]).has(options.platform)
    || !new Set(["arm64", "x64"]).has(options.arch)
  ) {
    throw new Error("Server SBOM release binding is invalid");
  }
  const expectedArchive = `pihub-server-${options.version}-${options.platform}-${options.arch}.tar.gz`;
  if (options.archiveName !== expectedArchive) throw new Error("Server SBOM archive identity is inconsistent");
}

function validateReleaseDocument(document, options) {
  validateOptions(options);
  if (
    !isRecord(document)
    || document.bomFormat !== "CycloneDX"
    || typeof document.specVersion !== "string"
    || !/^1\.[5-9]$/.test(document.specVersion)
    || document.version !== 1
    || !Array.isArray(document.components)
    || document.components.length === 0
    || !Array.isArray(document.dependencies)
    || !isRecord(document.metadata)
    || !isRecord(document.metadata.component)
  ) {
    throw new Error("npm generated an invalid CycloneDX Server SBOM");
  }
  const rootComponent = document.metadata.component;
  if (
    rootComponent["bom-ref"] !== `${options.packageName}@${options.version}`
    || rootComponent.name !== expectedRootComponentName(options.packageName)
    || rootComponent.version !== options.version
    || rootComponent.purl !== expectedPackagePurl(options.packageName, options.version)
  ) {
    throw new Error("Server SBOM root identity is invalid");
  }
  for (const component of document.components) {
    if (component["bom-ref"] !== `${EXTENSION_PACKAGE_NAME}@${options.version}`) {
      validateDependencyIdentity(component);
    }
  }
}

function assertReleaseBinding(document, options) {
  validateReleaseDocument(document, options);
  validateReferences(document);
  validateComponentPathDomains(document, options);
  validateExtensionIntegration(document, options);
  validateArchiveInventory(document, options.archiveInventory);
  if (Object.hasOwn(document.metadata, "timestamp")) {
    throw new Error("Server SBOM contains a nondeterministic build timestamp");
  }
  if (document.serialNumber !== deterministicSerialNumber(options.archiveSha256)) {
    throw new Error("Server SBOM serial number is not bound to the release archive");
  }
  const properties = Array.isArray(document.metadata.properties) ? document.metadata.properties : [];
  const expected = new Map([
    [RELEASE_PROPERTY_NAMES.archive, options.archiveName],
    [RELEASE_PROPERTY_NAMES.sha256, options.archiveSha256],
    [RELEASE_PROPERTY_NAMES.size, String(options.archiveSize)],
    [RELEASE_PROPERTY_NAMES.platform, options.platform],
    [RELEASE_PROPERTY_NAMES.arch, options.arch],
  ]);
  for (const [name, value] of expected) {
    const matches = properties.filter((property) => property?.name === name);
    if (matches.length !== 1 || matches[0].value !== value) {
      throw new Error("Server SBOM release binding is missing or inconsistent");
    }
  }
}

export function normalizeServerReleaseSbom(serverInput, extensionInput, options) {
  validateOptions(options);
  const serverDocument = structuredClone(serverInput);
  const extensionDocument = structuredClone(extensionInput);
  validateGeneratedDocument(serverDocument, options.packageName, options.version);
  validateGeneratedDocument(extensionDocument, EXTENSION_PACKAGE_NAME, options.version);
  if (serverDocument.specVersion !== extensionDocument.specVersion) {
    throw new Error("Server and extension SBOM specifications do not match");
  }
  const existingProperties = Array.isArray(serverDocument.metadata.properties)
    ? serverDocument.metadata.properties
    : [];
  if (existingProperties.some((property) => Object.values(RELEASE_PROPERTY_NAMES).includes(property?.name))) {
    throw new Error("npm SBOM unexpectedly contains reserved PiHub release properties");
  }
  const stagingDirectory = path.resolve(options.stagingDirectory);
  const prunedPackages = options.prunedPackages instanceof Set ? options.prunedPackages : undefined;
  const serverTree = normalizeInstalledTree(serverDocument, {
    packageName: options.packageName,
    pathPrefix: "",
    stagingDirectory,
    version: options.version,
    prunedPackages,
  });
  const extensionTree = normalizeInstalledTree(extensionDocument, {
    packageName: EXTENSION_PACKAGE_NAME,
    pathPrefix: EXTENSION_DIRECTORY,
    stagingDirectory,
    version: options.version,
    prunedPackages,
  });

  const components = new Map();
  for (const { component, paths } of serverTree.components.values()) mergeComponent(components, component, paths);
  mergeComponent(
    components,
    extensionTree.rootComponent,
    componentPackagePaths(extensionTree.rootComponent),
  );
  for (const { component, paths } of extensionTree.components.values()) mergeComponent(components, component, paths);
  const dependencies = mergeDependencyGraphs(serverTree.dependencies, extensionTree.dependencies);
  dependencies.get(serverTree.rootComponent["bom-ref"]).add(extensionTree.rootComponent["bom-ref"]);

  serverDocument.serialNumber = deterministicSerialNumber(options.archiveSha256);
  delete serverDocument.metadata.timestamp;
  serverDocument.metadata.component = serverTree.rootComponent;
  serverDocument.metadata.properties = [
    ...existingProperties,
    { name: RELEASE_PROPERTY_NAMES.archive, value: options.archiveName },
    { name: RELEASE_PROPERTY_NAMES.sha256, value: options.archiveSha256 },
    { name: RELEASE_PROPERTY_NAMES.size, value: String(options.archiveSize) },
    { name: RELEASE_PROPERTY_NAMES.platform, value: options.platform },
    { name: RELEASE_PROPERTY_NAMES.arch, value: options.arch },
  ];
  serverDocument.components = materializeComponents(components);
  serverDocument.dependencies = dependencyRecords(dependencies);
  validateComponentPathDomains(serverDocument, options);
  validateInstalledComponents(serverDocument, stagingDirectory, options);
  const normalized = canonicalize(serverDocument);
  assertReleaseBinding(normalized, options);
  return normalized;
}

export function verifyServerReleaseSbom(document, options) {
  assertReleaseBinding(document, options);
  if (options.stagingDirectory) validateInstalledComponents(document, options.stagingDirectory, options);
  if (JSON.stringify(canonicalize(document)) !== JSON.stringify(document)) {
    throw new Error("Server SBOM is not canonically ordered");
  }
  return document;
}

export const serverReleaseSbomInternals = Object.freeze({
  deterministicSerialNumber,
});
