import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { desktopCalls, desktopSnapshot, installDesktopMock, type DesktopMockOptions } from "./desktopMock";

async function openResources(page: Page, options: DesktopMockOptions = {}, viewport = { width: 1180, height: 800 }) {
  await page.setViewportSize(viewport);
  await installDesktopMock(page, options);
  await page.goto("/?workspace=alpha");
  await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
  if (viewport.width <= 960) await page.getByRole("button", { name: "展开工具面板" }).click();
  await page.getByRole("tab", { name: "资源", exact: true }).click();
  await expect(page.getByRole("region", { name: "项目资源管理" })).toBeVisible();
  return page.getByRole("region", { name: "项目资源管理" });
}

test.describe("项目资源管理", () => {
  test("列出并启停已安装资源，写请求不包含凭据或供应链动作", async ({ page }) => {
    const manager = await openResources(page);
    await expect(manager.getByText("release-audit", { exact: true })).toBeVisible();
    await expect(manager.getByText("project-conventions", { exact: true })).toBeVisible();
    await expect(manager.getByText("项目资源已信任", { exact: true })).toBeVisible();

    const skillSwitch = manager.getByRole("switch", { name: "停用 Skill：release-audit" });
    await expect(skillSwitch).toBeChecked();
    await skillSwitch.click();
    await expect(manager.getByRole("switch", { name: "启用 Skill：release-audit" })).not.toBeChecked();
    expect((await desktopSnapshot(page)).skills.find((skill) => skill.name === "release-audit")?.disableModelInvocation).toBe(true);

    await manager.getByRole("tab", { name: /Plugins/ }).click();
    await expect(manager.getByText("@pihub/guardrails", { exact: true })).toBeVisible();
    await expect(manager.getByText("project-tools", { exact: true })).toBeVisible();
    const pluginSwitch = manager.getByRole("switch", { name: "停用 Plugin：@pihub/guardrails" });
    await pluginSwitch.click();
    await expect(manager.getByRole("switch", { name: "启用 Plugin：@pihub/guardrails" })).not.toBeChecked();
    expect((await desktopSnapshot(page)).plugins.find((plugin) => plugin.id === "pkg_guardrails")?.disabled).toBe(true);

    const resourceCalls = (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && /^\/api\/(?:project-trust|skills|plugins)/.test(String(call.args?.path)));
    const writes = resourceCalls.filter((call) => call.args?.method !== "GET");
    expect(writes.map((call) => call.args?.path)).toEqual(["/api/skills", "/api/plugins"]);
    expect(writes[0].args?.body).toEqual({ filePath: "/opt/pihub/skills/release-audit/SKILL.md", disableModelInvocation: true });
    expect(writes[1].args?.body).toEqual({ action: "disable", packageId: "pkg_guardrails", scope: "global", cwd: "/projects/pihub" });
    expect(writes[1].args?.body).not.toHaveProperty("source");
    expect(JSON.stringify(resourceCalls)).not.toMatch(/credential|authorization|apiKey|secret/i);
    expect(JSON.stringify(resourceCalls)).not.toMatch(/"action":"(?:install|update|remove)"/);
    await expect(manager.getByRole("button", { name: /安装|更新|移除/ })).toHaveCount(0);
  });

  test("未信任项目仅显示全局资源，并要求本次明确确认", async ({ page }) => {
    const manager = await openResources(page, { resourceTrust: "untrusted" });
    await expect(manager.getByText("项目资源已隔离", { exact: true })).toBeVisible();
    await expect(manager.getByText("release-audit", { exact: true })).toBeVisible();
    await expect(manager.getByText("project-conventions", { exact: true })).toHaveCount(0);
    await expect(manager.getByText("仅全局资源", { exact: true })).toBeVisible();

    await manager.getByRole("tab", { name: /Plugins/ }).click();
    await expect(manager.getByText("@pihub/guardrails", { exact: true })).toBeVisible();
    await expect(manager.getByText("project-tools", { exact: true })).toHaveCount(0);
    await manager.getByRole("tab", { name: /Skills/ }).click();

    await manager.getByRole("button", { name: "审查并信任" }).click();
    const confirmation = manager.getByRole("alertdialog", { name: "确认信任当前项目" });
    const acknowledge = confirmation.getByRole("checkbox", { name: "我已核对项目来源，并允许 PiHub 加载其项目级资源" });
    await expect(acknowledge).toBeFocused();
    await expect(confirmation.getByRole("button", { name: "确认信任项目" })).toBeDisabled();
    await acknowledge.check();
    await confirmation.getByRole("button", { name: "确认信任项目" }).click();

    await expect(manager.getByText("项目资源已信任", { exact: true })).toBeVisible();
    await expect(manager.getByText("project-conventions", { exact: true })).toBeVisible();
    expect((await desktopSnapshot(page)).projectTrust.trusted).toBe(true);
    const trustWrites = (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && call.args?.path === "/api/project-trust" && call.args?.method === "POST");
    expect(trustWrites).toHaveLength(1);
    expect(trustWrites[0].args?.body).toEqual({ cwd: "/projects/pihub" });
  });

  test("403 不继续读取包资源，重新验证入口保持可用", async ({ page }) => {
    const manager = await openResources(page, { resourceTrust: "forbidden" });
    await expect(manager.getByRole("alert")).toContainText("当前设备凭据缺少资源权限");
    let calls = (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && /^\/api\/(?:project-trust|skills|plugins)/.test(String(call.args?.path)));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((call) => String(call.args?.path).startsWith("/api/project-trust"))).toBe(true);
    const attemptsBeforeRetry = calls.length;
    await manager.getByRole("button", { name: "重试" }).click();
    await expect(manager.getByRole("alert")).toContainText("当前设备凭据缺少资源权限");
    calls = (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && String(call.args?.path).startsWith("/api/project-trust"));
    expect(calls.length).toBeGreaterThan(attemptsBeforeRetry);
  });

  test("临时读取失败后可刷新恢复", async ({ page }) => {
    const manager = await openResources(page, { resourceFailure: "read-once" });
    await expect(manager.getByRole("alert")).toContainText("临时读取失败");
    await manager.getByRole("button", { name: "重试" }).click();
    await expect(manager.getByText("release-audit", { exact: true })).toBeVisible();
  });

  test("Plugin 写入失败后保持原状态并可再次提交", async ({ page }) => {
    const manager = await openResources(page, { resourceFailure: "plugin-once" });
    await manager.getByRole("tab", { name: /Plugins/ }).click();
    const pluginSwitch = manager.getByRole("switch", { name: "停用 Plugin：@pihub/guardrails" });
    await pluginSwitch.click();
    await expect(manager.getByRole("alert")).toContainText("Plugin operation failed");
    await expect(pluginSwitch).toBeChecked();
    await pluginSwitch.click();
    await expect(manager.getByRole("switch", { name: "启用 Plugin：@pihub/guardrails" })).not.toBeChecked();
  });

  test("信任冲突可在确认区域原位重试", async ({ page }) => {
    const manager = await openResources(page, { resourceTrust: "untrusted", resourceFailure: "trust-once" });
    await manager.getByRole("button", { name: "审查并信任" }).click();
    const confirmation = manager.getByRole("alertdialog", { name: "确认信任当前项目" });
    await confirmation.getByRole("checkbox").check();
    await confirmation.getByRole("button", { name: "确认信任项目" }).click();
    await expect(manager.getByRole("alert")).toContainText("当前项目仍有运行中的会话");
    await confirmation.getByRole("button", { name: "确认信任项目" }).click();
    await expect(manager.getByText("项目资源已信任", { exact: true })).toBeVisible();
  });

  test("受管 410 显示稳定状态且不提供无效重试", async ({ page }) => {
    const manager = await openResources(page, { resourceFailure: "managed" });
    await manager.getByRole("tab", { name: /Plugins/ }).click();
    await manager.getByRole("switch", { name: "停用 Plugin：@pihub/guardrails" }).click();
    await expect(manager.getByRole("status")).toContainText("签名资源目录上线前");
    await expect(manager.locator(".resource-notice.managed").getByRole("button")).toHaveCount(0);
  });

  test("720x620 键盘、axe 与资源抽屉均无横向越界", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 620 });
    await installDesktopMock(page, { resourceTrust: "untrusted" });
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("button", { name: "展开工具面板" }).click();
    const filesTab = page.getByRole("tab", { name: "文件", exact: true });
    await filesTab.focus();
    await page.keyboard.press("End");
    const resourceTab = page.getByRole("tab", { name: "资源", exact: true });
    await expect(resourceTab).toBeFocused();
    await expect(resourceTab).toHaveAttribute("aria-selected", "true");

    const manager = page.getByRole("region", { name: "项目资源管理" });
    const skillsTab = manager.getByRole("tab", { name: /Skills/ });
    await skillsTab.focus();
    await page.keyboard.press("End");
    await expect(manager.getByRole("tab", { name: /Plugins/ })).toBeFocused();
    await expect(manager.getByText("@pihub/guardrails", { exact: true })).toBeVisible();
    await expect(page.locator(".tool-pane")).toHaveCSS("opacity", "1");

    const geometry = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(".tool-pane")?.getBoundingClientRect();
      const managerElement = document.querySelector<HTMLElement>(".resource-manager");
      return {
        pageScrollWidth: document.documentElement.scrollWidth,
        pageClientWidth: document.documentElement.clientWidth,
        pane: pane && { left: pane.left, right: pane.right, top: pane.top, bottom: pane.bottom },
        managerScrollWidth: managerElement?.scrollWidth ?? 0,
        managerClientWidth: managerElement?.clientWidth ?? 0,
      };
    });
    expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.pageClientWidth);
    expect(geometry.pane?.left).toBeGreaterThanOrEqual(0);
    expect(geometry.pane?.right).toBeLessThanOrEqual(720.5);
    expect(geometry.pane?.bottom).toBeLessThanOrEqual(620);
    expect(geometry.managerScrollWidth).toBeLessThanOrEqual(geometry.managerClientWidth);
    const results = await new AxeBuilder({ page }).include(".tool-pane").analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("全局可达性媒体状态", () => {
  test("200% 等效视口、减少动态效果与强制高对比均可达且无横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 620 });
    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "none" });
    await installDesktopMock(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "我的设备" })).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByLabel("搜索设备")).toBeFocused();
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const transitionSeconds = await page.locator(".device-card").first().evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration) || 0);
    expect(transitionSeconds).toBeLessThanOrEqual(0.001);
    const reducedMotionResults = await new AxeBuilder({ page }).analyze();
    expect(reducedMotionResults.violations).toEqual([]);

    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    const openButton = page.getByRole("button", { name: "打开工作台" }).first();
    await expect(openButton).toBeVisible();
    await openButton.focus();
    await expect(openButton).toBeFocused();
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    // axe cannot resolve OS palette colors while forced-colors emulation is
    // active; contrast is covered immediately above in the same layout.
    const results = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
    expect(results.violations).toEqual([]);
  });
});
