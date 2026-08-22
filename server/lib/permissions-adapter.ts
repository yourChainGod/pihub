/**
 * Unified Permission System Adapter
 *
 * 融合 PiHub 自有权限系统和 @gotgenes/pi-permission-system 插件，
 * 实现双向同步和统一查询接口。
 *
 * 架构：
 *   PiHub Permissions (server/lib/permissions.ts)
 *        ↕ 双向同步
 *   Pi Permission System (~/.pi/extensions/pi-permission-system/)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface PermissionRule {
  pattern: string;
  action: "allow" | "deny" | "ask";
  scope?: string;
  priority?: number;
}

export interface UnifiedPermissionConfig {
  version: string;
  extends?: string;
  rules: PermissionRule[];
  syncToPi?: boolean;
}

/**
 * 统一权限系统
 *
 * 管理 PiHub 和 Pi Permission System 两套权限配置
 */
export class UnifiedPermissionSystem {
  private pihubConfigPath: string;
  private piConfigPath: string;
  private syncEnabled: boolean;

  constructor(options?: { dataRoot?: string; agentDir?: string; syncEnabled?: boolean }) {
    const dataRoot = options?.dataRoot || join(homedir(), ".pihub");
    const agentDir = options?.agentDir || join(homedir(), ".pi", "agent");

    this.pihubConfigPath = join(dataRoot, "permissions.yml");
    this.piConfigPath = join(agentDir, "extensions", "pi-permission-system", "config.json");
    this.syncEnabled = options?.syncEnabled ?? true;

    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    const pihubDir = join(this.pihubConfigPath, "..");
    const piDir = join(this.piConfigPath, "..");

    if (!existsSync(pihubDir)) {
      mkdirSync(pihubDir, { recursive: true, mode: 0o700 });
    }
    if (!existsSync(piDir)) {
      mkdirSync(piDir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * 加载 PiHub 权限配置
   */
  private loadPihubConfig(): UnifiedPermissionConfig {
    if (!existsSync(this.pihubConfigPath)) {
      return this.getDefaultPihubConfig();
    }

    try {
      // 简单起见，先用 JSON 格式（YAML 解析需要额外依赖）
      const content = readFileSync(this.pihubConfigPath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      console.error("[permissions] Failed to load PiHub config:", error);
      return this.getDefaultPihubConfig();
    }
  }

  /**
   * 加载 Pi Permission System 配置
   */
  private loadPiConfig(): Record<string, unknown> | null {
    if (!existsSync(this.piConfigPath)) {
      return null;
    }

    try {
      const content = readFileSync(this.piConfigPath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      console.error("[permissions] Failed to load Pi config:", error);
      return null;
    }
  }

  /**
   * 默认 PiHub 权限配置
   */
  private getDefaultPihubConfig(): UnifiedPermissionConfig {
    return {
      version: "1.0",
      extends: this.piConfigPath,
      syncToPi: true,
      rules: [
        // PiHub 专有规则
        { pattern: "api:session:*", action: "allow", scope: "authenticated" },
        { pattern: "api:admin:*", action: "deny", scope: "guest" },
        { pattern: "api:files:read", action: "allow", scope: "authenticated" },
        { pattern: "api:files:write", action: "ask", scope: "authenticated" },
        { pattern: "api:files:delete", action: "ask", scope: "authenticated" },
      ],
    };
  }

  /**
   * 保存 PiHub 权限配置
   */
  private savePihubConfig(config: UnifiedPermissionConfig): void {
    const content = JSON.stringify(config, null, 2);
    writeFileSync(this.pihubConfigPath, content, { encoding: "utf8", mode: 0o600 });
  }

  /**
   * 保存 Pi Permission System 配置
   */
  private savePiConfig(config: Record<string, unknown>): void {
    const content = JSON.stringify(config, null, 2);
    writeFileSync(this.piConfigPath, content, { encoding: "utf8", mode: 0o600 });
  }

  /**
   * 获取所有权限规则（合并 PiHub + Pi）
   */
  async getRules(): Promise<PermissionRule[]> {
    const pihubConfig = this.loadPihubConfig();
    const piConfig = this.loadPiConfig();

    const rules: PermissionRule[] = [...pihubConfig.rules];

    // 从 Pi config 中提取规则
    if (piConfig && typeof piConfig.permission === "object") {
      const piPermission = piConfig.permission as Record<string, unknown>;

      // 转换 Pi 权限格式到统一格式
      for (const [key, value] of Object.entries(piPermission)) {
        if (typeof value === "string" && ["allow", "deny", "ask"].includes(value)) {
          rules.push({
            pattern: key,
            action: value as "allow" | "deny" | "ask",
            scope: "pi-native",
            priority: 0,
          });
        } else if (typeof value === "object" && value !== null) {
          // 嵌套规则（如 path: {...}, bash: {...}）
          for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
            if (typeof subValue === "string" && ["allow", "deny", "ask"].includes(subValue)) {
              rules.push({
                pattern: `${key}:${subKey}`,
                action: subValue as "allow" | "deny" | "ask",
                scope: "pi-native",
                priority: 0,
              });
            }
          }
        }
      }
    }

    return rules;
  }

  /**
   * 添加权限规则
   */
  async addRule(rule: PermissionRule): Promise<void> {
    const config = this.loadPihubConfig();
    config.rules.push(rule);
    this.savePihubConfig(config);

    // 同步到 Pi
    if (this.syncEnabled && config.syncToPi) {
      await this.syncToPi();
    }
  }

  /**
   * 检查权限（统一查询）
   */
  async checkPermission(action: string, resource: string): Promise<boolean> {
    const rules = await this.getRules();

    // 按优先级排序
    rules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    // 匹配规则
    for (const rule of rules) {
      if (this.matchPattern(rule.pattern, action, resource)) {
        if (rule.action === "deny") return false;
        if (rule.action === "allow") return true;
        // "ask" 需要外部处理，这里返回 false（保守）
        if (rule.action === "ask") return false;
      }
    }

    // 默认：deny（安全优先）
    return false;
  }

  /**
   * 模式匹配
   */
  private matchPattern(pattern: string, action: string, resource: string): boolean {
    const fullPath = `${action}:${resource}`;

    // 简单通配符匹配
    const regexPattern = pattern
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(fullPath) || regex.test(action) || regex.test(resource);
  }

  /**
   * 同步 PiHub 权限到 Pi Permission System
   */
  async syncToPi(): Promise<void> {
    if (!this.syncEnabled) return;

    try {
      const pihubConfig = this.loadPihubConfig();
      const piConfig = this.loadPiConfig() || this.getDefaultPiConfig();

      // 将 PiHub 规则合并到 Pi 配置
      const permission = (piConfig.permission as Record<string, unknown>) || {};

      for (const rule of pihubConfig.rules) {
        // 跳过 PiHub 专有规则（api:*）
        if (rule.pattern.startsWith("api:")) continue;

        // 转换格式并合并
        const [category, ...rest] = rule.pattern.split(":");
        if (rest.length === 0) {
          permission[category] = rule.action;
        } else {
          const subPattern = rest.join(":");
          if (typeof permission[category] !== "object") {
            permission[category] = {};
          }
          (permission[category] as Record<string, string>)[subPattern] = rule.action;
        }
      }

      piConfig.permission = permission;
      this.savePiConfig(piConfig);

      console.log("[permissions] ✓ Synced to Pi Permission System");
    } catch (error) {
      console.error("[permissions] Failed to sync to Pi:", error);
    }
  }

  /**
   * 默认 Pi Permission System 配置
   */
  private getDefaultPiConfig(): Record<string, unknown> {
    return {
      $schema: "https://raw.githubusercontent.com/gotgenes/pi-packages/main/packages/pi-permission-system/schemas/permissions.schema.json",
      debugLog: false,
      permissionReviewLog: true,
      yoloMode: false,
      doublePressToConfirm: true,
      permission: {
        "*": "allow",
        path: {
          "*": "allow",
          "*.env": "deny",
          "*.pem": "deny",
          "*.key": "deny",
          "~/.ssh/*": "deny",
        },
        bash: {
          "*": "allow",
          "rm -rf /*": "deny",
          "sudo *": "ask",
        },
      },
    };
  }

  /**
   * 初始化权限系统（首次安装时调用）
   */
  async initialize(): Promise<void> {
    console.log("[permissions] Initializing unified permission system...");

    // 1. 创建默认 PiHub 配置
    if (!existsSync(this.pihubConfigPath)) {
      const defaultConfig = this.getDefaultPihubConfig();
      this.savePihubConfig(defaultConfig);
      console.log("[permissions] ✓ Created PiHub config");
    }

    // 2. 创建默认 Pi 配置（如果不存在）
    if (!existsSync(this.piConfigPath)) {
      const defaultPiConfig = this.getDefaultPiConfig();
      this.savePiConfig(defaultPiConfig);
      console.log("[permissions] ✓ Created Pi Permission System config");
    }

    // 3. 执行初始同步
    await this.syncToPi();

    console.log("[permissions] ✓ Initialization complete");
  }
}

/**
 * 导出便捷函数
 */
export async function initializePermissions(options?: {
  dataRoot?: string;
  agentDir?: string;
}): Promise<UnifiedPermissionSystem> {
  const system = new UnifiedPermissionSystem(options);
  await system.initialize();
  return system;
}
