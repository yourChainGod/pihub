/**
 * Subagents Configuration for PiHub
 *
 * @gotgenes/pi-subagents 插件配置和初始化。
 *
 * 功能：
 * - 配置子代理行为
 * - 前端面板集成
 * - 日志聚合
 * - 进度跟踪
 */

import { existsSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface SubagentPreset {
  maxConcurrency: number;
  timeout: number;
  tools?: string[];
  isolation?: "worktree" | "none";
}

export interface SubagentConfig {
  defaults: {
    maxConcurrency: number;
    timeout: number;
    isolation: "worktree" | "none";
  };
  pihub: {
    enableUI: boolean;
    namingStrategy: "descriptive" | "sequential" | "uuid";
    logAggregation: boolean;
    logPath: string;
    progressTracking: {
      enabled: boolean;
      updateInterval: number;
    };
  };
  presets: Record<string, SubagentPreset>;
}

/**
 * 默认 Subagents 配置
 */
export function getDefaultSubagentsConfig(): SubagentConfig {
  const dataRoot = join(homedir(), ".pihub");
  const logPath = join(dataRoot, "logs", "subagents");

  return {
    defaults: {
      maxConcurrency: 5,
      timeout: 300000, // 5 分钟
      isolation: "none",
    },
    pihub: {
      enableUI: true,
      namingStrategy: "descriptive",
      logAggregation: true,
      logPath,
      progressTracking: {
        enabled: true,
        updateInterval: 1000, // 1 秒
      },
    },
    presets: {
      research: {
        maxConcurrency: 3,
        timeout: 600000, // 10 分钟
        tools: ["read", "search", "web_search"],
      },
      coding: {
        maxConcurrency: 2,
        timeout: 900000, // 15 分钟
        tools: ["read", "write", "edit", "bash"],
        isolation: "worktree",
      },
      review: {
        maxConcurrency: 4,
        timeout: 300000,
        tools: ["read", "grep", "find"],
      },
      test: {
        maxConcurrency: 3,
        timeout: 600000,
        tools: ["read", "write", "bash"],
        isolation: "worktree",
      },
    },
  };
}

/**
 * 创建 Subagents 配置文件
 */
export function createSubagentsConfig(agentDir?: string): string {
  const configDir = agentDir || join(homedir(), ".pi", "agent");
  const configFile = join(configDir, "subagents.yml");

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  const config = getDefaultSubagentsConfig();

  // 创建日志目录
  if (!existsSync(config.pihub.logPath)) {
    mkdirSync(config.pihub.logPath, { recursive: true, mode: 0o700 });
  }

  // 写入配置（YAML 格式，这里简化为 JSON）
  const content = `# PiHub Subagents Configuration
# Generated: ${new Date().toISOString()}

# 默认配置
defaults:
  maxConcurrency: ${config.defaults.maxConcurrency}
  timeout: ${config.defaults.timeout}
  isolation: ${config.defaults.isolation}

# PiHub 集成配置
pihub:
  enableUI: ${config.pihub.enableUI}
  namingStrategy: "${config.pihub.namingStrategy}"
  logAggregation: ${config.pihub.logAggregation}
  logPath: "${config.pihub.logPath}"
  progressTracking:
    enabled: ${config.pihub.progressTracking.enabled}
    updateInterval: ${config.pihub.progressTracking.updateInterval}

# 预设配置
presets:
  research:
    maxConcurrency: ${config.presets.research.maxConcurrency}
    timeout: ${config.presets.research.timeout}
    tools:
${config.presets.research.tools?.map((t) => `      - ${t}`).join("\n")}

  coding:
    maxConcurrency: ${config.presets.coding.maxConcurrency}
    timeout: ${config.presets.coding.timeout}
    tools:
${config.presets.coding.tools?.map((t) => `      - ${t}`).join("\n")}
    isolation: ${config.presets.coding.isolation}

  review:
    maxConcurrency: ${config.presets.review.maxConcurrency}
    timeout: ${config.presets.review.timeout}
    tools:
${config.presets.review.tools?.map((t) => `      - ${t}`).join("\n")}

  test:
    maxConcurrency: ${config.presets.test.maxConcurrency}
    timeout: ${config.presets.test.timeout}
    tools:
${config.presets.test.tools?.map((t) => `      - ${t}`).join("\n")}
    isolation: ${config.presets.test.isolation}
`;

  writeFileSync(configFile, content, { encoding: "utf8", mode: 0o600 });
  console.log(`[subagents] ✓ Created config: ${configFile}`);

  return configFile;
}

/**
 * 初始化 Subagents 支持
 *
 * 只负责写配置文件。运行状态不在此处跟踪：扩展把它保存在 Pi 的进程内事件总线上，
 * 并持久化到会话 transcript，由 ./subagents-bridge.ts 按需读取。
 */
export function initializeSubagents(agentDir?: string): void {
  console.log("[subagents] Initializing subagents support...");
  createSubagentsConfig(agentDir);
  console.log("[subagents] ✓ Initialization complete");
}

/**
 * 清理 Subagents
 *
 * 无进程内状态需要释放——运行状态由扩展自己持有。保留此函数以维持
 * extensions-init 的对称清理流程。
 */
export function cleanupSubagents(): void {
  // no-op
}
