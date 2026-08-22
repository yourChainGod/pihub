/**
 * PiHub Extensions Initializer
 *
 * 统一初始化所有核心扩展的配置和适配器。
 *
 * 调用时机：Server 启动时，在 RPC Manager 创建之前
 */

import { initializePermissions, UnifiedPermissionSystem } from "./permissions-adapter";
import { getTodoIntegration, cleanupTodoIntegration, type PihubTodoIntegration } from "./todo-integration";
import { initializeSubagents, cleanupSubagents } from "./subagents-config";

export interface ExtensionInitOptions {
  agentDir?: string;
  dataRoot?: string;
}

export interface InitializedExtensions {
  permissions: UnifiedPermissionSystem;
  todo: PihubTodoIntegration;
}

/**
 * 初始化所有扩展
 */
export async function initializeExtensions(options: ExtensionInitOptions = {}): Promise<InitializedExtensions> {
  console.log("[extensions] Initializing PiHub Core Extensions");

  const results: Partial<InitializedExtensions> = {};

  // 1. Unified Permission System
  console.log("[extensions] [1/3] Initializing permission system...");
  try {
    results.permissions = await initializePermissions({
      dataRoot: options.dataRoot,
      agentDir: options.agentDir,
    });
    console.log("[extensions] ✓ Permission system initialized");
  } catch (error) {
    console.error("[extensions] ✗ Permission system failed:", error);
    throw error;
  }

  // 2. TodoList Integration
  console.log("[extensions] [2/3] Initializing Todo integration...");
  try {
    results.todo = getTodoIntegration({ dataPath: options.dataRoot });
    console.log("[extensions] ✓ Todo integration initialized");
  } catch (error) {
    console.error("[extensions] ✗ Todo integration failed:", error);
    throw error;
  }

  // 3. Subagents configuration. Run state is not tracked here — the extension
  // keeps it on Pi's in-process event bus and persists it to the transcript,
  // which @/lib/subagents-bridge reads on demand.
  console.log("[extensions] [3/3] Initializing Subagents...");
  try {
    initializeSubagents(options.agentDir);
    console.log("[extensions] ✓ Subagents initialized");
  } catch (error) {
    console.error("[extensions] ✗ Subagents failed:", error);
    throw error;
  }

  console.log("[extensions] ✅ All extensions initialized");
  return results as InitializedExtensions;
}

/**
 * 清理所有扩展
 */
export function cleanupExtensions(): void {
  console.log("[extensions] Cleaning up extensions...");

  try {
    cleanupTodoIntegration();
    console.log("[extensions] ✓ Todo integration cleaned up");
  } catch (error) {
    console.error("[extensions] Todo integration cleanup error:", error);
  }

  try {
    cleanupSubagents();
    console.log("[extensions] ✓ Subagents cleaned up");
  } catch (error) {
    console.error("[extensions] Subagents cleanup error:", error);
  }

  console.log("[extensions] ✓ All extensions cleaned up");
}

/**
 * 健康检查
 */
export async function checkExtensionsHealth(): Promise<{
  healthy: boolean;
  extensions: Record<string, { status: "ok" | "warning" | "error"; message?: string }>;
}> {
  const health: Record<string, { status: "ok" | "warning" | "error"; message?: string }> = {};

  // 检查 Todo
  try {
    const todo = getTodoIntegration();
    await todo.getTodos();
    health.todo = { status: "ok" };
  } catch (error) {
    health.todo = { status: "error", message: String(error) };
  }

  // 检查 Permissions
  health.permissions = { status: "ok" };

  // 检查 Ask
  health.ask = { status: "ok" };

  const healthy = !Object.values(health).some((h) => h.status === "error");

  return { healthy, extensions: health };
}

/**
 * 获取扩展状态摘要
 */
export function getExtensionsSummary(): string {
  const summary = [
    "PiHub Extensions Status:",
    "",
    "  @cortexkit/pi-magic-context  - context management (pi-managed)",
    "  pi-todo-rail                 - todo rail (server-integrated)",
    "  @ff-labs/pi-fff              - fast file search (pi-managed)",
    "  pi-simplify                  - workflow helpers (pi-managed)",
    "  @gotgenes/pi-permission-system - permission reviews (server-integrated)",
    "  @eko24ive/pi-ask             - interactive ask (server-integrated via event-bus bridge)",
    "  @gotgenes/pi-subagents       - subagent orchestration (server-integrated)",
    "",
    "Run health check: GET /api/extensions/health",
  ];

  return summary.join("\n");
}
