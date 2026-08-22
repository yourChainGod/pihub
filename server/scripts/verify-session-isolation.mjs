/**
 * 进程隔离验证（PIHUB_SESSION_WORKER=1）：并发启动两个 session，各自应运行在
 * 独立的 worker 子进程中。配合以下日志检查使用：
 *
 *   grep "in-process re-init detected" $PI_CODING_AGENT_DIR/logs/*.log  # 应无输出
 *   grep "loaded v.*harness=pi" $PI_CODING_AGENT_DIR/logs/*.log         # 应有两条
 *
 * 用法（在 server/ 目录下）：
 *   PIHUB_SESSION_WORKER=1 PI_CODING_AGENT_DIR=<隔离的 agent 目录> \
 *   PIHUB_SESSION_OWNERSHIP_PATH=<临时文件> \
 *   node scripts/verify-session-isolation.mjs [cwd]
 */

import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": new URL("..", import.meta.url).pathname },
  interopDefault: true,
});

if (process.env.PIHUB_SESSION_WORKER !== "1" && process.env.PIHUB_ALLOW_INPROCESS_CHECK !== "1") {
  console.error("请设置 PIHUB_SESSION_WORKER=1 再运行（否则会走 in-process 路径）");
  console.error("如要跑 in-process 对照组，设 PIHUB_ALLOW_INPROCESS_CHECK=1");
  process.exit(2);
}

const cwd = process.argv[2] ?? process.cwd();
// jiti 把 rpc-manager 里的动态 import("./pi-session-host") 降级为 CJS require，
// 与 pi-session-host → rpc-manager 的静态回边叠加会得到半初始化模块（TDZ）。
// 先显式加载 pi-session-host 让缓存里有完整模块，生产环境（Next.js/SWC）无此问题。
await jiti.import("../lib/pi-session-host.ts");
const { startRpcSession } = await jiti.import("../lib/rpc-manager.ts");

console.log(`[isolation-check] starting two concurrent sessions in ${cwd}`);
const [a, b] = await Promise.all([
  startRpcSession(`__new__${randomUUID()}`, "", cwd, { ownerId: `dev_${"I".repeat(22)}` }),
  startRpcSession(`__new__${randomUUID()}`, "", cwd, { ownerId: `dev_${"I".repeat(22)}` }),
]);
console.log(`[isolation-check] session A: ${a.realSessionId}`);
console.log(`[isolation-check] session B: ${b.realSessionId}`);

// 给扩展加载与日志落盘留一点时间。
await new Promise((resolve) => setTimeout(resolve, 5000));

await Promise.all([a.session.shutdown(), b.session.shutdown()]);
console.log("[isolation-check] both sessions shut down cleanly");
