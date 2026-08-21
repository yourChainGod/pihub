import { expect, test } from "@playwright/test";
import { desktopCalls, desktopListenerCount, emitDesktopEvent, installDesktopMock } from "./desktopMock";

// 第三轮自用化 UI 改动：思考+工具调用合并分组、复制会话 ID、切换会话滚动记忆。
test.describe("工作台体验打磨", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installDesktopMock(page);
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await expect(page.getByText("先建立可验证的发布清单，再逐项收敛。")).toBeVisible();
  });

  test("重开后从本地缓存恢复并只增量拉取", async ({ page }) => {
    // beforeEach 已完成首次全量水合；等持久化防抖落盘。
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await expect(page.getByText("先建立可验证的发布清单，再逐项收敛。")).toBeVisible();
    await expect(page.getByText("请规划 PiHub 的发布流程")).toBeVisible();

    await expect.poll(async () => {
      const calls = await desktopCalls(page);
      return calls.filter((call) => String(call.args?.path ?? "").includes("/api/sessions/session-1") && String(call.args?.path ?? "").includes("after=entry-2")).length;
    }).toBeGreaterThan(0);
  });

  const envelope = (event: Record<string, unknown>) => ({
    deviceId: "alpha",
    deviceOrigin: "https://studio.tailnet.ts.net:30141",
    sessionId: "session-1",
    generation: 1,
    event,
  });

  async function startRun(page: Parameters<typeof emitDesktopEvent>[0], prompt: string) {
    const composer = page.getByRole("textbox", { name: "消息输入" });
    await composer.fill(prompt);
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect.poll(() => desktopListenerCount(page, "pihub-agent-event")).toBe(1);
  }

  test("连续思考+工具调用消息合并为一个分组卡片", async ({ page }) => {
    await startRun(page, "跑两个命令");
    const step = (id: string, command: string, thinking: string) => ({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: Date.now(),
        model: "gpt-5",
        content: [
          { type: "thinking", thinking },
          { type: "toolCall", id, name: "bash", arguments: { command } },
        ],
      },
    });
    const result = (id: string) => ({ type: "message_end", message: { role: "toolResult", toolCallId: id, timestamp: Date.now(), content: [{ type: "text", text: "done" }] } });
    await emitDesktopEvent(page, "pihub-agent-event", envelope(step("c1", "ls", "先看看目录里有什么")));
    await emitDesktopEvent(page, "pihub-agent-event", envelope(result("c1")));
    await emitDesktopEvent(page, "pihub-agent-event", envelope(step("c2", "pwd", "再确认当前路径")));
    await emitDesktopEvent(page, "pihub-agent-event", envelope(result("c2")));

    const group = page.locator(".tool-group");
    await expect(group).toHaveCount(1);
    await expect(group.locator(".tool-group-head")).toContainText("2 个工具调用 · 2 段思考");
    await expect(group.locator(".original-tool-call")).toHaveCount(2);
    await expect(group.locator(".thinking-block")).toHaveCount(2);
    // 每个模型只标注一次，时间折叠进分组头
    await expect(group.locator(".model-label")).toHaveCount(0);
    // 分组可整体折叠
    await group.locator(".tool-group-head").click();
    await expect(group.locator(".original-tool-call")).toHaveCount(0);
    await expect(group.locator(".thinking-block")).toHaveCount(0);
  });

  test("聚合卡片超长命令省略号截断且展开详情不溢出", async ({ page }) => {
    const longCmd = `cd /home/user/project && P="socks5h://127.0.0.1:1080" echo "=== ${"很长的路由名称".repeat(12)} ==="`;
    for (const id of ["c1", "c2"]) {
      await emitDesktopEvent(page, "pihub-agent-event", envelope({
        type: "message_end",
        message: { role: "assistant", timestamp: Date.now(), model: "gpt-5", content: [{ type: "toolCall", id, name: "bash", arguments: { command: longCmd } }] },
      }));
      await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "message_end", message: { role: "toolResult", toolCallId: id, timestamp: Date.now(), content: [{ type: "text", text: "ok" }] } }));
    }
    const group = page.locator(".tool-group");
    await expect(group).toBeVisible();
    const over = await group.locator(".original-tool-call > button").evaluateAll((nodes) => nodes.map((n) => n.scrollWidth - n.clientWidth));
    expect(over.every((delta) => delta <= 1)).toBe(true);
    await group.locator(".original-tool-call > button").first().click();
    const detail = group.locator(".tool-detail pre").first();
    await expect(detail).toBeVisible();
    const detailOver = await detail.evaluate((n) => n.scrollWidth - n.clientWidth);
    expect(detailOver).toBeLessThanOrEqual(1);
  });

  test("中断会话显示琥珀状态点与继续运行入口", async ({ page }) => {
    // session-2 在 mock 中标记为 interrupted（服务重启导致的中断）。
    const row = page.locator(".session-row").filter({ hasText: "实现记录" });
    await expect(row.locator(".session-activity.interrupted")).toBeVisible();
    await row.locator(".session-row-main").click();
    const banner = page.locator(".interrupted-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("上次运行被中断");
    await banner.getByRole("button", { name: "继续运行" }).click();
    await expect(banner).toHaveCount(0);
    await expect.poll(async () => (await desktopCalls(page))
      .filter((call) => call.args?.path === "/api/agent/session-2" && (call.args?.body as { type?: string } | undefined)?.type === "prompt")
      .length).toBe(1);
  });

  test("会话菜单提供复制会话 ID", async ({ page }, testInfo) => {
    if (testInfo.project.name === "chromium") await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.locator(".session-row").filter({ hasText: "项目规划" }).getByRole("button", { name: "会话菜单" }).click();
    await page.getByRole("button", { name: "复制会话 ID" }).click();
    await expect(page.getByText("已复制会话 ID")).toBeVisible();
    if (testInfo.project.name === "chromium") {
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("session-1");
    }
  });

  test("切换会话后恢复上次滚动位置", async ({ page }) => {
    await startRun(page, "生成长内容");
    for (let index = 0; index < 40; index += 1) {
      await emitDesktopEvent(page, "pihub-agent-event", envelope({
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: Date.now(),
          model: "gpt-5",
          content: [{ type: "text", text: `长内容 ${index}\n\n第二行\n\n第三行\n\n第四行` }],
        },
      }));
    }
    const scroll = page.locator(".message-scroll");
    await expect(page.getByText("长内容 39", { exact: true })).toBeVisible();
    await scroll.evaluate((element) => element.scrollTo({ top: 120 }));
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(120);

    await page.locator(".session-row-main").filter({ hasText: "实现记录" }).click();
    await expect(page.getByText("浏览器测试桥已经接通。")).toBeVisible();
    await page.locator(".session-row-main").filter({ hasText: "项目规划" }).click();
    await expect(page.getByText("长内容 39", { exact: true })).toBeVisible();
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(120);

    // 再次切走又切回，位置仍然保持
    await page.locator(".session-row-main").filter({ hasText: "实现记录" }).click();
    await page.locator(".session-row-main").filter({ hasText: "项目规划" }).click();
    await expect(page.getByText("长内容 39", { exact: true })).toBeVisible();
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBe(120);
  });

  test("模型错误长 JSON 不撑破消息区", async ({ page }) => {
    await startRun(page, "调用模型");
    const rawError = `503: {"message":"{\\"error\\":{\\"message\\":\\"Service temporarily unavailable\\",\\"type\\":\\"service_unavailable_error\\"}}","providerMetadata":{"gateway":{"routing":{"providerOrder":[${Array.from({ length: 24 }, (_, index) => `"provider-${index}"`).join(",")}]}}}}`;
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: Date.now(),
        model: "glm-5.2-fast",
        stopReason: "error",
        errorMessage: rawError,
        content: [],
      },
    }));
    const errorCard = page.locator(".provider-error");
    await expect(errorCard).toBeVisible();
    await expect(errorCard).toContainText("503:");
    // 无空格长串必须断行：消息区与卡片都不出现横向溢出
    await expect.poll(() => page.locator(".message-scroll").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect.poll(() => errorCard.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  });
  test("超大工具输出不撑爆本地缓存，重开仍从缓存恢复", async ({ page }) => {
    await startRun(page, "跑一个大输出命令");
    const bigOutput = `BEGIN-MARK ${"长输出".repeat(700_000)} END-MARK`;
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: Date.now(),
        model: "gpt-5",
        content: [
          { type: "text", text: "RESTORE-MARKER 大输出已截断" },
          { type: "toolCall", id: "big-1", name: "bash", arguments: { command: "cat big.log" } },
        ],
      },
    }));
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "message_end",
      message: { role: "toolResult", toolCallId: "big-1", timestamp: Date.now(), content: [{ type: "text", text: bigOutput }] },
    }));
    await expect(page.getByText("cat big.log")).toBeVisible();
    // 等持久化防抖落盘后重开：内容应来自本地缓存而不是重新拉取
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await expect(page.getByText("cat big.log")).toBeVisible();
    await expect(page.getByText("RESTORE-MARKER 大输出已截断")).toBeVisible();
  });

  test("edit 工具调用渲染 diff 视图", async ({ page }) => {
    await startRun(page, "改一个文件");
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "message_end",
      message: {
        role: "assistant", timestamp: Date.now(), model: "gpt-5",
        content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] } }],
      },
    }));
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "message_end",
      message: {
        role: "toolResult", toolCallId: "e1", timestamp: Date.now(),
        content: [{ type: "text", text: "ok" }],
        details: { diff: "diff", patch: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;", firstChangedLine: 1 },
      },
    }));
    const call = page.locator(".original-tool-call").filter({ hasText: "src/app.ts" });
    await expect(call.locator(".diff-chips")).toContainText("+1");
    await expect(call.locator(".diff-chips")).toContainText("−1");
    await call.locator("> button").click();
    await expect(call.locator(".tool-diff")).toBeVisible();
    await expect(call.locator(".tool-diff-path")).toHaveText("src/app.ts");
    await expect(call.locator(".diff-line.del")).toContainText("const a = 1;");
    await expect(call.locator(".diff-line.add")).toContainText("const a = 2;");
    // diff 视图替代了原始 JSON 输入
    await expect(call.locator(".tool-detail")).not.toContainText("oldText");
  });

  test("edit 无 details 时回退渲染 edits 对照", async ({ page }) => {
    await startRun(page, "再改一个文件");
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "message_end",
      message: {
        role: "assistant", timestamp: Date.now(), model: "gpt-5",
        content: [{ type: "toolCall", id: "e2", name: "edit", arguments: { path: "src/b.ts", edits: [{ oldText: "foo", newText: "bar" }] } }],
      },
    }));
    const call = page.locator(".original-tool-call").filter({ hasText: "src/b.ts" });
    await expect(call.locator(".diff-chips")).toContainText("+1");
    await call.locator("> button").click();
    await expect(call.locator(".diff-line.del")).toContainText("foo");
    await expect(call.locator(".diff-line.add")).toContainText("bar");
  });

  test("工具行右端显示成败标记，运行中 composer 提示插话语义", async ({ page }) => {
    await startRun(page, "跑个命令");
    await expect(page.locator(".composer-wrap > small")).toHaveText("Enter 插话打断当前生成 · Esc 中断运行");
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "message_end",
      message: { role: "assistant", timestamp: Date.now(), model: "gpt-5", content: [{ type: "toolCall", id: "v1", name: "bash", arguments: { command: "ls" } }] },
    }));
    const call = page.locator(".original-tool-call").filter({ hasText: "ls" });
    await expect(call).toBeVisible();
    // 结果未回时不显示成败标记
    await expect(call.locator(".tool-verdict")).toHaveCount(0);
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "message_end",
      message: { role: "toolResult", toolCallId: "v1", timestamp: Date.now(), content: [{ type: "text", text: "ok" }] },
    }));
    await expect(call.locator(".tool-verdict.done")).toBeVisible();
  });

  test("连续图片渲染为网格并带类型与大小说明", async ({ page }) => {
    await startRun(page, "看两张图");
    const pixel = "iVBORw0KGgoAAAANSUhEUg==";
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "message_end",
      message: {
        role: "assistant", timestamp: Date.now(), model: "gpt-5",
        content: [
          { type: "image", data: pixel, mimeType: "image/png" },
          { type: "image", data: pixel, mimeType: "image/png" },
          { type: "text", text: "两张截图如上" },
        ],
      },
    }));
    const grid = page.locator(".image-grid");
    await expect(grid).toHaveCount(1);
    await expect(grid.locator(".message-image")).toHaveCount(2);
    await expect(grid.locator("figcaption").first()).toHaveText(/image\/png · \d+ B/);
  });

  test("底部跟随时连续新消息保持贴底", async ({ page }) => {
    await startRun(page, "持续输出");
    const scroll = page.locator(".message-scroll");
    for (let index = 0; index < 12; index += 1) {
      await emitDesktopEvent(page, "pihub-agent-event", envelope({
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: Date.now(),
          model: "gpt-5",
          content: [{ type: "text", text: `输出 ${index}\n\n补充行\n\n更多行` }],
        },
      }));
      await expect(page.getByText(`输出 ${index}`, { exact: true })).toBeVisible();
      await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(140);
    }
  });
});
