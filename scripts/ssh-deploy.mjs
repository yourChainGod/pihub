#!/usr/bin/env node
/**
 * PiHub Server SSH 一键部署：安装 / 升级 / 配置。
 *
 * 复用桌面端同一套安装管线（src-tauri/src/setup.rs 的常量与模板），
 * 但面向命令行：先探测远端（平台、Node、现有安装、旧服务冲突、Tailscale
 * Serve 状态），再决定安装或升级，本地发布包经 SSH stdin 直传，远端执行
 * 与桌面端完全相同的 bootstrap（事务 journal、健康检查、失败回滚）。
 *
 * 用法：
 *   node scripts/ssh-deploy.mjs <target> [选项]
 *
 *   target                 [user@]host；默认走 tailscale ssh，Linux 缺省用户 root
 *   --user <name>          远端 SSH 用户
 *   --plain-ssh            使用系统 ssh 而非 tailscale ssh
 *   --allow-root           允许以 root 身份安装（远端 uid=0 时必需）
 *   --auto-pair            安装成功后签发一次性配对码（只打印一次，不落盘）
 *   --archive <file>       指定发布包 tar.gz
 *   --archive-dir <dir>    发布包目录（默认 release-artifacts/）
 *   --extensions <a,b,c>   只安装指定的签名插件子集（默认全部）
 *   --stop-legacy          安装前停用冲突的旧版系统服务（pihub-server.service）
 *   --force                允许降级 / 同版本重装
 *   --check                只探测与体检，不做任何改动
 *   --yes                  跳过交互确认（非 TTY 时必需）
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SETUP_RS_PATH = path.join(REPO_ROOT, "src-tauri", "src", "setup.rs");
const BOOTSTRAP_UNIX_PATH = path.join(REPO_ROOT, "src-tauri", "src", "bootstrap_unix.sh");
const STANDALONE_BOOTSTRAP_PATH = path.join(REPO_ROOT, "src-tauri", "src", "standalone_bootstrap.mjs");

const MAX_LOCAL_ARCHIVE_BYTES = 512 * 1024 * 1024;
const SSH_PROBE_TIMEOUT_MS = 30_000;
const PLACEHOLDER_PATTERN = /__[A-Z0-9_]+__/;

// ── setup.rs 常量（唯一事实来源在 Rust 侧，这里按文本解析，避免双份维护） ──────

export function parseSetupConstants(source) {
  const constants = {};
  for (const match of source.matchAll(/(PIHUB_[A-Z0-9_]+): &str =\s*"([^"]+)"/g)) {
    constants[match[1]] = match[2];
  }
  const packagesBlock = source.match(/PIHUB_EXTENSION_PACKAGES[^=]*= \[([\s\S]*?)\];/);
  if (!packagesBlock) throw new Error("setup.rs 中未找到 PIHUB_EXTENSION_PACKAGES");
  const extensionPackages = [];
  for (const match of packagesBlock[1].matchAll(/name:\s*"([^"]+)"[\s\S]*?version:\s*"([^"]+)"/g)) {
    extensionPackages.push({ name: match[1], version: match[2] });
  }
  const required = [
    "PIHUB_SERVER_VERSION",
    "PIHUB_SERVER_RELEASE_OWNER",
    "PIHUB_SERVER_RELEASE_REPO",
    "PIHUB_SERVER_RELEASE_CHANNEL",
    "PIHUB_SERVER_RELEASE_PUBLIC_KEY",
    "PIHUB_SERVER_RELEASE_MANIFEST_URL",
    "PIHUB_PI_AGENT_PACKAGE",
    "PIHUB_PI_AGENT_VERSION",
    "PIHUB_NODE_VERSION",
    "PIHUB_NODE_LINUX_X64_SHA256",
    "PIHUB_NODE_LINUX_ARM64_SHA256",
    "PIHUB_NODE_DARWIN_ARM64_SHA256",
    "PIHUB_NODE_DARWIN_X64_SHA256",
  ];
  for (const key of required) {
    if (!constants[key]) throw new Error(`setup.rs 中缺少常量 ${key}`);
  }
  if (extensionPackages.length === 0) throw new Error("setup.rs 中未解析到任何签名插件");
  return { constants, extensionPackages };
}

function base64UrlEncode(text) {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** 与 setup.rs render_standalone_bootstrap_helper 等价。 */
export function renderStandaloneBootstrap(template, constants, extensionPackages) {
  const packagesJson = JSON.stringify(
    extensionPackages.map((pkg) => ({ name: pkg.name, version: pkg.version })),
  );
  const rendered = template
    .replaceAll("__RELEASE_OWNER__", constants.PIHUB_SERVER_RELEASE_OWNER)
    .replaceAll("__RELEASE_REPO__", constants.PIHUB_SERVER_RELEASE_REPO)
    .replaceAll("__RELEASE_CHANNEL__", constants.PIHUB_SERVER_RELEASE_CHANNEL)
    .replaceAll("__RELEASE_PUBLIC_KEY__", constants.PIHUB_SERVER_RELEASE_PUBLIC_KEY)
    .replaceAll("__RELEASE_MANIFEST_URL__", constants.PIHUB_SERVER_RELEASE_MANIFEST_URL)
    .replaceAll("__MINIMUM_SERVER_VERSION__", constants.PIHUB_SERVER_VERSION)
    .replaceAll("__PI_AGENT_PACKAGE__", constants.PIHUB_PI_AGENT_PACKAGE)
    .replaceAll("__PI_AGENT_VERSION__", constants.PIHUB_PI_AGENT_VERSION)
    .replaceAll("__EXTENSION_PACKAGES_BASE64__", Buffer.from(packagesJson, "utf8").toString("base64"));
  if (PLACEHOLDER_PATTERN.test(rendered)) {
    throw new Error("standalone_bootstrap.mjs 渲染后仍含未替换占位符");
  }
  return rendered;
}

/** 与 setup.rs selected_extension_argument 等价；空选择返回 null（不装插件）。 */
export function buildExtensionSelection(selection, extensionPackages) {
  const names = selection ?? extensionPackages.map((pkg) => pkg.name);
  const known = new Map(extensionPackages.map((pkg) => [pkg.name, pkg]));
  const seen = new Set();
  const selected = [];
  for (const name of names) {
    if (seen.has(name)) throw new Error(`插件选择包含重复项：${name}`);
    seen.add(name);
    const pkg = known.get(name);
    if (!pkg) throw new Error(`插件不在 PiHub 签名清单中：${name}`);
    selected.push({ name: pkg.name, version: pkg.version });
  }
  if (selected.length === 0) return null;
  return base64UrlEncode(JSON.stringify(selected));
}

/** 与 setup.rs render_unix_bootstrap_script 等价。 */
export function renderUnixBootstrap(template, standaloneBootstrap, options) {
  const rendered = template
    .replaceAll("__STANDALONE_BOOTSTRAP__", Buffer.from(standaloneBootstrap, "utf8").toString("base64"))
    .replaceAll("__EXTENSION_SELECTION_BASE64__", options.extensionSelection ?? "")
    .replaceAll("__PIHUB_ALLOW_ROOT__", options.allowRoot ? "1" : "0")
    .replaceAll("__PIHUB_AUTO_PAIR__", options.autoPair ? "1" : "0")
    .replaceAll("__PIHUB_LOCAL_ARCHIVE__", options.localArchiveSha256 ? "1" : "0")
    .replaceAll("__PIHUB_LOCAL_ARCHIVE_SHA256__", options.localArchiveSha256 ?? "")
    .replaceAll("__NODE_VERSION__", options.constants.PIHUB_NODE_VERSION)
    .replaceAll("__NODE_LINUX_X64_SHA256__", options.constants.PIHUB_NODE_LINUX_X64_SHA256)
    .replaceAll("__NODE_LINUX_ARM64_SHA256__", options.constants.PIHUB_NODE_LINUX_ARM64_SHA256)
    .replaceAll("__NODE_DARWIN_ARM64_SHA256__", options.constants.PIHUB_NODE_DARWIN_ARM64_SHA256)
    .replaceAll("__NODE_DARWIN_X64_SHA256__", options.constants.PIHUB_NODE_DARWIN_X64_SHA256);
  if (PLACEHOLDER_PATTERN.test(rendered)) {
    throw new Error("bootstrap_unix.sh 渲染后仍含未替换占位符");
  }
  return rendered;
}

// ── 远端探测 ─────────────────────────────────────────────────────────────────

const PROBE_SCRIPT = [
  'echo "PROBE_UNAME=$(uname -sm)"',
  'echo "PROBE_UID=$(id -u)"',
  'echo "PROBE_HOME=$HOME"',
  'node_bin=""',
  'if command -v node >/dev/null 2>&1; then node_bin=$(command -v node)',
  'else for d in "$HOME"/.local/share/pi-node/node-*/bin; do if [ -x "$d/node" ]; then node_bin="$d/node"; break; fi; done; fi',
  'if [ -n "$node_bin" ]; then echo "PROBE_NODE=$($node_bin -v)"; else echo "PROBE_NODE="; fi',
  'echo "PROBE_PIHUB_VERSION=$(cat "$HOME/.local/share/pihub/server/state/current.json" 2>/dev/null | sed -n \'s/.*"version"[": ]*\\([^"]*\\)".*/\\1/p\')"',
  'echo "PROBE_PIHUB_VERSIONS=$(ls "$HOME/.local/share/pihub/server/versions" 2>/dev/null | tr "\\n" " ")"',
  'echo "PROBE_PIHUB_RUNNING=$(curl -s --max-time 5 http://127.0.0.1:30141/api/health 2>/dev/null | sed -n \'s/.*"version"[": ]*\\([^"]*\\)".*/\\1/p\')"',
  'legacy=""',
  'if command -v systemctl >/dev/null 2>&1 && systemctl cat pihub-server.service >/dev/null 2>&1; then legacy="pihub-server.service"; fi',
  'if ps -eo args 2>/dev/null | grep "[p]i-web" | grep -qv "pihub"; then legacy="$legacy pi-web-process"; fi',
  'echo "PROBE_LEGACY=$(echo $legacy)"',
  'if command -v tailscale >/dev/null 2>&1; then echo "PROBE_TAILSCALE=yes"; else echo "PROBE_TAILSCALE="; fi',
  'if tailscale serve status 2>/dev/null | grep -q 30141; then echo "PROBE_SERVE=mounted"; else echo "PROBE_SERVE="; fi',
  'echo "PROBE_TMP_KB=$(df -k /tmp 2>/dev/null | tail -1 | awk \'{print $4}\')"',
].join("\n");

export function parseProbeOutput(output) {
  const probe = {};
  for (const line of output.split("\n")) {
    const match = line.match(/^PROBE_([A-Z_]+)=(.*)$/);
    if (match) probe[match[1]] = match[2].trim();
  }
  if (!probe.UNAME) throw new Error("远端探测失败：未收到平台信息（检查 SSH 连通性）");
  return {
    uname: probe.UNAME,
    uid: probe.UID ?? "",
    home: probe.HOME ?? "",
    node: probe.NODE || null,
    pihubVersion: probe.PIHUB_VERSION || null,
    pihubVersions: (probe.PIHUB_VERSIONS ?? "").split(/\s+/).filter(Boolean),
    pihubRunning: probe.PIHUB_RUNNING || null,
    legacyConflicts: (probe.LEGACY ?? "").split(/\s+/).filter(Boolean),
    tailscale: probe.TAILSCALE === "yes",
    serveMounted: probe.SERVE === "mounted",
    tmpFreeKb: Number(probe.TMP_KB) || 0,
  };
}

/** uname（"Linux x86_64"）→ 发布包平台后缀（"linux-x64"）。 */
export function platformFromUname(uname) {
  const [os, arch] = uname.split(/\s+/);
  const platform = { Linux: "linux", Darwin: "darwin" }[os];
  const normalizedArch = { x86_64: "x64", amd64: "x64", arm64: "arm64", aarch64: "arm64" }[arch];
  if (!platform || !normalizedArch) {
    throw new Error(`不支持的远端平台：${uname}（发布包仅提供 linux/darwin × x64/arm64）`);
  }
  return { platform, arch: normalizedArch };
}

// ── 本地发布包选择 ────────────────────────────────────────────────────────────

export function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const pb = b.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va === vb) continue;
    if (typeof va === "number" && typeof vb === "number") return va - vb;
    return String(va) < String(vb) ? -1 : 1;
  }
  return 0;
}

export function selectArchive(archiveDir, platform, arch) {
  const suffix = `-${platform}-${arch}.tar.gz`;
  const candidates = [];
  if (fs.existsSync(archiveDir)) {
    for (const entry of fs.readdirSync(archiveDir)) {
      const match = entry.match(/^pihub-server-(.+)-[a-z]+-(?:x64|arm64)\.tar\.gz$/);
      if (!match || !entry.endsWith(suffix)) continue;
      candidates.push({ version: match[1], file: path.join(archiveDir, entry) });
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `${archiveDir} 中没有匹配 pihub-server-*-${platform}-${arch}.tar.gz 的发布包；` +
      "先在构建机出包（见 docs/worklog-handoff-selfhost.zh-CN.md），或用 --archive 指定",
    );
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  const chosen = candidates[0];
  const sidecar = `${chosen.file}.sha256`;
  if (!fs.existsSync(sidecar)) throw new Error(`本地发布包缺少同名校验文件：${sidecar}`);
  const sidecarMatch = fs.readFileSync(sidecar, "utf8").match(/^([a-f0-9]{64})\s+\*?(\S+)\s*$/m);
  if (!sidecarMatch) throw new Error(`${sidecar} 格式无效`);
  if (sidecarMatch[2] !== path.basename(chosen.file)) {
    throw new Error(`${sidecar} 记录的文件名与发布包不一致`);
  }
  const bytes = fs.readFileSync(chosen.file);
  if (bytes.length === 0 || bytes.length > MAX_LOCAL_ARCHIVE_BYTES) {
    throw new Error(`本地发布包大小异常（${bytes.length} 字节），已拒绝发送`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sidecarMatch[1]) {
    throw new Error("本地发布包内容与 .sha256 校验和不一致，已拒绝发送");
  }
  return { version: chosen.version, file: chosen.file, bytes, sha256: actual };
}

// ── 动作决策 ─────────────────────────────────────────────────────────────────

export function decideAction(probe, archiveVersion, { force = false } = {}) {
  if (!probe.pihubVersion) return { action: "install" };
  const diff = compareVersions(archiveVersion, probe.pihubVersion);
  if (diff > 0) return { action: "upgrade", from: probe.pihubVersion, to: archiveVersion };
  if (diff === 0 && !force) {
    return {
      action: "blocked",
      reason: `远端已安装相同版本 ${probe.pihubVersion}；如需重装请加 --force`,
    };
  }
  if (diff < 0 && !force) {
    return {
      action: "blocked",
      reason: `远端版本 ${probe.pihubVersion} 高于发布包 ${archiveVersion}；如需降级请加 --force`,
    };
  }
  return { action: "reinstall", from: probe.pihubVersion, to: archiveVersion };
}

// ── SSH 执行 ─────────────────────────────────────────────────────────────────

function sshSpec(target, { plainSsh }) {
  const executable = plainSsh ? "ssh" : "tailscale";
  const args = plainSsh ? [target] : ["ssh", target];
  return { executable, args };
}

function runSsh(spec, remoteCommand, { stdin, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, [...spec.args, remoteCommand], {
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = timeoutMs
      ? setTimeout(() => { child.kill("SIGKILL"); reject(new Error("SSH 命令超时")); }, timeoutMs)
      : null;
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`SSH 命令失败（退出码 ${code}）：${stderr.trim().split("\n").pop() ?? ""}`));
    });
    if (stdin) child.stdin.end(stdin);
  });
}

/** 流式执行远端 bootstrap：脚本作为远端命令，发布包字节走 stdin（与桌面端一致）。 */
function runBootstrap(spec, script, archiveBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, [...spec.args, script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let pairingCode = null;
    let approvalUrl = null;
    let bootstrapOk = false;
    const handleChunk = (prefix) => (chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line) continue;
        const pairMatch = line.match(/^PIHUB_PAIRING_CODE=(\S+)/);
        if (pairMatch) { pairingCode = pairMatch[1]; continue; }
        const approvalMatch = line.match(/^PIHUB_SERVE_APPROVAL=(\S+)/);
        if (approvalMatch) { approvalUrl = approvalMatch[1]; continue; }
        if (line.includes("PIHUB_BOOTSTRAP_OK")) bootstrapOk = true;
        console.log(`${prefix}${line}`);
      }
    };
    child.stdout.on("data", handleChunk(""));
    child.stderr.on("data", handleChunk("[stderr] "));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, pairingCode, approvalUrl, bootstrapOk }));
    if (archiveBytes) child.stdin.end(archiveBytes);
    else child.stdin.end();
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    target: null,
    user: null,
    plainSsh: false,
    allowRoot: false,
    autoPair: false,
    archive: null,
    archiveDir: path.join(REPO_ROOT, "release-artifacts"),
    extensions: null,
    stopLegacy: false,
    force: false,
    check: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user") options.user = argv[++i];
    else if (arg === "--plain-ssh") options.plainSsh = true;
    else if (arg === "--allow-root") options.allowRoot = true;
    else if (arg === "--auto-pair") options.autoPair = true;
    else if (arg === "--archive") options.archive = argv[++i];
    else if (arg === "--archive-dir") options.archiveDir = path.resolve(argv[++i]);
    else if (arg === "--extensions") options.extensions = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--stop-legacy") options.stopLegacy = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--help" || arg === "-h") { printUsage(); process.exit(0); }
    else if (!arg.startsWith("-") && !options.target) options.target = arg;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!options.target) {
    printUsage();
    throw new Error("缺少目标机器");
  }
  return options;
}

function printUsage() {
  console.log("用法：node scripts/ssh-deploy.mjs <[user@]host> [--user root] [--plain-ssh] [--allow-root]");
  console.log("      [--auto-pair] [--archive file] [--archive-dir dir] [--extensions a,b]");
  console.log("      [--stop-legacy] [--force] [--check] [--yes]");
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const setupSource = fs.readFileSync(SETUP_RS_PATH, "utf8");
  const { constants, extensionPackages } = parseSetupConstants(setupSource);
  const standaloneTemplate = fs.readFileSync(STANDALONE_BOOTSTRAP_PATH, "utf8");
  const unixTemplate = fs.readFileSync(BOOTSTRAP_UNIX_PATH, "utf8");

  // 目标规范化：缺省用户 Linux 下按 root（tailnet ACL 通常只放行 root）。
  const target = options.target.includes("@")
    ? options.target
    : `${options.user ?? "root"}@${options.target}`;
  const sshUser = target.split("@")[0];
  const spec = sshSpec(target, options);

  console.log(`[deploy] 目标：${target}（${options.plainSsh ? "ssh" : "tailscale ssh"}）`);

  console.log("[deploy] 探测远端…");
  const probe = parseProbeOutput(
    (await runSsh(spec, PROBE_SCRIPT, { timeoutMs: SSH_PROBE_TIMEOUT_MS })).stdout,
  );
  const { platform, arch } = platformFromUname(probe.uname);

  console.log(`[deploy] 平台：${probe.uname}（包后缀 ${platform}-${arch}）`);
  console.log(`[deploy] Node：${probe.node ?? "未安装（将自动安装 " + constants.PIHUB_NODE_VERSION + "）"}`);
  console.log(`[deploy] 现有安装：${probe.pihubVersion ?? "无"}${probe.pihubRunning ? `（服务运行中 ${probe.pihubRunning}）` : ""}`);
  console.log(`[deploy] Tailscale：${probe.tailscale ? "已安装" : "未找到（bootstrap 会拒绝继续）"}；Serve 30141：${probe.serveMounted ? "已挂载" : "未挂载（将自动配置）"}`);
  if (probe.legacyConflicts.length > 0) {
    console.log(`[deploy] 旧版冲突：${probe.legacyConflicts.join(", ")}`);
  }

  if (options.check) return;

  if (probe.uid === "0" && !options.allowRoot) {
    throw new Error("远端是 root；如确认以 root 安装请加 --allow-root");
  }
  if (sshUser === "root" && !options.allowRoot) {
    throw new Error("将以 root 身份安装；如确认请加 --allow-root");
  }
  if (probe.legacyConflicts.includes("pihub-server.service") && !options.stopLegacy) {
    throw new Error("检测到旧版系统服务 pihub-server.service；确认停用后加 --stop-legacy");
  }

  // 发布包
  const archive = options.archive
    ? selectSpecificArchive(options.archive, platform, arch)
    : selectArchive(options.archiveDir, platform, arch);
  console.log(`[deploy] 发布包：${path.basename(archive.file)}（${(archive.bytes.length / 1024 / 1024).toFixed(1)} MB，sha256 已校验）`);

  const decision = decideAction(probe, archive.version, { force: options.force });
  if (decision.action === "blocked") throw new Error(decision.reason);
  console.log(`[deploy] 动作：${decision.action === "install" ? "全新安装" : decision.action === "upgrade" ? `升级 ${decision.from} → ${decision.to}` : `重装 ${decision.to}`}`);

  if (!options.yes && !(await confirm("[deploy] 确认继续？[y/N] "))) {
    throw new Error("已取消");
  }

  if (options.stopLegacy && probe.legacyConflicts.includes("pihub-server.service")) {
    console.log("[deploy] 停用旧版系统服务 pihub-server.service…");
    await runSsh(spec, "systemctl stop pihub-server.service && systemctl disable pihub-server.service", { timeoutMs: 30_000 });
  }

  const extensionSelection = buildExtensionSelection(options.extensions, extensionPackages);
  const standalone = renderStandaloneBootstrap(standaloneTemplate, constants, extensionPackages);
  const script = renderUnixBootstrap(unixTemplate, standalone, {
    constants,
    extensionSelection,
    allowRoot: sshUser === "root",
    localArchiveSha256: archive.sha256,
    autoPair: options.autoPair,
  });

  console.log("[deploy] 开始传输并安装（大于是 200MB 的包在 DERP 中转会较慢）…");
  const result = await runBootstrap(spec, script, archive.bytes);
  if (!result.bootstrapOk || result.code !== 0) {
    throw new Error(`远端安装失败（退出码 ${result.code}）；旧版本已自动回滚`);
  }

  if (result.approvalUrl) {
    console.log(`[deploy] Tailscale Serve 需要审批：${result.approvalUrl}`);
  }
  if (result.pairingCode) {
    console.log("[deploy] 一次性配对码（仅此一次显示，10 分钟有效，请立即在桌面端完成配对）：");
    console.log(`  ${result.pairingCode}`);
  }

  console.log("[deploy] 验证服务健康…");
  const health = await runSsh(spec, "curl -s --max-time 10 http://127.0.0.1:30141/api/health", { timeoutMs: 20_000 });
  console.log(`[deploy] 健康检查：${health.stdout.trim() || "无响应"}`);
  console.log("[deploy] 完成");
}

function selectSpecificArchive(file, platform, arch) {
  const base = path.basename(file);
  const match = base.match(/^pihub-server-(.+)-([a-z]+)-(x64|arm64)\.tar\.gz$/);
  if (!match) throw new Error(`发布包文件名不符合 pihub-server-<version>-<platform>-<arch>.tar.gz：${base}`);
  if (match[2] !== platform || match[3] !== arch) {
    throw new Error(`发布包平台 ${match[2]}-${match[3]} 与远端 ${platform}-${arch} 不匹配`);
  }
  const sidecar = `${file}.sha256`;
  if (!fs.existsSync(sidecar)) throw new Error(`本地发布包缺少同名校验文件：${sidecar}`);
  const sidecarMatch = fs.readFileSync(sidecar, "utf8").match(/^([a-f0-9]{64})\s+\*?(\S+)\s*$/m);
  if (!sidecarMatch || sidecarMatch[2] !== base) throw new Error(`${sidecar} 校验文件无效或文件名不一致`);
  const bytes = fs.readFileSync(file);
  if (bytes.length === 0 || bytes.length > MAX_LOCAL_ARCHIVE_BYTES) {
    throw new Error(`本地发布包大小异常（${bytes.length} 字节），已拒绝发送`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sidecarMatch[1]) throw new Error("本地发布包内容与 .sha256 校验和不一致，已拒绝发送");
  return { version: match[1], file: path.resolve(file), bytes, sha256: actual };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[deploy] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
