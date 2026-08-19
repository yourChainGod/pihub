import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { desktopCalls, desktopListenerCount, desktopSnapshot, emitDesktopEvent, installDesktopMock, legacySessionCacheExists, seedLegacySessionCache, setDesktopNetwork } from "./desktopMock";

const screenshotDir = join(process.cwd(), "test-results", "screenshots");
const pairingCode = `pihub-${"A".repeat(43)}`;

test.beforeAll(() => mkdirSync(screenshotDir, { recursive: true }));

test.describe("设备中心", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installDesktopMock(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "我的设备" })).toBeVisible();
  });

  test("展示在线、离线和鉴权状态，并保留单设备刷新之外的状态", async ({ page }) => {
    const studio = page.locator(".device-card").filter({ hasText: "Studio Mac" });
    const linux = page.locator(".device-card").filter({ hasText: "Build Linux" });
    const windows = page.locator(".device-card").filter({ hasText: "Office Windows" });
    await expect(studio.getByText("在线", { exact: true })).toBeVisible();
    await expect(linux.getByText("离线", { exact: true })).toBeVisible();
    await expect(linux.getByText("连接超时")).toBeVisible();
    await expect(windows.getByText("待配对", { exact: true })).toBeVisible();
    await expect(windows.getByText("需要本机配对")).toBeVisible();

    await page.getByRole("button", { name: "添加另一台设备" }).click();
    await page.getByLabel("设备名称 可选").fill("New Node");
    await page.getByLabel("地址").fill("new-node.tailnet.ts.net:30141");
    await page.getByRole("button", { name: "保存设备" }).click();
    const added = page.locator(".device-card").filter({ hasText: "New Node" });
    await expect(added.getByText("在线", { exact: true })).toBeVisible();
    await expect(studio.getByText("在线", { exact: true })).toBeVisible();
    await expect(linux.getByText("离线", { exact: true })).toBeVisible();
    await expect(windows.getByText("待配对", { exact: true })).toBeVisible();
  });

  test("默认扩展只读展示为签名 Server 管理", async ({ page }, testInfo) => {
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("button", { name: "设备设置" }).click();
    const dialog = page.getByRole("dialog", { name: "Studio Mac 设备中心" });
    const extensions = dialog.locator(".setup-row-readonly");

    await expect(extensions).toContainText("默认扩展 5/5");
    await expect(extensions).toContainText("由签名 Server 版本管理");
    await expect(extensions.getByRole("button")).toHaveCount(0);
    await expect(dialog).not.toContainText("Magic Context");

    await page.setViewportSize({ width: 720, height: 620 });
    const bounds = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const extensionRect = element.querySelector<HTMLElement>(".setup-row-readonly")?.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        extensionLeft: extensionRect?.left ?? -1,
        extensionRight: extensionRect?.right ?? Number.POSITIVE_INFINITY,
      };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(720);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(620);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
    expect(bounds.extensionLeft).toBeGreaterThanOrEqual(bounds.left);
    expect(bounds.extensionRight).toBeLessThanOrEqual(bounds.right);
    const results = await new AxeBuilder({ page }).include(".device-setup").analyze();
    expect(results.violations).toEqual([]);
    if (testInfo.project.name === "chromium") {
      await page.screenshot({ path: join(screenshotDir, "setup-default-extensions-720x620.png"), scale: "css" });
    }
  });

  test("支持收藏、编辑、删除、打开与键盘搜索", async ({ page }) => {
    const windows = page.locator(".device-card").filter({ hasText: "Office Windows" });
    await windows.getByRole("button", { name: "收藏设备" }).click();
    await expect(windows.getByRole("button", { name: "取消收藏" })).toBeVisible();

    const studio = page.locator(".device-card").filter({ hasText: "Studio Mac" });
    await studio.getByRole("button", { name: "设备菜单" }).click();
    await studio.getByRole("button", { name: "编辑设备" }).click();
    await page.getByLabel("设备名称").fill("Studio Pro");
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.locator(".device-card").filter({ hasText: "Studio Pro" })).toBeVisible();

    const linux = page.locator(".device-card").filter({ hasText: "Build Linux" });
    await linux.getByRole("button", { name: "设备菜单" }).click();
    await linux.getByRole("button", { name: "移除设备" }).click();
    await page.getByRole("button", { name: "移除", exact: true }).click();
    await expect(linux).toHaveCount(0);
    const deletionCalls = await desktopCalls(page);
    const forgetIndex = deletionCalls.findIndex((call) => call.command === "forget_device_credential" && call.args?.url === "https://build.tailnet.ts.net:30141");
    const removeIndex = deletionCalls.findIndex((call) => call.command === "remove_device" && call.args?.id === "beta");
    expect(forgetIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeGreaterThan(forgetIndex);

    await page.keyboard.press("Control+k");
    await expect(page.getByPlaceholder("搜索设备")).toBeFocused();
    const edited = page.locator(".device-card").filter({ hasText: "Studio Pro" });
    await edited.getByRole("button", { name: "打开工作台" }).click();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "open_device").length).toBe(1);
  });

  test("未配对设备使用一次性配对码后刷新状态并打开", async ({ page }, testInfo) => {
    const windows = page.locator(".device-card").filter({ hasText: "Office Windows" });
    await windows.getByRole("button", { name: "配对设备" }).click();
    const dialog = page.getByRole("dialog", { name: "配对 Office Windows" });
    const input = dialog.getByLabel("一次性配对码");
    await input.fill("A".repeat(43));
    await dialog.getByRole("button", { name: "确认配对" }).click();
    await expect(dialog.getByRole("button", { name: "正在配对" })).toBeVisible();
    await expect(dialog.getByText("本机已安全配对")).toBeVisible();
    await expect(windows.getByText("在线", { exact: true })).toBeVisible();

    const pairCalls = (await desktopCalls(page)).filter((call) => call.command === "pair_device");
    expect(pairCalls).toHaveLength(1);
    expect(pairCalls[0].args).toEqual({ url: "https://office.tailnet.ts.net:30141", code: pairingCode });
    expect(JSON.stringify(pairCalls[0])).not.toContain("secret");
    expect(JSON.stringify(await page.evaluate(() => Object.values(localStorage)))).not.toContain(pairingCode);
    expect((await desktopCalls(page)).filter((call) => call.command === "probe_device" && call.args?.url === "https://office.tailnet.ts.net:30141").length).toBeGreaterThanOrEqual(2);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
    await page.screenshot({ path: join(screenshotDir, `pairing-success-desktop-1440x900-${testInfo.project.name}.png`), fullPage: true });
    await dialog.getByRole("button", { name: "打开工作台" }).click();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "open_device" && (call.args?.device as { id?: string } | undefined)?.id === "gamma").length).toBe(1);
  });

  test("解除本机配对需二次确认并回到待配对状态", async ({ page }) => {
    const studio = page.locator(".device-card").filter({ hasText: "Studio Mac" });
    await studio.getByRole("button", { name: "设备菜单" }).click();
    await studio.getByRole("button", { name: "解除本机配对" }).click();
    const dialog = page.getByRole("alertdialog", { name: "解除“Studio Mac”的本机配对？" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "解除配对" }).click();
    await expect(studio.getByText("待配对", { exact: true })).toBeVisible();
    await expect(studio.getByRole("button", { name: "配对设备" })).toBeVisible();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "forget_device_credential" && call.args?.url === "https://studio.tailnet.ts.net:30141").length).toBe(1);
  });

  test("旧版设备仅在显式确认后导入且不会迁移凭据", async ({ page }) => {
    await page.getByRole("button", { name: "设置" }).click();
    let settings = page.getByRole("dialog", { name: "连接设置" });
    await expect(settings.getByText("系统凭据不会读取或复制")).toBeVisible();
    await settings.getByRole("button", { name: "从旧版导入" }).click();

    let confirmation = page.getByRole("alertdialog", { name: "导入旧版设备？" });
    await expect(confirmation).toContainText("旧版密钥不会迁移");
    await confirmation.getByRole("button", { name: "取消" }).click();
    expect((await desktopCalls(page)).filter((call) => call.command === "import_legacy_device_metadata")).toHaveLength(0);

    await page.getByRole("button", { name: "设置" }).click();
    settings = page.getByRole("dialog", { name: "连接设置" });
    await settings.getByRole("button", { name: "从旧版导入" }).click();
    confirmation = page.getByRole("alertdialog", { name: "导入旧版设备？" });
    await confirmation.getByRole("button", { name: "导入设备" }).click();

    const imported = page.locator(".device-card").filter({ hasText: "Legacy Linux" });
    await expect(imported).toBeVisible();
    await expect(imported.getByText("待配对", { exact: true })).toBeVisible();
    await expect(imported.getByRole("button", { name: "配对设备" })).toBeVisible();
    await expect(page.getByText("设备密钥未迁移，请重新配对")).toBeVisible();

    const importCalls = (await desktopCalls(page)).filter((call) => call.command === "import_legacy_device_metadata");
    expect(importCalls).toHaveLength(1);
    expect(importCalls[0].args).toEqual({});
    expect(JSON.stringify(importCalls[0])).not.toContain("credential");
    expect(JSON.stringify(importCalls[0])).not.toContain("secret");

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test("Linux SSH 安装要求显式普通用户名", async ({ page }) => {
    await page.getByRole("button", { name: "SSH 一键安装" }).click();
    const dialog = page.getByRole("dialog", { name: "SSH 一键安装" });
    const linux = dialog.locator(".peer").filter({ hasText: "Build Linux" });
    await linux.getByRole("button", { name: "Tailscale SSH 配置" }).click();
    const username = dialog.getByPlaceholder("Linux 用户名（例如 pi 或 ubuntu）");
    await expect(username).toBeFocused();
    await username.fill("pi");
    await dialog.getByRole("button", { name: "继续" }).click();

    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer").length).toBe(1);
    const [bootstrap] = (await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer");
    expect(bootstrap.args).toMatchObject({
      host: "build.tailnet.ts.net",
      os: "linux",
      username: "pi",
      installDefaultExtensions: true,
    });
  });

  test("桌面布局通过 axe 并生成基线截图", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".device-card")).toHaveCount(3);
    const hero = page.locator(".hero");
    const heading = hero.getByRole("heading", { name: "设备工作台" });
    const description = hero.locator("p");

    await expect(heading).toHaveCSS("font-size", "34px");
    const desktopLayout = await page.locator(".app-shell").evaluate(() => {
      const heroBox = document.querySelector<HTMLElement>(".hero")?.getBoundingClientRect();
      const fleetBox = document.querySelector<HTMLElement>(".fleet-section")?.getBoundingClientRect();
      return {
        fleetTop: fleetBox?.top ?? Number.POSITIVE_INFINITY,
        gap: (fleetBox?.top ?? 0) - (heroBox?.bottom ?? 0),
        viewportHeight: window.innerHeight,
      };
    });
    expect(desktopLayout.fleetTop).toBeLessThan(desktopLayout.viewportHeight * 0.4);
    expect(desktopLayout.gap).toBeGreaterThanOrEqual(-0.5);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
    await page.screenshot({ path: join(screenshotDir, `fleet-desktop-1440x900-${testInfo.project.name}.png`), scale: "css" });

    const originalHeading = await heading.textContent();
    const originalDescription = await description.textContent();
    await heading.evaluate((element) => {
      element.textContent = "设备工作台跨平台私有计算集群远程管理与安全运维中心";
    });
    await description.evaluate((element) => {
      element.textContent = "PiHubDesktopCrossPlatformPrivateInfrastructureWorkspaceWithoutAnyNaturalBreakOpportunities";
    });
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    for (const locator of [heading, description]) {
      const textBox = await locator.boundingBox();
      const heroBox = await hero.boundingBox();
      expect(textBox).not.toBeNull();
      expect(heroBox).not.toBeNull();
      expect(textBox!.x).toBeGreaterThanOrEqual(heroBox!.x - 0.5);
      expect(textBox!.x + textBox!.width).toBeLessThanOrEqual(heroBox!.x + heroBox!.width + 0.5);
    }
    await heading.evaluate((element, text) => { element.textContent = text; }, originalHeading);
    await description.evaluate((element, text) => { element.textContent = text; }, originalDescription);

    await page.setViewportSize({ width: 720, height: 620 });
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    const compactLayout = await page.locator(".app-shell").evaluate(() => {
      const heroBox = document.querySelector<HTMLElement>(".hero")?.getBoundingClientRect();
      const fleetBox = document.querySelector<HTMLElement>(".fleet-section")?.getBoundingClientRect();
      return {
        gap: (fleetBox?.top ?? 0) - (heroBox?.bottom ?? 0),
        fleetVisible: (fleetBox?.top ?? Number.POSITIVE_INFINITY) < window.innerHeight,
      };
    });
    expect(compactLayout.gap).toBeGreaterThanOrEqual(-0.5);
    expect(compactLayout.fleetVisible).toBe(true);
    await page.screenshot({ path: join(screenshotDir, `fleet-compact-720x620-${testInfo.project.name}.png`), scale: "css" });
  });
});

test.describe("桌面应用签名更新", () => {
  async function openUpdates(page: Parameters<typeof installDesktopMock>[0]) {
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("button", { name: "设备设置" }).click();
    const dialog = page.getByRole("dialog", { name: "Studio Mac 设备中心" });
    await dialog.getByRole("button", { name: "版本更新" }).click();
    await expect(dialog.locator(".setup-row").filter({ hasText: "PiHub Desktop" })).toBeVisible();
    return dialog;
  }

  test("仅通过无参数 Rust 命令完成检查、安装和重启", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await installDesktopMock(page, { desktopUpdateScenario: "available" });
    const dialog = await openUpdates(page);
    const desktop = dialog.locator(".setup-row").filter({ hasText: "PiHub Desktop" });

    await desktop.getByRole("button", { name: "检查桌面更新" }).click();
    await expect(desktop).toContainText("可更新至 v0.0.2");
    await desktop.getByRole("button", { name: "下载并安装" }).click();
    await expect(dialog.getByRole("progressbar", { name: "桌面更新下载进度" })).toBeVisible();
    await expect(dialog.getByText("桌面更新已就绪", { exact: true })).toBeVisible();
    await expect(desktop.getByRole("button", { name: "重启 PiHub" })).toBeVisible();

    const updaterCalls = (await desktopCalls(page)).filter((call) => call.command.startsWith("desktop_update_"));
    expect(updaterCalls.filter((call) => call.command === "desktop_update_status").length).toBeGreaterThanOrEqual(1);
    expect(updaterCalls.filter((call) => call.command === "desktop_update_check")).toHaveLength(1);
    expect(updaterCalls.filter((call) => call.command === "desktop_update_install")).toHaveLength(1);
    expect(updaterCalls.filter((call) => call.command === "desktop_update_restart")).toHaveLength(0);
    expect(updaterCalls.every((call) => Object.keys(call.args ?? {}).length === 0)).toBe(true);
    expect((await desktopCalls(page)).some((call) => call.command.startsWith("plugin:updater") || call.command.startsWith("plugin:process"))).toBe(false);

    const results = await new AxeBuilder({ page }).include(".device-setup").analyze();
    expect(results.violations).toEqual([]);
    await desktop.getByRole("button", { name: "重启 PiHub" }).click();
    await expect(desktop).toContainText("正在重启 PiHub Desktop");
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "desktop_update_restart").length).toBe(1);
  });

  test("最新版本仍保留重新检查入口", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await installDesktopMock(page, { desktopUpdateScenario: "none" });
    const dialog = await openUpdates(page);
    const desktop = dialog.locator(".setup-row").filter({ hasText: "PiHub Desktop" });
    await desktop.getByRole("button", { name: "检查桌面更新" }).click();
    await expect(desktop).toContainText("已是最新版本");
    await expect(desktop.getByRole("button", { name: "检查桌面更新" })).toBeEnabled();
  });

  test("签名失败时保留当前版本且不会开放重启", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await installDesktopMock(page, { desktopUpdateScenario: "signature-failure" });
    const dialog = await openUpdates(page);
    const desktop = dialog.locator(".setup-row").filter({ hasText: "PiHub Desktop" });
    await desktop.getByRole("button", { name: "检查桌面更新" }).click();
    await desktop.getByRole("button", { name: "下载并安装" }).click();
    await expect(dialog.getByRole("alert")).toContainText("更新包签名校验失败，安装已中止");
    await expect(desktop.getByRole("button", { name: "重试安装" })).toBeVisible();
    await expect(desktop.getByRole("button", { name: "重启 PiHub" })).toHaveCount(0);
    expect((await desktopCalls(page)).filter((call) => call.command === "desktop_update_restart")).toHaveLength(0);
  });

  test("取消下载后不会安装或重启，并可重新尝试", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await installDesktopMock(page, { desktopUpdateScenario: "available" });
    const dialog = await openUpdates(page);
    const desktop = dialog.locator(".setup-row").filter({ hasText: "PiHub Desktop" });

    await desktop.getByRole("button", { name: "检查桌面更新" }).click();
    await desktop.getByRole("button", { name: "下载并安装" }).click();
    await expect(dialog.getByRole("button", { name: "取消下载" })).toBeVisible();
    await dialog.getByRole("button", { name: "取消下载" }).click();
    await expect(dialog.getByRole("alert")).toContainText("更新下载已取消，可重新尝试");
    await expect(desktop.getByRole("button", { name: "重试安装" })).toBeEnabled();
    await page.waitForTimeout(180);
    await expect(dialog.getByText("桌面更新已就绪", { exact: true })).toHaveCount(0);
    await expect(desktop.getByRole("button", { name: "重启 PiHub" })).toHaveCount(0);

    let updaterCalls = (await desktopCalls(page)).filter((call) => call.command.startsWith("desktop_update_"));
    expect(updaterCalls.filter((call) => call.command === "desktop_update_cancel")).toHaveLength(1);
    expect(updaterCalls.filter((call) => call.command === "desktop_update_restart")).toHaveLength(0);
    await desktop.getByRole("button", { name: "重试安装" }).click();
    await expect(dialog.getByText("桌面更新已就绪", { exact: true })).toBeVisible();
    updaterCalls = (await desktopCalls(page)).filter((call) => call.command.startsWith("desktop_update_"));
    expect(updaterCalls.filter((call) => call.command === "desktop_update_install")).toHaveLength(2);
    expect(updaterCalls.filter((call) => call.command === "desktop_update_restart")).toHaveLength(0);
    expect(updaterCalls.every((call) => Object.keys(call.args ?? {}).length === 0)).toBe(true);
  });
});

test.describe("设备配对错误恢复", () => {
  test("错误后保留配对码并允许重试", async ({ page }) => {
    await installDesktopMock(page, { pairingFailure: "invalid-once" });
    await page.goto("/");
    const windows = page.locator(".device-card").filter({ hasText: "Office Windows" });
    await windows.getByRole("button", { name: "配对设备" }).click();
    const dialog = page.getByRole("dialog", { name: "配对 Office Windows" });
    const input = dialog.getByLabel("一次性配对码");
    await input.fill(pairingCode);
    await dialog.getByRole("button", { name: "确认配对" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("配对码无效、已过期或已被使用，请生成新码后重试。");
    await expect(input).toHaveValue(pairingCode);
    await dialog.getByRole("button", { name: "确认配对" }).click();
    await expect(dialog.getByText("本机已安全配对")).toBeVisible();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "pair_device").length).toBe(2);
  });

  test("限流时显示明确的稍后重试文案", async ({ page }) => {
    await installDesktopMock(page, { pairingFailure: "rate-limit" });
    await page.goto("/");
    const windows = page.locator(".device-card").filter({ hasText: "Office Windows" });
    await windows.getByRole("button", { name: "配对设备" }).click();
    const dialog = page.getByRole("dialog", { name: "配对 Office Windows" });
    const input = dialog.getByLabel("一次性配对码");
    await input.fill(pairingCode);
    await dialog.getByRole("button", { name: "确认配对" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("尝试次数过多，请稍后再试。");
    await expect(input).toHaveValue(pairingCode);
  });

  test("网络故障后保留配对码，设备恢复时可直接重试", async ({ page }) => {
    await installDesktopMock(page, { pairingFailure: "network-once" });
    await page.goto("/");
    const windows = page.locator(".device-card").filter({ hasText: "Office Windows" });
    await windows.getByRole("button", { name: "配对设备" }).click();
    const dialog = page.getByRole("dialog", { name: "配对 Office Windows" });
    const input = dialog.getByLabel("一次性配对码");
    await input.fill(pairingCode);
    await dialog.getByRole("button", { name: "确认配对" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("无法连接设备，请确认设备在线后重试。");
    await expect(input).toHaveValue(pairingCode);

    await dialog.getByRole("button", { name: "确认配对" }).click();
    await expect(dialog.getByText("本机已安全配对")).toBeVisible();
    await expect(windows.getByText("在线", { exact: true })).toBeVisible();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "pair_device").length).toBe(2);
  });
});

test.describe("桌面工作台", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installDesktopMock(page);
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await expect(page.getByText("先建立可验证的发布清单，再逐项收敛。")).toBeVisible();
  });

  test("会话草稿按设备和会话隔离，标签没有嵌套交互元素", async ({ page }) => {
    const composer = page.getByRole("textbox", { name: "消息输入" });
    await composer.fill("项目规划的未发送草稿");
    await page.locator(".session-row-main").filter({ hasText: "实现记录" }).click();
    await expect(composer).toHaveValue("");
    await composer.fill("实现记录的未发送草稿");
    await page.locator(".session-row-main").filter({ hasText: "项目规划" }).click();
    await expect(composer).toHaveValue("项目规划的未发送草稿");
    await page.locator(".session-row-main").filter({ hasText: "实现记录" }).click();
    await expect(composer).toHaveValue("实现记录的未发送草稿");
    await expect(page.locator("button button, [role=button] button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "关闭标签：项目规划" })).toBeVisible();
  });

  test("可在当前项目或选定子目录新建会话，并自动选择新会话", async ({ page }) => {
    await page.getByRole("button", { name: "在当前项目中新建会话" }).click();
    await expect(page.getByRole("heading", { name: "新会话" })).toBeVisible();
    let createCalls = (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && call.args?.path === "/api/agent/new");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].args?.body).toEqual({ cwd: "/projects/pihub", type: "ensure_session" });

    await page.getByRole("button", { name: "选择文件夹并开始会话" }).click();
    const picker = page.locator(".folder-modal");
    await expect(picker.getByRole("heading", { name: "选择项目文件夹" })).toBeVisible();
    await expect(picker.locator(".folder-path code")).toHaveText("/projects/pihub");
    await picker.locator(".folder-list button").filter({ hasText: "src" }).click();
    await expect(picker.locator(".folder-path code")).toHaveText("/projects/pihub/src");
    await picker.getByRole("button", { name: "在此文件夹开始" }).click();
    await expect(page.getByRole("heading", { name: "新会话" })).toBeVisible();

    createCalls = (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && call.args?.path === "/api/agent/new");
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1].args?.body).toEqual({ cwd: "/projects/pihub/src", type: "ensure_session" });
  });

  test("发送后消费真实流事件，并在停止时中止 agent 与流订阅", async ({ page }) => {
    const composer = page.getByRole("textbox", { name: "消息输入" });
    await composer.fill("请流式回答这条消息");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByText("请流式回答这条消息", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "停止运行" })).toBeVisible();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && call.args?.path === "/api/agent/session-1" && (call.args?.body as { type?: string } | undefined)?.type === "prompt").length).toBe(1);
    await expect.poll(() => desktopListenerCount(page, "pihub-agent-event")).toBe(1);

    const envelope = (event: Record<string, unknown>) => ({
      deviceId: "alpha",
      deviceOrigin: "https://studio.tailnet.ts.net:30141",
      sessionId: "session-1",
      generation: 1,
      event,
    });
    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "message_start", message: { role: "assistant", content: [], timestamp: 10 } }));
    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } }));
    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "正在生成的回答" } }));
    await expect(page.getByText("正在生成的回答", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "停止运行" }).click();
    await expect(page.getByText("空闲", { exact: true })).toBeVisible();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && call.args?.path === "/api/agent/session-1" && (call.args?.body as { type?: string } | undefined)?.type === "abort").length).toBe(1);

    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "agent_settled" }));
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "stop_agent_stream" && call.args?.sessionId === "session-1").length).toBeGreaterThanOrEqual(1);
  });

  test("中文 IME 确认 Enter 不误发送，组合结束后正常 Enter 才发送", async ({ page }) => {
    const composer = page.getByRole("textbox", { name: "消息输入" });
    await composer.focus();
    await composer.dispatchEvent("compositionstart", { data: "中" });
    await composer.fill("中文输入");
    await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    expect((await desktopCalls(page)).filter((call) => call.command === "agegr_request" && (call.args?.body as { type?: string } | undefined)?.type === "prompt")).toHaveLength(0);

    await composer.dispatchEvent("compositionend", { data: "中文输入" });
    await page.keyboard.press("Enter");
    expect((await desktopCalls(page)).filter((call) => call.command === "agegr_request" && (call.args?.body as { type?: string } | undefined)?.type === "prompt")).toHaveLength(0);

    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && (call.args?.body as { type?: string } | undefined)?.type === "prompt").length).toBe(1);
  });

  test("终端离开或收起时立即关闭远端 PTY", async ({ page }) => {
    await page.getByRole("tab", { name: "终端", exact: true }).click();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && (call.args?.body as { action?: string } | undefined)?.action === "create").length).toBe(1);
    await page.getByRole("tab", { name: "Git", exact: true }).click();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && (call.args?.body as { action?: string } | undefined)?.action === "close").length).toBe(1);

    await page.getByRole("tab", { name: "终端", exact: true }).click();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && (call.args?.body as { action?: string } | undefined)?.action === "create").length).toBe(2);
    await page.getByRole("button", { name: "收起工具面板" }).click();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && (call.args?.body as { action?: string } | undefined)?.action === "close").length).toBe(2);
  });

  test("工作台键盘焦点和 axe 语义完整", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await expect(page.getByPlaceholder("搜索项目与会话")).toBeFocused();
    await page.keyboard.press("Control+Enter");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeFocused();
    await expect(page.getByRole("button", { name: "设备设置" })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("远程文件与 Git", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installDesktopMock(page);
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await expect(page.locator(".native-file-list").getByText("README.md", { exact: true })).toBeVisible();
  });

  test("文件和目录支持创建、编辑、重命名与确认删除", async ({ page }) => {
    const fileList = page.locator(".native-file-list");
    await fileList.getByTitle("新建文件夹").click();
    await fileList.getByPlaceholder("新文件夹").fill("docs");
    await fileList.getByRole("button", { name: "创建" }).click();
    await expect(fileList.getByText("docs", { exact: true })).toBeVisible();

    await fileList.getByRole("button", { name: "新建文件", exact: true }).click();
    await fileList.getByPlaceholder("新文件").fill("notes.txt");
    await fileList.getByRole("button", { name: "创建" }).click();
    const notes = fileList.getByRole("button").filter({ hasText: "notes.txt" });
    await expect(notes).toBeVisible();
    await notes.click();

    const editor = page.locator(".file-editor");
    await expect(editor).toBeVisible();
    await editor.fill("stateful file content");
    await page.locator(".file-preview").getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".file-preview").getByText("已保存", { exact: true })).toBeVisible();
    expect((await desktopSnapshot(page)).files).toContainEqual(["/projects/pihub/notes.txt", { content: "stateful file content", language: "text" }]);

    await page.locator(".file-preview").getByTitle("返回文件列表").click();
    const savedNotes = page.locator(".native-file-list").getByRole("button").filter({ hasText: "notes.txt" });
    await savedNotes.click({ button: "right" });
    await page.locator(".file-context-menu").getByRole("menuitem", { name: "重命名" }).click();
    const renameDialog = page.getByRole("dialog", { name: "重命名" });
    await renameDialog.locator("input").fill("release-notes.txt");
    await renameDialog.getByRole("button", { name: "保存" }).click();
    const renamed = page.locator(".native-file-list").getByRole("button").filter({ hasText: "release-notes.txt" });
    await expect(renamed).toBeVisible();
    expect((await desktopSnapshot(page)).files).toContainEqual(["/projects/pihub/release-notes.txt", { content: "stateful file content", language: "text" }]);

    await renamed.click({ button: "right" });
    await page.locator(".file-context-menu").getByRole("menuitem", { name: "移动到…" }).click();
    const moveDialog = page.getByRole("dialog", { name: "移动 release-notes.txt 到完整路径" });
    await moveDialog.locator("input").fill("/projects/pihub/docs/release-notes.txt");
    await moveDialog.getByRole("button", { name: "移动" }).click();
    await expect(renamed).toHaveCount(0);
    expect((await desktopSnapshot(page)).files).toContainEqual(["/projects/pihub/docs/release-notes.txt", { content: "stateful file content", language: "text" }]);
    const moveCall = (await desktopCalls(page)).find((call) => call.command === "agegr_request" && call.args?.path === "/api/pihub/files" && (call.args?.body as { action?: string } | undefined)?.action === "move");
    expect(moveCall?.args?.body).toEqual({ action: "move", path: "/projects/pihub/release-notes.txt", destination: "/projects/pihub/docs/release-notes.txt" });

    await page.locator(".native-file-list").getByRole("button").filter({ hasText: "docs" }).click();
    const moved = page.locator(".native-file-list").getByRole("button").filter({ hasText: "release-notes.txt" });
    await expect(moved).toBeVisible();
    await moved.focus();
    await page.keyboard.press("Shift+F10");
    await page.locator(".file-context-menu").getByRole("menuitem", { name: "删除" }).click();
    const deleteDialog = page.getByRole("alertdialog", { name: "删除 release-notes.txt？" });
    await deleteDialog.getByRole("button", { name: "删除" }).click();
    await expect(moved).toHaveCount(0);
    expect((await desktopSnapshot(page)).files.map(([path]) => path)).not.toContain("/projects/pihub/docs/release-notes.txt");
    expect((await desktopSnapshot(page)).directories).toContain("/projects/pihub/docs");
  });

  test("上传、同名覆盖与下载均走桌面二进制桥", async ({ page }) => {
    const uploadInput = page.locator('.native-file-list input[type="file"]');
    await uploadInput.setInputFiles({ name: "upload.txt", mimeType: "text/plain", buffer: Buffer.from("first upload") });
    await expect(page.locator(".native-file-list").getByText("已上传 1 个文件", { exact: true })).toBeVisible();
    const uploaded = page.locator(".native-file-list").getByRole("button").filter({ hasText: "upload.txt" });
    await expect(uploaded).toBeVisible();
    expect((await desktopSnapshot(page)).files).toContainEqual(["/projects/pihub/upload.txt", { content: "first upload", language: "text" }]);

    await uploaded.click({ button: "right" });
    await page.locator(".file-context-menu").getByRole("menuitem", { name: "下载" }).click();
    await expect(page.locator(".native-file-list").getByText("已下载：upload.txt", { exact: true })).toBeVisible();
    const download = (await desktopCalls(page)).find((call) => call.command === "download_remote_file");
    expect(download?.args).toMatchObject({ name: "upload.txt", path: "/api/files/projects/pihub/upload.txt?type=download&sessionId=session-1" });

    await uploadInput.setInputFiles({ name: "README.md", mimeType: "text/markdown", buffer: Buffer.from("replacement") });
    const conflict = page.getByRole("alertdialog", { name: "1 个同名文件已存在" });
    await expect(conflict).toBeVisible();
    await conflict.getByRole("button", { name: "覆盖上传" }).click();
    await expect.poll(async () => (await desktopSnapshot(page)).files.find(([path]) => path === "/projects/pihub/README.md")?.[1].content).toBe("replacement");
    expect((await desktopCalls(page)).some((call) => call.command === "upload_remote_files" && String(call.args?.path).includes("conflict=overwrite"))).toBe(true);
  });

  test("Git 状态可打开逐行 diff 并返回变更列表", async ({ page }) => {
    await page.getByRole("tab", { name: "Git", exact: true }).click();
    const git = page.locator(".native-git-list");
    await expect(git.getByText("1", { exact: true })).toBeVisible();
    await expect(git.getByText("个变更", { exact: true })).toBeVisible();
    await expect(git.getByText("+12", { exact: true })).toBeVisible();
    await expect(git.getByText("-3", { exact: true })).toBeVisible();
    await expect(git.getByText("src/App.tsx", { exact: true })).toBeVisible();

    await git.getByRole("button", { name: "查看 App.tsx 的 Git diff" }).click();
    const diff = page.getByLabel("App.tsx 的 Git diff");
    await expect(diff).toContainText("@@ -1 +1 @@");
    await expect(diff.locator(".deleted")).toContainText("-old");
    await expect(diff.locator(".added")).toContainText("+changed");
    const diffCall = (await desktopCalls(page)).find((call) => call.command === "agegr_request" && String(call.args?.path).startsWith("/api/git/diff?"));
    expect(diffCall?.args?.path).toContain("cwd=%2Fprojects%2Fpihub");
    expect(diffCall?.args?.path).toContain("path=src%2FApp.tsx");
    await page.getByRole("button", { name: "返回 Git 变更列表" }).click();
    await expect(git.getByText("个变更", { exact: true })).toBeVisible();
  });

  test("worktree 可切换、创建并删除，操作后自动选择对应新会话", async ({ page }) => {
    const worktreeButton = page.getByRole("button", { name: "Git worktree：main" });
    await expect(worktreeButton).toBeVisible();
    await worktreeButton.click();
    const worktreeMenu = page.locator("#worktree-menu");
    await expect(worktreeMenu).toContainText("2 个 checkout");
    await worktreeMenu.locator(".worktree-open").filter({ hasText: "feature/e2e" }).click();
    await expect(page.getByRole("button", { name: "Git worktree：feature/e2e" })).toBeVisible();
    await expect(page.getByText("已在 feature/e2e 中开始新会话", { exact: true })).toBeVisible();
    let createCalls = (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && call.args?.path === "/api/agent/new");
    expect(createCalls.at(-1)?.args?.body).toEqual({ cwd: "/projects/pihub-worktrees/feature-e2e", type: "ensure_session" });

    await page.getByRole("button", { name: "Git worktree：feature/e2e" }).click();
    await page.locator("#worktree-menu").getByRole("button", { name: "新建 worktree…" }).click();
    const createDialog = page.getByRole("dialog", { name: "新建 Git worktree" });
    await createDialog.locator("input").fill("release/test");
    await createDialog.getByRole("button", { name: "创建并打开" }).click();
    await expect(page.getByRole("button", { name: "Git worktree：release/test" })).toBeVisible();
    await expect(page.getByText("已创建并打开 worktree：release/test", { exact: true })).toBeVisible();
    expect((await desktopSnapshot(page)).worktrees).toContainEqual({ path: "/projects/pihub-worktrees/release-test", branch: "release/test", isMain: false });
    createCalls = (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && call.args?.path === "/api/agent/new");
    expect(createCalls.at(-1)?.args?.body).toEqual({ cwd: "/projects/pihub-worktrees/release-test", type: "ensure_session" });

    await page.getByRole("button", { name: "Git worktree：release/test" }).click();
    await page.getByRole("button", { name: "移除 worktree：release/test" }).click();
    const removeDialog = page.getByRole("alertdialog", { name: "移除 worktree“release/test”？" });
    await removeDialog.getByRole("button", { name: "移除 worktree" }).click();
    await expect.poll(async () => (await desktopSnapshot(page)).worktrees.some((item) => item.branch === "release/test")).toBe(false);
    const removeCall = (await desktopCalls(page)).find((call) => call.command === "agegr_request" && call.args?.path === "/api/worktrees" && call.args?.method === "DELETE");
    expect(removeCall?.args?.body).toEqual({ cwd: "/projects/pihub-worktrees/release-test", path: "/projects/pihub-worktrees/release-test", force: false });
  });
});

test.describe("模型配置", () => {
  test.beforeEach(async ({ page }) => {
    await installDesktopMock(page);
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.locator(".model-pill").click();
    await page.getByRole("button", { name: "管理模型配置…" }).click();
    await expect(page.locator(".models-config-modal").getByRole("heading", { name: "模型配置" })).toBeVisible();
  });

  test("NewAPI Provider 可新增、刷新、删除，API Key 不落本地存储", async ({ page }) => {
    const modal = page.locator(".models-config-modal");
    await modal.getByRole("button", { name: "添加网关" }).click();
    await modal.getByLabel("Provider ID").fill("team-gateway");
    await modal.getByLabel("Base URL").fill("https://gateway.example.invalid/v1");
    await modal.getByLabel("API Key").fill("sk-e2e-private-value");
    await modal.getByRole("button", { name: "保存网关" }).click();

    const provider = modal.locator(".newapi-list article").filter({ hasText: "team-gateway" });
    await expect(provider).toContainText("凭据已配置");
    await expect(provider).toContainText("0 个模型覆盖");
    expect(JSON.stringify(await page.evaluate(() => Object.values(localStorage)))).not.toContain("sk-e2e-private-value");
    await provider.getByRole("button", { name: "刷新模型" }).click();
    await expect(provider).toContainText("2 个模型覆盖");

    await provider.getByRole("button", { name: "删除" }).click();
    await page.getByRole("alertdialog", { name: "删除 NewAPI Provider “team-gateway”？" }).getByRole("button", { name: "删除" }).click();
    await expect(provider).toHaveCount(0);
    expect((await desktopSnapshot(page)).newApiConfig.providers).toEqual([]);
  });

  test("高级 JSON 保存到远端模型配置", async ({ page }) => {
    const modal = page.locator(".models-config-modal");
    await modal.getByRole("tab", { name: "高级 JSON", exact: true }).click();
    const config = { providers: { local: { baseUrl: "https://models.example.invalid" } } };
    await modal.locator("textarea").fill(JSON.stringify(config));
    await modal.getByRole("button", { name: "保存 JSON" }).click();
    await expect(modal).toHaveCount(0);
    expect((await desktopSnapshot(page)).modelsConfig).toEqual(config);
    const saveCall = (await desktopCalls(page)).find((call) => call.command === "agegr_request" && call.args?.path === "/api/models-config" && call.args?.method === "PUT");
    expect(saveCall?.args?.body).toEqual(config);
  });
});

test.describe("GitHub 签名更新", () => {
  test("签名更新按排队、安装、重启、完成状态推进", async ({ page }) => {
    await installDesktopMock(page, { updateScenario: "available" });
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("button", { name: "设备设置" }).click();
    const dialog = page.getByRole("dialog", { name: "Studio Mac 设备中心" });
    await dialog.getByRole("button", { name: "版本更新" }).click();
    await expect(dialog.locator(".update-install-status")).toContainText("GitHub stable 签名通道");
    await expect(dialog.locator(".setup-row").filter({ hasText: "PiHub Server" })).toContainText("当前 v0.0.1 · 最新 v0.0.2 · darwin/arm64");
    await dialog.getByRole("button", { name: "安装签名更新" }).click();

    await expect(dialog.getByText("更新已排队", { exact: true })).toBeVisible();
    await expect(dialog.getByText("正在验证并安装", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(dialog.getByText("正在重启 PiHub Server", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(dialog.getByText("更新完成", { exact: true })).toBeVisible({ timeout: 10_000 });
    const updateCalls = (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && call.args?.path === "/api/pihub/updates" && call.args?.method === "POST");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args?.body).toEqual({ action: "apply" });
  });

  test("服务端忙竞态要求二次确认，Esc 只关闭最上层且 force 不携带额外参数", async ({ page }) => {
    await installDesktopMock(page, { updateScenario: "busy" });
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("button", { name: "设备设置" }).click();
    const dialog = page.getByRole("dialog", { name: "Studio Mac 设备中心" });
    await dialog.getByRole("button", { name: "版本更新" }).click();
    await dialog.getByRole("button", { name: "安装签名更新" }).click();
    const confirm = page.getByRole("alertdialog", { name: "有会话正在运行" });
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "安装签名更新" })).toBeFocused();
    await dialog.getByRole("button", { name: "安装签名更新" }).click();
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "仍要更新" }).click();
    await expect(dialog.getByText("更新已排队", { exact: true })).toBeVisible();

    const updateCalls = (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && call.args?.path === "/api/pihub/updates" && call.args?.method === "POST");
    expect(updateCalls).toHaveLength(3);
    expect(updateCalls.map((call) => call.args?.body)).toEqual([{ action: "apply" }, { action: "apply" }, { action: "apply", force: true }]);
  });

  test("无更新时明确显示当前版本已就绪", async ({ page }) => {
    await installDesktopMock(page, { updateScenario: "none" });
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("button", { name: "设备设置" }).click();
    const dialog = page.getByRole("dialog", { name: "Studio Mac 设备中心" });
    await dialog.getByRole("button", { name: "版本更新" }).click();
    const server = dialog.locator(".setup-row").filter({ hasText: "PiHub Server" });
    await expect(server).toContainText("当前 v0.0.1 · 最新 v0.0.1");
    await expect(server).toContainText("已就绪");
    await expect(dialog.getByRole("button", { name: "安装签名更新" })).toHaveCount(0);
  });

  test("签名清单验证失败时拒绝进入安装态并允许重新检查", async ({ page }) => {
    await installDesktopMock(page, { updateScenario: "signature-failure" });
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("button", { name: "设备设置" }).click();
    const dialog = page.getByRole("dialog", { name: "Studio Mac 设备中心" });
    await dialog.getByRole("button", { name: "版本更新" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("无法验证 GitHub 签名发布，请稍后重试。");
    await expect(dialog.getByRole("button", { name: "重新检查" })).toBeVisible();
    expect((await desktopCalls(page)).filter((call) => call.args?.path === "/api/pihub/updates" && call.args?.method === "POST")).toHaveLength(0);
  });

  test("后台失败状态显示稳定错误码", async ({ page }) => {
    await installDesktopMock(page, { updateScenario: "failed" });
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("button", { name: "设备设置" }).click();
    const dialog = page.getByRole("dialog", { name: "Studio Mac 设备中心" });
    await dialog.getByRole("button", { name: "版本更新" }).click();
    const failure = dialog.getByRole("alert");
    await expect(failure).toContainText("发布清单无效");
    await expect(failure).toContainText("错误代码 invalid_manifest");
  });

  test("不支持应用内更新的最小窗口无溢出且通过 axe", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 620 });
    await installDesktopMock(page, { updateScenario: "unsupported" });
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("button", { name: "设备设置" }).click();
    const dialog = page.getByRole("dialog", { name: "Studio Mac 设备中心" });
    await dialog.getByRole("button", { name: "版本更新" }).click();
    await expect(dialog.locator(".update-install-status")).toContainText("稳定更新运行器未安装");
    await expect(dialog.getByRole("button", { name: "此设备不支持应用内更新" })).toBeDisabled();
    const bounds = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(720);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(620);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
    const results = await new AxeBuilder({ page }).include(".device-setup").analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("终端、主题与网络韧性", () => {
  test("终端轮询断线后显示错误，离开面板仍释放远端 PTY", async ({ page }) => {
    await installDesktopMock(page, { terminalFailure: "read" });
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("tab", { name: "终端", exact: true }).click();
    await expect(page.locator(".remote-terminal-wrap").getByRole("alert")).toHaveText("远程终端连接已断开");
    await page.getByRole("tab", { name: "Git", exact: true }).click();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && call.args?.path === "/api/pihub/terminal" && (call.args?.body as { action?: string } | undefined)?.action === "close").length).toBe(1);
  });

  test("浅色主题持久化到重载后的工作台", async ({ page }) => {
    await installDesktopMock(page);
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "切换为浅色" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pihub-theme"))).toBe("light");

    await page.reload();
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(page.getByRole("button", { name: "切换为深色" })).toBeVisible();
  });

  test("慢网保持明确加载态且不会重复创建会话请求", async ({ page }) => {
    await installDesktopMock(page, { remoteDelayMs: 350 });
    await page.goto("/?workspace=alpha");
    await expect(page.getByText("正在连接设备…", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    const sessionLoads = (await desktopCalls(page)).filter((call) => call.command === "agegr_request" && call.args?.path === "/api/sessions");
    expect(sessionLoads.length).toBeGreaterThanOrEqual(1);
    expect((await desktopCalls(page)).filter((call) => call.args?.path === "/api/agent/new")).toHaveLength(0);
  });

  test("离线错误可见，网络恢复后用户刷新即可恢复同一工作台", async ({ page }) => {
    await installDesktopMock(page, { remoteFailure: "offline" });
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("alert")).toContainText("网络离线：无法连接远程设备");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeDisabled();

    await setDesktopNetwork(page, true);
    await page.getByRole("button", { name: "刷新会话列表" }).click();
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await expect(page.getByText("先建立可验证的发布清单，再逐项收敛。")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("原生尺寸、紧凑尺寸与最小尺寸均无横向溢出并通过 axe", async ({ page }) => {
    await installDesktopMock(page);
    for (const viewport of [
      { width: 1180, height: 800 },
      { width: 900, height: 700 },
      { width: 720, height: 620 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/?workspace=alpha");
      await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
      const geometry = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
      }));
      expect(geometry.scrollWidth, `${viewport.width}x${viewport.height} 横向溢出`).toBeLessThanOrEqual(geometry.viewportWidth);
      expect(geometry.scrollHeight, `${viewport.width}x${viewport.height} 纵向溢出`).toBeLessThanOrEqual(geometry.viewportHeight);
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations, `${viewport.width}x${viewport.height} axe violations`).toEqual([]);
    }
  });
});

test("720x620 可访问会话与终端抽屉，无横向溢出或越界", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 720, height: 620 });
  await installDesktopMock(page);
  await page.goto("/?workspace=alpha");
  await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "展开会话侧栏" })).toBeVisible();
  await expect(page.getByRole("button", { name: "展开工具面板" })).toBeVisible();
  await expect(page.getByRole("button", { name: "设备设置" })).toBeVisible();

  await page.getByRole("button", { name: "展开会话侧栏" }).click();
  await expect(page.locator(".session-row-main").filter({ hasText: "实现记录" })).toBeVisible();
  await page.getByRole("button", { name: "收起会话侧栏" }).click();
  await page.getByRole("button", { name: "展开工具面板" }).click();
  await page.getByRole("tab", { name: "终端", exact: true }).click();
  await expect(page.locator(".remote-terminal-wrap")).toBeVisible();

  const geometry = await page.evaluate(() => {
    const pane = document.querySelector(".tool-pane")?.getBoundingClientRect();
    const composer = document.querySelector(".composer")?.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      pane: pane && { left: pane.left, right: pane.right, top: pane.top, bottom: pane.bottom },
      composer: composer && { left: composer.left, right: composer.right, top: composer.top, bottom: composer.bottom, width: composer.width, height: composer.height },
    };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.pane?.left).toBeGreaterThanOrEqual(0);
  expect(geometry.pane?.right).toBeLessThanOrEqual(720);
  expect(geometry.pane?.bottom).toBeLessThanOrEqual(620);
  expect(geometry.composer?.left).toBeGreaterThanOrEqual(0);
  expect(geometry.composer?.right).toBeLessThanOrEqual(720);
  expect(geometry.composer?.width).toBeGreaterThan(280);
  expect(geometry.composer?.height).toBeGreaterThan(60);
  await page.screenshot({ path: join(screenshotDir, `workspace-mobile-720x620-${testInfo.project.name}.png`) });
});

test.describe("会话缓存隐私", () => {
  test("升级时删除旧 IndexedDB 正文、项目路径和持久缓存开关", async ({ page }) => {
    await installDesktopMock(page);
    await page.goto("/?workspace=alpha");
    await expect(page.getByText("先建立可验证的发布清单，再逐项收敛。")).toBeVisible();
    await seedLegacySessionCache(page);
    expect(await legacySessionCacheExists(page)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("pihub-session-cache-enabled"))).toBe("1");
    expect(await page.evaluate(() => localStorage.getItem("pihub-collapsed:/private/project"))).toBe("1");

    await page.reload();
    await expect(page.getByText("先建立可验证的发布清单，再逐项收敛。")).toBeVisible();
    await expect.poll(() => legacySessionCacheExists(page)).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem("pihub-session-cache-enabled"))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("pihub-collapsed:/private/project"))).toBeNull();
  });

  test("会话正文和草稿仅在当前进程内存中跨会话恢复", async ({ page }) => {
    await installDesktopMock(page);
    await page.goto("/?workspace=alpha");
    await expect(page.getByText("先建立可验证的发布清单，再逐项收敛。")).toBeVisible();
    const composer = page.getByRole("textbox", { name: "消息输入" });
    await composer.fill("只保存在内存的草稿");
    await page.locator(".session-row-main").filter({ hasText: "实现记录" }).click();
    await expect(page.getByText("浏览器测试桥已经接通。")).toBeVisible();
    await setDesktopNetwork(page, false);
    await page.locator(".session-row-main").filter({ hasText: "项目规划" }).click();
    await expect(page.getByText("先建立可验证的发布清单，再逐项收敛。")).toBeVisible();
    await expect(composer).toHaveValue("只保存在内存的草稿");
    expect(await legacySessionCacheExists(page)).toBe(false);
  });
});
