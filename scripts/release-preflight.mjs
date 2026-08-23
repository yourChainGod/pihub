#!/usr/bin/env node
/**
 * Release preflight — 在本地完整预演 server-release.yml 管线，把一切能在本地
 * 发现的问题（配置漂移、锁文件、测试、构建、打包、清单、workflow 脚本语法）
 * 都拦在推 tag 之前。GitHub 侧只剩签名密钥与发布 API 无法在本地覆盖。
 *
 * 用法：
 *   node scripts/release-preflight.mjs --tag v0.0.9          完整预演（含本平台出包）
 *   node scripts/release-preflight.mjs --tag v0.0.9 --fast   只做配置/测试/workflow 检查，不构建
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const serverDirectory = path.join(root, "server");
const require = createRequire(path.join(serverDirectory, "package.json"));
const yaml = require("js-yaml");

const args = process.argv.slice(2);
const fast = args.includes("--fast");
const tagIndex = args.indexOf("--tag");
const tag = tagIndex >= 0 ? args[tagIndex + 1] : null;

let failures = 0;

function run(label, command, commandArgs, options = {}) {
  process.stdout.write(`\n[preflight] ${label}\n`);
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
  });
  if (result.status !== 0) {
    failures += 1;
    console.error(`[preflight] FAILED: ${label}`);
    summarizeAndExit();
  }
}

function summarizeAndExit() {
  if (failures > 0) {
    console.error(`\n[preflight] ${failures} 个阶段失败，修复后再发版`);
    process.exit(1);
  }
  console.log("\n[preflight] 全部通过，可以推 tag 发版");
  process.exit(0);
}

const node = process.execPath;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// ── 1. Workflow 静态检查（bash -n 每个 bash run 块，抓 heredoc/引号错误）────

process.stdout.write("\n[preflight] workflow 语法检查\n");
{
  const workflowPath = path.join(root, ".github", "workflows", "server-release.yml");
  const workflow = yaml.load(fs.readFileSync(workflowPath, "utf8"));
  const jobs = workflow?.jobs ?? {};
  for (const requiredJob of ["validate", "build-server-release", "sign-release", "publish-draft"]) {
    if (!jobs[requiredJob]) {
      console.error(`[preflight] FAILED: server-release.yml 缺少 job ${requiredJob}`);
      failures += 1;
    }
  }
  const bash = spawnSync("bash", ["--version"], { stdio: "ignore" });
  if (bash.status === 0) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pihub-workflow-lint-"));
    try {
      let index = 0;
      for (const [jobName, job] of Object.entries(jobs)) {
        for (const [stepIndex, step] of (job.steps ?? []).entries()) {
          if (typeof step?.run !== "string") continue;
          const shell = step.shell ?? (String(job["runs-on"]).includes("windows") ? "pwsh" : "bash");
          if (shell !== "bash") continue;
          const file = path.join(tmp, `${jobName}-${stepIndex}.sh`);
          fs.writeFileSync(file, step.run);
          index += 1;
          const check = spawnSync("bash", ["-n", file], { encoding: "utf8" });
          if (check.status !== 0) {
            failures += 1;
            console.error(`[preflight] FAILED: job ${jobName} 第 ${stepIndex + 1} 步 bash 语法错误\n${check.stderr}`);
          }
        }
      }
      process.stdout.write(`[preflight] ${index} 个 bash 步骤语法通过\n`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    process.stdout.write("[preflight] 无 bash，跳过 run 块语法检查\n");
  }
}
if (failures > 0) summarizeAndExit();

// ── 2. 配置与供应链 ─────────────────────────────────────────────────────────

run("check-release-config", node, ["scripts/check-release-config.mjs", ...(tag ? ["--tag", tag] : [])]);
run("check-extension-manifest", node, ["scripts/check-extension-manifest.mjs"]);
run("verify-server-lock", node, ["scripts/verify-server-lock.mjs"]);
run("default-extension-bundle 校验", node, ["scripts/default-extension-bundle.mjs"]);
run("privacy-scan", node, ["scripts/privacy-scan.mjs", "--fail-on-warnings"]);
run("scripts/*.test.mjs", node, ["--test", ...fs.readdirSync(path.join(root, "scripts")).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => path.join("scripts", f))]);

// node --check 每个脚本（纯 Node 实现，不依赖 bash）
process.stdout.write("\n[preflight] scripts node --check\n");
for (const file of fs.readdirSync(path.join(root, "scripts")).filter((f) => f.endsWith(".mjs")).sort()) {
  const check = spawnSync(node, ["--check", path.join(root, "scripts", file)], { encoding: "utf8" });
  if (check.status !== 0) {
    failures += 1;
    console.error(`[preflight] FAILED: scripts/${file} 语法错误\n${check.stderr}`);
    summarizeAndExit();
  }
}

// ── 3. 测试与类型 ───────────────────────────────────────────────────────────

run("root unit tests", npm, ["run", "test:unit"]);
run("root tsc", npm, ["exec", "--", "tsc", "--noEmit"]);
run("root lint", npm, ["run", "lint"]);
run("server tests", npm, ["test"], { cwd: serverDirectory });
run("server tsc", npm, ["exec", "--", "tsc", "--noEmit"], { cwd: serverDirectory });
run("server lint", npm, ["run", "lint"], { cwd: serverDirectory });

// ── 4. git 发布源检查（仅 --tag 时）─────────────────────────────────────────

if (tag) {
  process.stdout.write("\n[preflight] git 发布源检查\n");
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error(`[preflight] FAILED: tag 必须是 vMAJOR.MINOR.PATCH，收到 ${tag}`);
    failures += 1;
    summarizeAndExit();
  }
  const tagRef = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: root, encoding: "utf8" });
  if (tagRef.status !== 0) {
    console.error(`[preflight] FAILED: 本地不存在 tag ${tag}（先打 tag 再预演出包）`);
    failures += 1;
    summarizeAndExit();
  }
  const tagCommit = spawnSync("git", ["rev-parse", "--verify", `${tag}^{commit}`], { cwd: root, encoding: "utf8" }).stdout.trim();
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", tagCommit, "main"], { cwd: root });
  if (ancestor.status !== 0) {
    console.error(`[preflight] FAILED: tag ${tag} 的 commit 不在本地 main 上（validate job 会拒）`);
    failures += 1;
  }
  const remoteTag = spawnSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { cwd: root, encoding: "utf8" });
  if (remoteTag.status === 0) {
    const pushed = remoteTag.stdout.trim().split(/\s+/)[0] ?? "";
    const localObject = tagRef.stdout.trim();
    if (!pushed) {
      console.error(`[preflight] 警告: tag ${tag} 还没推 origin，发版前记得 git push origin ${tag}`);
    } else if (pushed !== localObject) {
      console.error(`[preflight] FAILED: 远端 tag ${tag} 与本地不一致（${pushed.slice(0, 12)} != ${localObject.slice(0, 12)}）`);
      failures += 1;
    }
  } else {
    console.error("[preflight] 警告: ls-remote 失败（离线？），跳过远端 tag 比对");
  }
  if (failures > 0) summarizeAndExit();
}

// ── 5. 构建与出包（--fast 跳过）─────────────────────────────────────────────

if (fast) {
  process.stdout.write("\n[preflight] --fast：跳过构建/出包/冒烟\n");
} else {
  // 构建链与 CI 的 setup-node 版本对齐（default-extension-bundle 硬性要求）；
  // 以 workflow 里的 node-version 为准，避免两处漂移。
  const workflowText = fs.readFileSync(path.join(root, ".github", "workflows", "server-release.yml"), "utf8");
  const expectedNode = workflowText.match(/node-version: (\d+\.\d+\.\d+)/)?.[1];
  const expectedMinor = expectedNode?.split(".").slice(0, 2).join(".");
  const actualMinor = process.versions.node.split(".").slice(0, 2).join(".");
  if (expectedMinor && actualMinor !== expectedMinor) {
    console.error(
      `[preflight] FAILED: 构建需要 Node ${expectedMinor}.x（CI setup-node 用 ${expectedNode}），`
      + `当前是 v${process.versions.node}。请先用 nvm/fnm 切换再跑完整预检。`,
    );
    failures += 1;
    summarizeAndExit();
  }
  run("server portable build", npm, ["run", "server:build"]);
  run("build-server-release（本平台）", node, ["scripts/build-server-release.mjs"]);
  run("verify-server-release", node, ["scripts/verify-server-release.mjs", "--directory", "release-artifacts"]);
  const version = JSON.parse(fs.readFileSync(path.join(serverDirectory, "package.json"), "utf8")).version;
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const archive = path.join(root, "release-artifacts", `pihub-server-${version}-${platform}-${process.arch}.tar.gz`);
  run("smoke-server-resource", node, ["scripts/smoke-server-resource.mjs", "--archive", archive]);
}

summarizeAndExit();
