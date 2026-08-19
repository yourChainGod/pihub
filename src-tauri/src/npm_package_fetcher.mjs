import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import https from "node:https";

const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA512_SRI = /^sha512-([A-Za-z0-9+/]{86}==)$/;

function fail(message) {
  throw new Error(`[pihub] ${message}`);
}

function writeAll(descriptor, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const written = writeSync(descriptor, chunk, offset, chunk.length - offset);
    if (written <= 0) fail("无法完整写入 npm tarball");
    offset += written;
  }
}

function validatePackage(name, version) {
  if (!PACKAGE_NAME.test(name)) fail("npm 包名不在允许格式内");
  if (!EXACT_VERSION.test(version)) fail("npm 包版本必须是精确版本");
}

function validateIntegrity(integrity) {
  const match = SHA512_SRI.exec(integrity);
  if (!match) fail("npm 包缺少固定的 SHA-512 integrity");
  return match[1];
}

function request(url, maxBytes, onResponse) {
  if (url.protocol !== "https:" || url.origin !== REGISTRY_ORIGIN) {
    fail("npm 请求越过官方 registry");
  }
  return new Promise((resolvePromise, reject) => {
    const requestHandle = https.get(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "PiHub-bootstrap/0.0.1",
        },
      },
      async (response) => {
        try {
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400
          ) {
            response.resume();
            fail("npm registry 返回了重定向，已拒绝跟随");
          }
          if (response.statusCode !== 200) {
            response.resume();
            fail(`npm registry 返回 HTTP ${response.statusCode ?? "unknown"}`);
          }
          const declaredLength = Number(response.headers["content-length"]);
          if (
            Number.isFinite(declaredLength) &&
            (declaredLength < 0 || declaredLength > maxBytes)
          ) {
            response.resume();
            fail("npm registry 响应超过大小上限");
          }
          resolvePromise(await onResponse(response, maxBytes));
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    requestHandle.setTimeout(REQUEST_TIMEOUT_MS, () => {
      requestHandle.destroy(new Error("npm registry 请求超时"));
    });
    requestHandle.once("error", reject);
  });
}

async function readBounded(response, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > maxBytes) fail("npm registry 响应超过大小上限");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function fetchVerifiedPackage(name, version, expectedIntegrity, output) {
  validatePackage(name, version);
  const expectedDigest = validateIntegrity(expectedIntegrity);
  if (existsSync(output)) fail("npm 包临时文件已存在");

  const metadataUrl = new URL(
    `${REGISTRY_ORIGIN}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  const metadataBytes = await request(metadataUrl, MAX_METADATA_BYTES, readBounded);
  let metadata;
  try {
    metadata = JSON.parse(metadataBytes.toString("utf8"));
  } catch {
    fail("npm registry 元数据不是有效 JSON");
  }
  if (
    metadata?.name !== name ||
    metadata?.version !== version ||
    metadata?.dist?.integrity !== expectedIntegrity ||
    typeof metadata?.dist?.tarball !== "string"
  ) {
    fail("npm registry 元数据与源码固定值不一致");
  }

  let tarballUrl;
  try {
    tarballUrl = new URL(metadata.dist.tarball);
  } catch {
    fail("npm registry tarball 地址无效");
  }
  if (
    tarballUrl.protocol !== "https:" ||
    tarballUrl.origin !== REGISTRY_ORIGIN ||
    tarballUrl.username ||
    tarballUrl.password ||
    tarballUrl.search ||
    tarballUrl.hash
  ) {
    fail("npm tarball 不属于无凭据的官方 registry HTTPS 地址");
  }

  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = openSync(output, "wx", 0o600);
    const hash = createHash("sha512");
    let total = 0;
    await request(tarballUrl, MAX_TARBALL_BYTES, async (response) => {
      for await (const chunk of response) {
        total += chunk.length;
        if (total > MAX_TARBALL_BYTES) fail("npm tarball 超过大小上限");
        hash.update(chunk);
        writeAll(descriptor, chunk);
      }
    });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const actualDigest = hash.digest("base64");
    if (actualDigest !== expectedDigest) {
      fail("npm tarball 的本地 SHA-512 校验失败");
    }
    chmodSync(output, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(output, { force: true });
    throw error;
  }
}

function packageManifestPath(root, name) {
  const base = resolve(root, "node_modules");
  const target = resolve(base, ...name.split("/"), "package.json");
  if (!target.startsWith(`${base}${sep}`)) fail("npm 包路径越界");
  return target;
}

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JSON_BYTES) {
    fail("npm 配置文件不是有界普通文件");
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("npm 配置文件不是有效 JSON");
  }
}

function atomicJsonWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dirname(path), 0o700);
  const temporary = `${path}.pihub-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function packagePairs(values) {
  if (values.length === 0 || values.length % 2 !== 0) {
    fail("npm 包清单参数无效");
  }
  const packages = [];
  const names = new Set();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const version = values[index + 1];
    validatePackage(name, version);
    if (names.has(name)) fail("npm 包清单包含重复包名");
    names.add(name);
    packages.push({ name, version });
  }
  return packages;
}

function prepareExtensionRoot(root, values) {
  const packages = packagePairs(values);
  const manifestPath = join(resolve(root), "package.json");
  const manifest = readJsonFile(manifestPath, {
    name: "pi-extensions",
    private: true,
  });
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Pi 扩展 package.json 结构无效");
  }
  if (
    manifest.dependencies !== undefined &&
    (!manifest.dependencies ||
      typeof manifest.dependencies !== "object" ||
      Array.isArray(manifest.dependencies))
  ) {
    fail("Pi 扩展 dependencies 结构无效");
  }
  const dependencies = { ...(manifest.dependencies ?? {}) };
  for (const [name, version] of Object.entries(dependencies)) {
    validatePackage(name, version);
  }
  for (const { name, version } of packages) dependencies[name] = version;
  atomicJsonWrite(manifestPath, {
    ...manifest,
    name: "pi-extensions",
    private: true,
    dependencies,
  });
}

function npmIdentity(source) {
  if (typeof source !== "string" || !source.startsWith("npm:")) return null;
  const spec = source.slice(4);
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    const versionMarker = spec.indexOf("@", slash + 1);
    return versionMarker === -1 ? spec : spec.slice(0, versionMarker);
  }
  const versionMarker = spec.indexOf("@");
  return versionMarker === -1 ? spec : spec.slice(0, versionMarker);
}

function persistExtensions(settingsPath, values) {
  const packages = packagePairs(values);
  const settings = readJsonFile(settingsPath, {});
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    fail("Pi settings.json 结构无效");
  }
  if (settings.packages !== undefined && !Array.isArray(settings.packages)) {
    fail("Pi settings.json packages 结构无效");
  }
  const managedNames = new Set(packages.map(({ name }) => name));
  const existing = settings.packages ?? [];
  for (const entry of existing) {
    if (
      typeof entry !== "string" &&
      (!entry || typeof entry !== "object" || typeof entry.source !== "string")
    ) {
      fail("Pi settings.json 包含无效 package 条目");
    }
  }
  const filtered = existing.filter((entry) => {
    const source = typeof entry === "string" ? entry : entry.source;
    return !managedNames.has(npmIdentity(source));
  });
  for (const { name, version } of packages) {
    filtered.push(`npm:${name}@${version}`);
  }
  atomicJsonWrite(settingsPath, { ...settings, packages: filtered });
}

function assertInstalled(root, name, version) {
  validatePackage(name, version);
  const manifest = readJsonFile(packageManifestPath(root, name), null);
  if (manifest?.name !== name || manifest?.version !== version) process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "fetch" && args.length === 4) {
    await fetchVerifiedPackage(...args);
  } else if (command === "installed" && args.length === 3) {
    assertInstalled(...args);
  } else if (command === "prepare-root" && args.length >= 3) {
    prepareExtensionRoot(args[0], args.slice(1));
  } else if (command === "persist" && args.length >= 3) {
    persistExtensions(args[0], args.slice(1));
  } else {
    fail("npm 校验器参数无效");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "[pihub] npm 校验失败");
  process.exit(1);
}
