#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzipSync, inflateRawSync } from "node:zlib";

const execFileAsync = promisify(execFile);

export const DEFAULT_LIMITS = Object.freeze({
  largeFileBytes: 5 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxArchiveBytes: 128 * 1024 * 1024,
  maxArchiveExpandedBytes: 256 * 1024 * 1024,
  maxArchiveMemberBytes: 8 * 1024 * 1024,
  maxArchiveScanBytes: 64 * 1024 * 1024,
  maxArchiveEntries: 10_000,
  maxArchiveDepth: 3,
});

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".factory",
  ".idea",
  ".next",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "blob-report",
  "playwright-report",
  "target",
  "test-results",
  "videos",
]);

const DEFAULT_EXCLUDED_PREFIXES = [
  "scripts/fixtures/privacy-scan",
  "server/.next",
  "src-tauri/gen",
];

const PRIVATE_DEVELOPMENT_FILES = new Set([
  "HANDOFF.md",
  "instruction.dev.md",
  "research-results.tsv",
]);

const PLACEHOLDER_USERS = new Set([
  "a & b",
  "alex",
  "alice",
  "app",
  "bob",
  "demo",
  "example",
  "me",
  "node",
  "pi",
  "pi user",
  "private-user",
  "redacted",
  "root",
  "runner",
  "test",
  "tester",
  "ubuntu",
  "user",
  "username",
  "vscode",
]);

// These addresses are documentation/test constants already used by this project.
const DOCUMENTATION_CGNAT_ADDRESSES = new Set([
  "100.64.0.0",
  "100.64.0.1",
  "100.64.0.2",
  "100.100.10.20",
  "100.100.20.30",
  "100.100.100.100",
]);

const FIXED_TOKEN_RULES = [
  {
    id: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIV(?:ATE) KEY-----/g,
    message: "检测到私钥头，内容已隐藏。",
  },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    message: "检测到 GitHub Token，内容已隐藏。",
  },
  {
    id: "github-fine-grained-token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g,
    message: "检测到 GitHub fine-grained Token，内容已隐藏。",
  },
  {
    id: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    message: "检测到云访问密钥标识，内容已隐藏。",
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    message: "检测到 API Key，内容已隐藏。",
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    message: "检测到服务 Token，内容已隐藏。",
  },
  {
    id: "live-payment-key",
    pattern: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/g,
    message: "检测到生产支付密钥，内容已隐藏。",
  },
  {
    id: "npm-token",
    pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g,
    message: "检测到 npm Token，内容已隐藏。",
  },
  {
    id: "gitlab-token",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    message: "检测到 GitLab Token，内容已隐藏。",
  },
  {
    id: "model-provider-token",
    pattern: /\b(?:sk-(?:proj|svcacct)-|sk-ant-(?:api\d{2}-)?)[A-Za-z0-9_-]{20,}\b/g,
    message: "检测到模型 Provider Token，内容已隐藏。",
  },
  {
    id: "tailscale-token",
    pattern: /\btskey-(?:api|auth|client)-[A-Za-z0-9_-]{20,}\b/g,
    message: "检测到 Tailscale Token，内容已隐藏。",
  },
];

const RULE_MESSAGES = Object.freeze({
  "absolute-user-path": "检测到带用户名的本机绝对路径，用户名已隐藏。",
  "archive-depth-limit": "归档嵌套层级超出上限，无法证明内容已完整扫描。",
  "archive-entry-limit": "归档成员数量超出上限，无法证明内容已完整扫描。",
  "archive-invalid": "归档结构无效或使用了不支持的格式，未将其视为安全。",
  "archive-member-limit": "归档成员超出单成员扫描上限，无法证明内容已完整扫描。",
  "archive-scan-limit": "归档累计展开内容超出扫描上限，无法证明内容已完整扫描。",
  "archive-too-large": "归档文件超出读取上限，无法证明内容已完整扫描。",
  "archive-unsafe-path": "归档包含不安全的绝对路径或目录穿越成员。",
  "build-output": "最终提交清单包含构建输出或发布产物。",
  "cgnat-host-ip": "检测到疑似真实 Tailnet/CGNAT 主机地址，地址已隐藏。",
  "content-scan-limit": "文件超出完整内容扫描上限，未将其视为安全。",
  "empty-scan": "扫描清单为空，未将其视为成功。",
  "generic-secret": "检测到高熵凭据赋值，内容已隐藏。",
  "gitlink": "最终提交清单包含 Git 子模块/gitlink，源码可能不会随仓库提交。",
  "jwt": "检测到 JWT，内容已隐藏。",
  "large-file": "文件超过仓库大文件阈值，请确认它不属于生成物并使用合适的制品存储。",
  "nested-git": "检测到嵌套 .git 元数据，源码可能被错误记录为独立仓库。",
  "private-development-file": "最终提交清单包含仅供内部使用的开发记录。",
  "read-error": "无法完整读取文件，未将其视为安全。",
  "sensitive-config": "最终提交清单包含环境文件、证书、密钥文件或签名凭据。",
  "symlink-outside-root": "符号链接指向项目根目录外部或使用绝对目标。",
  "tailnet-hostname": "检测到疑似真实 .ts.net 主机名，主机名已隐藏。",
  "unsupported-zip-entry": "ZIP 成员已加密或使用不支持的压缩方法，未将其视为安全。",
});

function normalizeRelative(value) {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function isWithinRoot(root, candidate) {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== "..");
}

function sanitizeLocation(value) {
  return String(value)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, "<redacted-token>")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g, "<redacted-token>")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<redacted-key>")
    .replace(/\b(?:npm_[A-Za-z0-9]{36,}|glpat-[A-Za-z0-9_-]{20,})\b/g, "<redacted-token>")
    .replace(/\b(?:sk-(?:proj|svcacct)-|sk-ant-(?:api\d{2}-)?|tskey-(?:api|auth|client)-)[A-Za-z0-9_-]{20,}\b/g, "<redacted-token>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g, "<redacted-jwt>")
    .replace(/\/Users\/[^/\\\s]+/g, "/Users/<redacted>")
    .replace(/\/home\/[^/\\\s]+/g, "/home/<redacted>")
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s]+/gi, "$1<redacted>")
    .replace(/(?:[A-Za-z0-9-]+\.){2,}[A-Za-z0-9-]*ts\.net/gi, "<redacted>.ts.net")
    .replace(/\b100\.(?:6[4-9]|[78][0-9]|9[0-9]|1[01][0-9]|12[0-7])(?:\.\d{1,3}){2}\b/g, "<redacted-cgnat-ip>");
}

function displayPath(root, absolutePath) {
  const relativePath = path.relative(root, absolutePath);
  if (relativePath && !relativePath.startsWith(`..${path.sep}`) && relativePath !== "..") {
    return normalizeRelative(relativePath);
  }
  if (relativePath === "") return ".";
  return sanitizeLocation(absolutePath);
}

function createState(options = {}) {
  return {
    findings: [],
    seen: new Set(),
    limits: { ...DEFAULT_LIMITS, ...(options.limits ?? {}) },
    root: path.resolve(options.root ?? process.cwd()),
    stats: {
      archiveEntries: 0,
      archives: 0,
      bytesScanned: 0,
      files: 0,
      skipped: 0,
    },
  };
}

function recordFinding(state, finding) {
  const safePath = sanitizeLocation(finding.path || ".");
  const line = Number.isInteger(finding.line) && finding.line > 0 ? finding.line : undefined;
  const key = `${finding.severity ?? "error"}|${finding.rule}|${safePath}|${line ?? ""}`;
  if (state.seen.has(key)) return;
  state.seen.add(key);
  state.findings.push({
    severity: finding.severity ?? "error",
    rule: finding.rule,
    path: safePath,
    ...(line ? { line } : {}),
    message: finding.message ?? RULE_MESSAGES[finding.rule] ?? "检测到发布前风险。",
  });
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function looksLikePlaceholder(value) {
  const normalized = value.toLowerCase();
  return [
    "<redacted>",
    "changeme",
    "dummy",
    "example",
    "fake",
  "placeholder",
  "private-user",
    "redacted",
    "replace-me",
    "sample",
    "secret-canary",
    "test-only",
    "top-secret",
    "your_",
    "xxxx",
  ].some((part) => normalized.includes(part)) || normalized.includes("${") || normalized.startsWith("$");
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function looksLikeHighEntropySecret(value) {
  if (value.length < 20 || value.length > 512 || looksLikePlaceholder(value)) return false;
  if (/^(?:https?|file):\/\//i.test(value)) return false;
  const classes = [/[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)];
  return classes.filter(Boolean).length >= 3 && new Set(value).size >= 12 && shannonEntropy(value) >= 3.5;
}

function isValidJwt(candidate) {
  const [header] = candidate.split(".");
  try {
    const decoded = Buffer.from(header, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" && typeof parsed.alg === "string";
  } catch {
    return false;
  }
}

function isPlaceholderTailnetHostname(hostname) {
  const labels = hostname.toLowerCase().split(".");
  return labels.some((label) => ["demo", "example", "invalid", "placeholder", "tailnet", "test"].includes(label));
}

function scanTextIntoState(text, location, state) {
  for (const rule of FIXED_TOKEN_RULES) {
    for (const match of text.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
      recordFinding(state, {
        rule: rule.id,
        path: location,
        line: lineNumberAt(text, match.index ?? 0),
        message: rule.message,
      });
    }
  }

  const jwtPattern = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g;
  for (const match of text.matchAll(jwtPattern)) {
    if (!isValidJwt(match[0])) continue;
    recordFinding(state, { rule: "jwt", path: location, line: lineNumberAt(text, match.index ?? 0) });
  }

  const assignmentPattern = /\b(api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)\b\s*["']?\s*[:=]\s*["'`]([^\s"'`]{20,512})["'`]/gi;
  for (const match of text.matchAll(assignmentPattern)) {
    if (!looksLikeHighEntropySecret(match[2])) continue;
    recordFinding(state, { rule: "generic-secret", path: location, line: lineNumberAt(text, match.index ?? 0) });
  }

  const authorizationPatterns = [
    /\bauthorization["']?\s*:\s*(["'`])(?:bearer\s+)?([A-Za-z0-9._~+/=-]{24,512})\1/gi,
    /(["'`])bearer\s+([A-Za-z0-9._~+/=-]{24,512})\1/gi,
  ];
  for (const pattern of authorizationPatterns) for (const match of text.matchAll(pattern)) {
    if (!looksLikeHighEntropySecret(match[2])) continue;
    recordFinding(state, { rule: "generic-secret", path: location, line: lineNumberAt(text, match.index ?? 0) });
  }

  const tailnetPattern = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z0-9-]*ts\.net\b/gi;
  for (const match of text.matchAll(tailnetPattern)) {
    if (isPlaceholderTailnetHostname(match[0])) continue;
    recordFinding(state, { rule: "tailnet-hostname", path: location, line: lineNumberAt(text, match.index ?? 0) });
  }

  const ipv4Pattern = /\b100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
  for (const match of text.matchAll(ipv4Pattern)) {
    const octets = [100, Number(match[1]), Number(match[2]), Number(match[3])];
    if (octets.some((octet) => octet < 0 || octet > 255) || octets[1] < 64 || octets[1] > 127) continue;
    if (DOCUMENTATION_CGNAT_ADDRESSES.has(match[0])) continue;
    const suffix = text.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 4);
    if (/^\/(?:[0-9]|[12][0-9]|3[0-2])\b/.test(suffix)) continue;
    recordFinding(state, { rule: "cgnat-host-ip", path: location, line: lineNumberAt(text, match.index ?? 0) });
  }

  const unixPathPattern = /(?<![A-Za-z0-9._-])\/(?:Users|home)\/([A-Za-z0-9._& -]{1,64})(?=\/|\\)/g;
  for (const match of text.matchAll(unixPathPattern)) {
    if (PLACEHOLDER_USERS.has(match[1].toLowerCase())) continue;
    recordFinding(state, { rule: "absolute-user-path", path: location, line: lineNumberAt(text, match.index ?? 0) });
  }

  const windowsPathPattern = /\b[A-Za-z]:[\\/]+Users[\\/]+([^\\/\r\n]{1,64})(?=[\\/])/gi;
  for (const match of text.matchAll(windowsPathPattern)) {
    if (PLACEHOLDER_USERS.has(match[1].toLowerCase())) continue;
    recordFinding(state, { rule: "absolute-user-path", path: location, line: lineNumberAt(text, match.index ?? 0) });
  }
}

export function scanTextContent(text, options = {}) {
  const state = createState(options);
  scanTextIntoState(String(text), options.path ?? "<memory>", state);
  return state.findings;
}

function bufferToSearchText(buffer) {
  if (buffer.length === 0) return "";
  const sampleLength = Math.min(buffer.length, 64 * 1024);
  let controlBytes = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index];
    if (byte === 0 || (byte < 9 && byte !== 0) || (byte > 13 && byte < 32)) controlBytes += 1;
  }
  if (controlBytes / sampleLength < 0.01) return buffer.toString("utf8");
  return [...buffer.toString("latin1").matchAll(/[\x20-\x7e]{8,}/g)].map((match) => match[0]).join("\n");
}

function isArchiveName(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(".tgz") || lower.endsWith(".tar.gz") || lower.endsWith(".zip");
}

function isUnsafeArchiveName(name) {
  const normalized = name.replaceAll("\\", "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..");
}

function tarString(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "").trim();
}

function parseTarSize(buffer, offset) {
  const first = buffer[offset];
  if ((first & 0x80) !== 0) throw new Error("base-256 tar sizes are not supported");
  const raw = tarString(buffer, offset, 12).replace(/\s/g, "");
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error("invalid tar size");
  return Number.parseInt(raw, 8);
}

function zipEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function archiveLocation(parent, memberName) {
  return `${parent}!${sanitizeLocation(memberName.replaceAll("\\", "/"))}`;
}

function consumeArchiveMember(name, content, location, state, budget, depth) {
  if (budget.entries >= state.limits.maxArchiveEntries) {
    recordFinding(state, { rule: "archive-entry-limit", path: location });
    return false;
  }
  budget.entries += 1;
  state.stats.archiveEntries += 1;

  const memberLocation = archiveLocation(location, name);
  scanTextIntoState(name, memberLocation, state);
  if (isUnsafeArchiveName(name)) recordFinding(state, { rule: "archive-unsafe-path", path: memberLocation });
  if (content.length > state.limits.maxArchiveMemberBytes) {
    recordFinding(state, { rule: "archive-member-limit", path: memberLocation });
    return true;
  }
  if (budget.scannedBytes + content.length > state.limits.maxArchiveScanBytes) {
    recordFinding(state, { rule: "archive-scan-limit", path: memberLocation });
    return false;
  }

  budget.scannedBytes += content.length;
  state.stats.bytesScanned += content.length;
  if (isArchiveName(name)) {
    scanArchiveBufferIntoState(content, name, memberLocation, state, budget, depth + 1);
  } else {
    scanTextIntoState(bufferToSearchText(content), memberLocation, state);
  }
  return true;
}

function scanTarBuffer(buffer, location, state, budget, depth) {
  let expanded;
  try {
    expanded = gunzipSync(buffer, { maxOutputLength: state.limits.maxArchiveExpandedBytes });
  } catch {
    recordFinding(state, { rule: "archive-invalid", path: location });
    return;
  }

  let offset = 0;
  let nextLongName;
  while (offset + 512 <= expanded.length) {
    const header = expanded.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    let memberSize;
    try {
      memberSize = parseTarSize(header, 124);
    } catch {
      recordFinding(state, { rule: "archive-invalid", path: location });
      return;
    }
    const type = String.fromCharCode(header[156] || 48);
    const prefix = tarString(header, 345, 155);
    const shortName = tarString(header, 0, 100);
    const memberName = nextLongName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    nextLongName = undefined;
    const dataStart = offset + 512;
    const dataEnd = dataStart + memberSize;
    if (!Number.isSafeInteger(memberSize) || dataEnd > expanded.length) {
      recordFinding(state, { rule: "archive-invalid", path: location });
      return;
    }
    const content = expanded.subarray(dataStart, dataEnd);
    if (type === "L") {
      nextLongName = content.toString("utf8").replace(/\0.*$/s, "");
    } else if (type === "0" || type === "\0" || type === "7") {
      if (!consumeArchiveMember(memberName, content, location, state, budget, depth)) return;
    } else {
      scanTextIntoState(memberName, archiveLocation(location, memberName), state);
      if (isUnsafeArchiveName(memberName)) {
        recordFinding(state, { rule: "archive-unsafe-path", path: archiveLocation(location, memberName) });
      }
    }
    offset = dataStart + Math.ceil(memberSize / 512) * 512;
  }
}

function scanZipBuffer(buffer, location, state, budget, depth) {
  const eocdOffset = zipEndOfCentralDirectory(buffer);
  if (eocdOffset < 0 || eocdOffset + 22 > buffer.length) {
    recordFinding(state, { rule: "archive-invalid", path: location });
    return;
  }
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || centralOffset === 0xffffffff || entryCount > state.limits.maxArchiveEntries) {
    recordFinding(state, { rule: "archive-entry-limit", path: location });
    return;
  }

  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      recordFinding(state, { rule: "archive-invalid", path: location });
      return;
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const expandedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > buffer.length || localOffset + 30 > buffer.length) {
      recordFinding(state, { rule: "archive-invalid", path: location });
      return;
    }
    const memberName = buffer.subarray(offset + 46, nameEnd).toString((flags & 0x0800) !== 0 ? "utf8" : "latin1");
    const memberLocation = archiveLocation(location, memberName);
    if ((flags & 0x0001) !== 0 || ![0, 8].includes(method)) {
      recordFinding(state, { rule: "unsupported-zip-entry", path: memberLocation });
      offset = nameEnd + extraLength + commentLength;
      continue;
    }
    if (expandedSize > state.limits.maxArchiveMemberBytes) {
      recordFinding(state, { rule: "archive-member-limit", path: memberLocation });
      offset = nameEnd + extraLength + commentLength;
      continue;
    }
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      recordFinding(state, { rule: "archive-invalid", path: memberLocation });
      return;
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      recordFinding(state, { rule: "archive-invalid", path: memberLocation });
      return;
    }
    let content;
    try {
      const compressed = buffer.subarray(dataStart, dataEnd);
      content = method === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: state.limits.maxArchiveMemberBytes });
    } catch {
      recordFinding(state, { rule: "archive-invalid", path: memberLocation });
      offset = nameEnd + extraLength + commentLength;
      continue;
    }
    if (content.length !== expandedSize) {
      recordFinding(state, { rule: "archive-invalid", path: memberLocation });
      offset = nameEnd + extraLength + commentLength;
      continue;
    }
    if (!memberName.endsWith("/") && !consumeArchiveMember(memberName, content, location, state, budget, depth)) return;
    offset = nameEnd + extraLength + commentLength;
  }
}

function scanArchiveBufferIntoState(buffer, name, location, state, budget, depth) {
  if (depth > state.limits.maxArchiveDepth) {
    recordFinding(state, { rule: "archive-depth-limit", path: location });
    return;
  }
  state.stats.archives += 1;
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip")) scanZipBuffer(buffer, location, state, budget, depth);
  else scanTarBuffer(buffer, location, state, budget, depth);
}

export function scanArchiveContent(buffer, options = {}) {
  const state = createState(options);
  const name = options.name ?? "artifact.tgz";
  scanArchiveBufferIntoState(buffer, name, options.path ?? name, state, { entries: 0, scannedBytes: 0 }, 0);
  return { findings: state.findings, stats: state.stats };
}

function isPrivateDevelopmentPath(relativePath) {
  const base = path.posix.basename(relativePath);
  return PRIVATE_DEVELOPMENT_FILES.has(base) || base.startsWith("autoresearch-");
}

function isSensitiveConfigPath(relativePath) {
  const base = path.posix.basename(relativePath).toLowerCase();
  if (base.startsWith(".env") && base !== ".env.example") return true;
  return /\.(?:cer|crt|key|mobileprovision|p12|pem|pfx|provisionprofile)$/.test(base);
}

function isGeneratedPath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  const segments = normalized.split("/");
  const base = path.posix.basename(normalized);
  if (segments.some((segment) => DEFAULT_EXCLUDED_DIRECTORIES.has(segment))) return true;
  if (DEFAULT_EXCLUDED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return true;
  if (normalized.startsWith("src-tauri/resources/") && /\.(?:tgz|zip)$/.test(normalized)) return true;
  if (base === "trace.zip") return true;
  return /\.(?:AppImage|deb|dmg|msi|rpm|sig)$/.test(normalized);
}

function isPrivacyScanFixturePath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  return DEFAULT_EXCLUDED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function shouldExcludeNoGit(relativePath, isDirectory, extraExcludes) {
  const normalized = normalizeRelative(relativePath);
  const base = path.posix.basename(normalized);
  if (isDirectory && DEFAULT_EXCLUDED_DIRECTORIES.has(base)) return true;
  if (DEFAULT_EXCLUDED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return true;
  if (extraExcludes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return true;
  if (isPrivateDevelopmentPath(normalized) || isSensitiveConfigPath(normalized)) return true;
  if (/\.(?:AppImage|deb|dmg|log|msi|rpm|sig|tsbuildinfo)$/.test(base)) return true;
  if (normalized.startsWith("src-tauri/resources/") && /\.(?:tgz|zip)$/.test(base)) return true;
  return [".DS_Store", "Thumbs.db", "next-env.d.ts"].includes(base);
}

async function gitOutput(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function gitTrackedFiles(root, state) {
  try {
    const topLevel = (await gitOutput(root, ["rev-parse", "--show-toplevel"])).trim();
    const [resolvedTopLevel, resolvedRoot] = await Promise.all([realpath(topLevel), realpath(root)]);
    if (resolvedTopLevel !== resolvedRoot) return null;
    const staged = await gitOutput(root, ["ls-files", "--stage", "-z"]);
    const files = [];
    for (const record of staged.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const metadata = record.slice(0, tab).split(" ");
      const relativePath = record.slice(tab + 1);
      if (metadata[0] === "160000") {
        recordFinding(state, { rule: "gitlink", path: normalizeRelative(relativePath) });
        continue;
      }
      if (metadata[2] === "0") files.push(relativePath);
    }
    return [...new Set(files)];
  } catch {
    return null;
  }
}

async function walkNoGit(root, current, files, state, extraExcludes, explicit = false) {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    recordFinding(state, { rule: "read-error", path: displayPath(root, current) });
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = normalizeRelative(path.relative(root, absolutePath));
    if (entry.name === ".git") {
      if (relativePath !== ".git") recordFinding(state, { rule: "nested-git", path: relativePath });
      state.stats.skipped += 1;
      continue;
    }
    if (shouldExcludeNoGit(relativePath, entry.isDirectory(), extraExcludes)) {
      state.stats.skipped += 1;
      continue;
    }
    if (entry.isDirectory()) {
      await walkNoGit(root, absolutePath, files, state, extraExcludes, explicit);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(absolutePath);
    }
  }
}

async function findNestedGit(root, current, state, extraExcludes) {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = normalizeRelative(path.relative(root, absolutePath));
    if (entry.name === ".git") {
      if (relativePath !== ".git") recordFinding(state, { rule: "nested-git", path: relativePath });
      continue;
    }
    if (!entry.isDirectory() || shouldExcludeNoGit(relativePath, true, extraExcludes)) continue;
    await findNestedGit(root, absolutePath, state, extraExcludes);
  }
}

async function readFilePrefix(absolutePath, bytes) {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function scanFile(absolutePath, location, state, options = {}) {
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch {
    recordFinding(state, { rule: "read-error", path: location });
    return;
  }
  if (metadata.isSymbolicLink()) {
    let target;
    try {
      target = await readlink(absolutePath);
    } catch {
      recordFinding(state, { rule: "read-error", path: location });
      return;
    }
    scanTextIntoState(target, location, state);
    const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
    if (path.isAbsolute(target) || !isWithinRoot(state.root, resolvedTarget)) {
      recordFinding(state, { rule: "symlink-outside-root", path: location });
    }
    state.stats.files += 1;
    state.stats.bytesScanned += Buffer.byteLength(target);
    return;
  }
  if (!metadata.isFile()) return;

  state.stats.files += 1;
  if (!options.explicit) {
    if (isGeneratedPath(location) && !isPrivacyScanFixturePath(location)) {
      recordFinding(state, { rule: "build-output", path: location });
    }
    if (isPrivateDevelopmentPath(location)) recordFinding(state, { rule: "private-development-file", path: location });
    if (isSensitiveConfigPath(location)) recordFinding(state, { rule: "sensitive-config", path: location });
  }
  if (metadata.size > state.limits.largeFileBytes) {
    recordFinding(state, { severity: "warning", rule: "large-file", path: location });
  }

  if (isArchiveName(location)) {
    if (metadata.size > state.limits.maxArchiveBytes) {
      recordFinding(state, { rule: "archive-too-large", path: location });
      return;
    }
    try {
      const buffer = await readFile(absolutePath);
      state.stats.bytesScanned += buffer.length;
      scanArchiveBufferIntoState(buffer, location, location, state, { entries: 0, scannedBytes: 0 }, 0);
    } catch {
      recordFinding(state, { rule: "read-error", path: location });
    }
    return;
  }

  let buffer;
  try {
    if (metadata.size > state.limits.maxFileBytes) {
      recordFinding(state, { rule: "content-scan-limit", path: location });
      buffer = await readFilePrefix(absolutePath, state.limits.maxFileBytes);
    } else {
      buffer = await readFile(absolutePath);
    }
  } catch {
    recordFinding(state, { rule: "read-error", path: location });
    return;
  }
  state.stats.bytesScanned += buffer.length;
  scanTextIntoState(bufferToSearchText(buffer), location, state);
}

function normalizedExcludes(values = []) {
  return values.map((value) => {
    const normalized = normalizeRelative(String(value).replace(/[\\/]+$/, ""));
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(value)) {
      throw new Error("invalid exclusion");
    }
    return normalized;
  });
}

export async function scanRepository(options = {}) {
  const state = createState(options);
  const extraExcludes = normalizedExcludes(options.excludes);
  const tracked = await gitTrackedFiles(state.root, state);
  const files = [];
  let source;
  if (tracked) {
    source = "git-ls-files";
    await findNestedGit(state.root, state.root, state, extraExcludes);
    for (const relativePath of tracked) files.push(path.resolve(state.root, relativePath));
  } else {
    source = "filesystem";
    await walkNoGit(state.root, state.root, files, state, extraExcludes);
  }

  for (const absolutePath of files) {
    await scanFile(absolutePath, displayPath(state.root, absolutePath), state);
  }
  if (files.length === 0) recordFinding(state, { rule: "empty-scan", path: "." });
  return { source, findings: state.findings, stats: state.stats };
}

export async function scanPaths(inputPaths, options = {}) {
  const state = createState(options);
  const extraExcludes = normalizedExcludes(options.excludes);
  const files = [];
  for (const inputPath of inputPaths) {
    const absolutePath = path.resolve(state.root, inputPath);
    let metadata;
    try {
      metadata = await stat(absolutePath);
    } catch {
      recordFinding(state, { rule: "read-error", path: displayPath(state.root, absolutePath) });
      continue;
    }
    if (metadata.isDirectory()) {
      await walkNoGit(state.root, absolutePath, files, state, extraExcludes, true);
    } else {
      files.push(absolutePath);
    }
  }
  for (const absolutePath of files) {
    await scanFile(absolutePath, displayPath(state.root, absolutePath), state, { explicit: true });
  }
  if (files.length === 0 && state.findings.length === 0) recordFinding(state, { rule: "empty-scan", path: "." });
  return { source: "explicit-paths", findings: state.findings, stats: state.stats };
}

function usage() {
  return `用法: node scripts/privacy-scan.mjs [选项] [待扫描文件或目录...]

默认扫描最终拟提交文件：Git 仓库使用 git ls-files；尚未初始化 Git 时遍历项目并跳过明确的生成目录。

选项:
  --root <目录>          项目根目录，默认当前目录
  --exclude <相对目录>  额外跳过目录，可重复
  --json                 输出不包含命中值的 JSON
  --fail-on-warnings     将大文件警告也视为失败
  --help                 显示帮助

退出码: 0=通过，1=发现阻断项，2=扫描器使用或运行错误`;
}

function parseArguments(argv) {
  const parsed = { excludes: [], failOnWarnings: false, json: false, paths: [], root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--json") parsed.json = true;
    else if (argument === "--fail-on-warnings") parsed.failOnWarnings = true;
    else if (argument === "--root") {
      if (!argv[index + 1]) throw new Error("--root requires a value");
      parsed.root = path.resolve(argv[index += 1]);
    } else if (argument === "--exclude") {
      if (!argv[index + 1]) throw new Error("--exclude requires a value");
      parsed.excludes.push(argv[index += 1]);
    } else if (argument.startsWith("-")) {
      throw new Error("unknown option");
    } else {
      parsed.paths.push(argument);
    }
  }
  return parsed;
}

export function formatReport(result, options = {}) {
  const counts = result.findings.reduce((summary, finding) => {
    summary[finding.severity] = (summary[finding.severity] ?? 0) + 1;
    return summary;
  }, {});
  if (options.json) {
    return JSON.stringify({
      source: result.source,
      summary: {
        errors: counts.error ?? 0,
        warnings: counts.warning ?? 0,
        ...result.stats,
      },
      findings: result.findings,
    }, null, 2);
  }
  const lines = result.findings.map((finding) => {
    const location = `${finding.path}${finding.line ? `:${finding.line}` : ""}`;
    return `[${finding.severity.toUpperCase()}] ${finding.rule} ${location} - ${finding.message}`;
  });
  lines.push(`扫描来源: ${result.source}`);
  lines.push(`结果: ${counts.error ?? 0} 个错误, ${counts.warning ?? 0} 个警告; ${result.stats.files} 个文件, ${result.stats.archives} 个归档。`);
  return lines.join("\n");
}

async function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return 0;
    }
    const options = { root: args.root, excludes: args.excludes };
    const result = args.paths.length > 0
      ? await scanPaths(args.paths, options)
      : await scanRepository(options);
    console.log(formatReport(result, { json: args.json }));
    const errors = result.findings.some((finding) => finding.severity === "error");
    const warnings = result.findings.some((finding) => finding.severity === "warning");
    return errors || (args.failOnWarnings && warnings) ? 1 : 0;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "invalid-input";
    console.error(`隐私扫描失败（${sanitizeLocation(code)}）。`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) process.exitCode = await main();
