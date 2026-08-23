import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { desktopCalls, desktopListenerCount, desktopSnapshot, emitDesktopEvent, installDesktopMock, legacySessionCacheExists, seedLegacySessionCache, setDesktopNetwork, setDesktopRunningSessions } from "./desktopMock";

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

    // 单设备刷新只探测该设备，其它设备的已知状态保持不变
    const probes = async (url: string) => (await desktopCalls(page))
      .filter((call) => call.command === "probe_device" && call.args?.url === url).length;
    const studioBefore = await probes("https://studio.tailnet.ts.net:30141");
    const linuxBefore = await probes("https://build.tailnet.ts.net:30141");
    await studio.getByRole("button", { name: "刷新 Studio Mac 状态" }).click();
    await expect.poll(async () => probes("https://studio.tailnet.ts.net:30141")).toBe(studioBefore + 1);
    await expect(studio.getByText("在线", { exact: true })).toBeVisible();
    await expect(linux.getByText("离线", { exact: true })).toBeVisible();
    await expect(windows.getByText("待配对", { exact: true })).toBeVisible();
    expect(await probes("https://build.tailnet.ts.net:30141")).toBe(linuxBefore);
  });

  test("默认扩展只读展示为签名 Server 管理", async ({ page }, testInfo) => {
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("button", { name: "设备设置" }).click();
    const dialog = page.getByRole("dialog", { name: "Studio Mac 设备中心" });
    const extensions = dialog.locator(".setup-row-readonly").filter({ hasText: "可选插件" });

    await expect(extensions).toContainText("可选插件 7/7");
    await expect(extensions).toContainText("仅来自签名 Server bundle");
    await expect(extensions.getByRole("button")).toHaveCount(0);
    await expect(dialog).toContainText("Magic Context");
    await expect(dialog).toContainText("todowrite 已禁用");

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

  test("Linux SSH 安装可指定用户名，root 需显式二次确认", async ({ page }) => {
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

    // root 允许安装，但必须经过危险确认，且确认前不会发起任何 bootstrap
    await expect(linux.getByRole("button", { name: "Tailscale SSH 配置" })).toBeEnabled();
    await linux.getByRole("button", { name: "Tailscale SSH 配置" }).click();
    await username.fill("root");
    await dialog.getByRole("button", { name: "继续" }).click();
    const confirm = page.getByRole("alertdialog", { name: /确认以 root 安装/ });
    await expect(confirm).toBeVisible();
    expect((await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer")).toHaveLength(1);
    await confirm.getByRole("button", { name: "取消" }).click();
    expect((await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer")).toHaveLength(1);

    await expect(linux.getByRole("button", { name: "Tailscale SSH 配置" })).toBeEnabled();
    await linux.getByRole("button", { name: "Tailscale SSH 配置" }).click();
    await username.fill("root");
    await dialog.getByRole("button", { name: "继续" }).click();
    await page.getByRole("alertdialog", { name: /确认以 root 安装/ }).getByRole("button", { name: "以 root 安装" }).click();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer").length).toBe(2);
    const [, rootBootstrap] = (await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer");
    expect(rootBootstrap.args).toMatchObject({ host: "build.tailnet.ts.net", os: "linux", username: "root" });
  });

  test("配置本地发布包目录后安装自动配对，配对码不进入界面", async ({ page }) => {
    await page.getByRole("button", { name: "设置" }).click();
    const settings = page.getByRole("dialog", { name: "连接设置" });
    await settings.getByLabel("本地发布包目录").fill("/tmp/pihub-release");
    await settings.getByRole("button", { name: "关闭" }).click();

    await page.getByRole("button", { name: "SSH 一键安装" }).click();
    const dialog = page.getByRole("dialog", { name: "SSH 一键安装" });
    const linux = dialog.locator(".peer").filter({ hasText: "Build Linux" });
    await linux.getByRole("button", { name: "Tailscale SSH 配置" }).click();
    await dialog.getByPlaceholder("Linux 用户名（例如 pi 或 ubuntu）").fill("pi");
    await dialog.getByRole("button", { name: "继续" }).click();

    await expect(dialog.getByText(/已自动配对/)).toBeVisible();
    const log = dialog.locator(".bootstrap-log");
    await expect(log).toContainText("安装完成");
    await expect(log).not.toContainText("PIHUB_PAIRING_CODE");
    await expect(page.locator("body")).not.toContainText(`pihub-${"A".repeat(43)}`);

    const bootstrapCalls = (await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer");
    expect(bootstrapCalls).toHaveLength(1);
    expect(bootstrapCalls[0].args).toMatchObject({ localArchiveDir: "/tmp/pihub-release", autoPair: true });
    const pairCalls = (await desktopCalls(page)).filter((call) => call.command === "pair_device");
    expect(pairCalls).toHaveLength(1);
    expect(pairCalls[0].args?.code).toBe(`pihub-${"A".repeat(43)}`);
  });

  test("远程安装可只勾选 Todo Rail 或仅安装 Server", async ({ page }) => {    await page.getByRole("button", { name: "SSH 一键安装" }).click();
    const dialog = page.getByRole("dialog", { name: "SSH 一键安装" });
    const todo = dialog.locator(".extension-checkbox").filter({ hasText: "Todo Rail" }).locator("input");
    await expect(todo).toBeChecked();
    for (const checkbox of await dialog.locator(".extension-checkbox input").all()) {
      // Keep only Todo Rail selected for the first bootstrap request.
      if (await checkbox.isChecked() && await checkbox.evaluate((input) => !(input.parentElement?.textContent ?? "").includes("Todo Rail"))) {
        await checkbox.uncheck();
      }
    }
    const studio = dialog.locator(".peer").filter({ hasText: "Studio Mac" });
    await studio.getByRole("button", { name: "Tailscale SSH 配置" }).click();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer").length).toBe(1);
    let bootstrapCalls = (await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer");
    expect(bootstrapCalls[0].args).toMatchObject({
      host: "studio.tailnet.ts.net",
      os: "macos",
      installDefaultExtensions: true,
      selectedExtensions: ["pi-todo-rail"],
    });

    await dialog.getByLabel("仅安装 Server").check();
    await studio.getByRole("button", { name: "Tailscale SSH 配置" }).click();
    await expect.poll(async () => (await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer").length).toBe(2);
    bootstrapCalls = (await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer");
    expect(bootstrapCalls[1].args).toMatchObject({
      installDefaultExtensions: false,
      selectedExtensions: [],
    });
  });

  test("桌面布局通过 axe 并生成基线截图", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".device-card")).toHaveCount(3);
    const hero = page.locator(".hero");
    const heading = hero.getByRole("heading", { name: "设备工作台" });
    const description = hero.locator("p");

    await expect(heading).toHaveCSS("font-size", "24px");
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

async function openUpdatesPanel(page: Parameters<typeof installDesktopMock>[0]) {
  await page.goto("/?workspace=alpha");
  await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
  await page.getByRole("button", { name: "设备设置" }).click();
  const dialog = page.getByRole("dialog", { name: "Studio Mac 设备中心" });
  await dialog.getByRole("button", { name: "版本更新" }).click();
  await expect(dialog.locator(".setup-row").filter({ hasText: "PiHub Desktop" })).toBeVisible();
  return dialog;
}

test.describe("桌面版本展示", () => {
  test("桌面行只读展示当前版本，不再触发检查、下载或重启命令", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await installDesktopMock(page);
    const dialog = await openUpdatesPanel(page);
    const desktop = dialog.locator(".setup-row").filter({ hasText: "PiHub Desktop" });

    await expect(desktop).toContainText("当前 v0.0.1 · 自用本地构建，更新请在构建机重新出包安装");
    await expect(desktop.getByRole("button")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "检查桌面更新" })).toHaveCount(0);

    const updaterCalls = (await desktopCalls(page)).filter((call) => call.command.startsWith("desktop_update_"));
    expect(updaterCalls.filter((call) => call.command === "desktop_update_status").length).toBeGreaterThanOrEqual(1);
    expect(updaterCalls.filter((call) => call.command !== "desktop_update_status")).toHaveLength(0);
    expect((await desktopCalls(page)).some((call) => call.command.startsWith("plugin:updater") || call.command.startsWith("plugin:process"))).toBe(false);

    const results = await new AxeBuilder({ page }).include(".device-setup").analyze();
    expect(results.violations).toEqual([]);
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

  test("远端 Todo 部件随 setWidget 事件出现、更新并清除", async ({ page }) => {
    await expect.poll(() => desktopListenerCount(page, "pihub-agent-event")).toBe(1);
    const envelope = (event: Record<string, unknown>) => ({
      deviceId: "alpha",
      deviceOrigin: "https://studio.tailnet.ts.net:30141",
      sessionId: "session-1",
      generation: 1,
      event,
    });
    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "todo-rail", widgetLines: ["□ 修复发布清单", "\u001b[32m✓\u001b[0m 插件选择"], widgetPlacement: "aboveEditor" }));
    const widget = page.locator(".extension-widget");
    await expect(widget).toBeVisible();
    await expect(widget).toContainText("□ 修复发布清单");
    // ANSI 转义序列被剥离，不留控制字符
    await expect(widget).toContainText("✓ 插件选择");

    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "extension_ui_request", id: "w2", method: "setWidget", widgetKey: "todo-rail", widgetLines: ["✓ 全部完成"] }));
    await expect(widget).toContainText("✓ 全部完成");
    await expect(widget).not.toContainText("修复发布清单");

    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "extension_ui_request", id: "w3", method: "setWidget", widgetKey: "todo-rail" }));
    await expect(page.locator(".extension-widget")).toHaveCount(0);
  });

  test("扩展 custom UI 渲染按键驱动并在关闭后消失", async ({ page }) => {
    await expect.poll(() => desktopListenerCount(page, "pihub-agent-event")).toBe(1);
    const envelope = (event: Record<string, unknown>) => ({
      deviceId: "alpha",
      deviceOrigin: "https://studio.tailnet.ts.net:30141",
      sessionId: "session-1",
      generation: 1,
      event,
    });
    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "extension_ui_request", id: "ask-1", method: "custom", lines: ["问题：选择环境", "› 开发", "  生产"] }));
    const card = page.locator(".custom-ui-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("问题：选择环境");
    await expect(card).toContainText("› 开发");
    await expect(card).toContainText("生产");
    // 卡片自动获得键盘焦点，方向键/回车直接发给扩展
    const body = card.locator(".custom-ui-card-body");
    await expect(body).toBeFocused();
    await body.press("ArrowDown");
    await body.press("Enter");
    const uiInputs = async () => (await desktopCalls(page))
      .filter((call) => call.command === "agegr_request" && call.args?.path === "/api/agent/session-1" && (call.args?.body as { type?: string } | undefined)?.type === "extension_ui_input")
      .map((call) => { const body = call.args?.body as { id?: string; data?: string }; return { id: body.id, data: body.data }; });
    await expect.poll(async () => (await uiInputs()).length).toBe(2);
    expect(await uiInputs()).toEqual([
      { id: "ask-1", data: "\u001b[B" },
      { id: "ask-1", data: "\r" },
    ]);

    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "extension_ui_request", id: "ask-1", method: "custom", lines: [], closed: true }));
    await expect(card).toHaveCount(0);
  });

  test("扩展 custom UI 的 (x) 选项渲染为可点击按钮", async ({ page }) => {
    await expect.poll(() => desktopListenerCount(page, "pihub-agent-event")).toBe(1);
    const envelope = (event: Record<string, unknown>) => ({
      deviceId: "alpha",
      deviceOrigin: "https://studio.tailnet.ts.net:30141",
      sessionId: "session-1",
      generation: 1,
      event,
    });
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "extension_ui_request",
      id: "ask-2",
      method: "custom",
      lines: ["允许执行该命令？", "(y) Yes", "▸ (n) No", "↑/↓ move · enter confirm · esc deny"],
    }));
    const card = page.locator(".custom-ui-card");
    await expect(card).toBeVisible();
    const options = card.locator(".custom-ui-option");
    await expect(options).toHaveCount(2);
    // 选中标记行高亮；键位提示行不再重复出现
    await expect(options.nth(1)).toHaveClass(/selected/);
    await expect(card).not.toContainText("↑/↓ move");
    // 点击选项发送对应字母键
    await options.nth(1).click();
    await expect.poll(async () => (await desktopCalls(page))
      .filter((call) => (call.args?.body as { type?: string } | undefined)?.type === "extension_ui_input")
      .map((call) => (call.args?.body as { data?: string }).data)).toEqual(["n"]);
    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "extension_ui_request", id: "ask-2", method: "custom", lines: [], closed: true }));
    await expect(card).toHaveCount(0);
  });

  test("扩展 custom UI 解析 pi-ask 编号选项帧（标签栏/描述/页脚）", async ({ page }) => {
    await expect.poll(() => desktopListenerCount(page, "pihub-agent-event")).toBe(1);
    const envelope = (event: Record<string, unknown>) => ({
      deviceId: "alpha",
      deviceOrigin: "https://studio.tailnet.ts.net:30141",
      sessionId: "session-1",
      generation: 1,
      event,
    });
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "extension_ui_request",
      id: "ask-3",
      method: "custom",
      lines: [
        "────────────────────────────────────────",
        "← ☐ 管理密码 ☐ 对外端口 ☰ Review →",
        "",
        "ccLoad 管理后台需要设置一个登录密码 (CCLOAD_PASS)。你希望如何设置?",
        "",
        "❯ 1. 自动生成强密码",
        "     (recommended) | 我生成一个 24 位随机强密码写入 .env，并会在最后告诉你明文",
        "  2. 我自己提供",
        "     你自己设置 CCLOAD_PASS (稍后告诉我，我会写入 .env)",
        "  3. Type your own",
        "",
        "t question type · Enter confirm · N/Shift+N note · Esc dismiss · ? settings",
        "────────────────────────────────────────",
      ],
    }));
    const card = page.locator(".custom-ui-card");
    await expect(card).toBeVisible();
    const options = card.locator(".custom-ui-option");
    await expect(options).toHaveCount(3);
    // 当前行 ❯ 高亮；编号是 TUI 快捷键；描述行并入对应选项
    await expect(options.nth(0)).toHaveClass(/selected/);
    await expect(options.nth(0).locator("kbd")).toHaveText("1");
    await expect(options.nth(0)).toContainText("自动生成强密码");
    await expect(options.nth(0).locator(".custom-ui-option-desc")).toContainText("(recommended)");
    await expect(options.nth(2)).toContainText("Type your own");
    // 问题原文直接展示（不折叠），标签栏单独一行，键位页脚被丢弃
    await expect(card).toContainText("你希望如何设置?");
    await expect(card.locator("details.custom-ui-context")).toHaveCount(0);
    await expect(card.locator(".custom-ui-tabs")).toContainText("管理密码");
    await expect(card).not.toContainText("Esc dismiss");
    // 点击选项发送对应数字键（pi-ask numberShortcut 语义）
    await options.nth(1).click();
    await expect.poll(async () => (await desktopCalls(page))
      .filter((call) => (call.args?.body as { type?: string } | undefined)?.type === "extension_ui_input")
      .map((call) => (call.args?.body as { data?: string }).data)).toEqual(["2"]);
    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "extension_ui_request", id: "ask-3", method: "custom", lines: [], closed: true }));
    await expect(card).toHaveCount(0);
  });

  test("权限系统双帧：任意选中标记行可点击，双击确认不卡循环", async ({ page }) => {
    await expect.poll(() => desktopListenerCount(page, "pihub-agent-event")).toBe(1);
    const envelope = (event: Record<string, unknown>) => ({
      deviceId: "alpha",
      deviceOrigin: "https://studio.tailnet.ts.net:30141",
      sessionId: "session-1",
      generation: 1,
      event,
    });
    const uiInputs = async () => (await desktopCalls(page))
      .filter((call) => (call.args?.body as { type?: string } | undefined)?.type === "extension_ui_input")
      .map((call) => (call.args?.body as { data?: string }).data);
    // 初始帧：权限系统的选中行标记是 ▶（不在常见标记字符集里）
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "extension_ui_request",
      id: "perm-1",
      method: "custom",
      lines: [
        "请求执行 bash 命令: timeout 30 curl -s https://example.com",
        "",
        "▶ (y) Yes",
        "  (s) Yes, allow bash \"timeout *\" for this session",
        "  (n) No",
        "  (r) No, provide reason",
        "",
      ],
    }));
    const card = page.locator(".custom-ui-card");
    await expect(card).toBeVisible();
    let options = card.locator(".custom-ui-option");
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).toHaveClass(/selected/);
    await expect(options.nth(0)).toContainText("Yes");
    // 点击 (s)：发送 s，扩展进入 armed 帧（提示再按一次）
    await options.nth(1).click();
    await expect.poll(async () => (await uiInputs()).join(",")).toBe("s");
    await emitDesktopEvent(page, "pihub-agent-event", envelope({
      type: "extension_ui_request",
      id: "perm-1",
      method: "custom",
      lines: [
        "请求执行 bash 命令: timeout 30 curl -s https://example.com",
        "",
        "  (y) Yes",
        "▶ (s) Yes, allow bash \"timeout *\" for this session",
        "  (n) No",
        "  (r) No, provide reason",
        "",
        "Press s again to approve for this session.",
      ],
    }));
    options = card.locator(".custom-ui-option");
    await expect(options).toHaveCount(4);
    // armed 行仍然是可点击按钮且高亮，提示行保留展示
    await expect(options.nth(1)).toHaveClass(/selected/);
    await expect(card).toContainText("Press s again to approve for this session.");
    // 再点同一个按钮：发送第二次 s 完成确认
    await options.nth(1).click();
    await expect.poll(async () => (await uiInputs()).join(",")).toBe("s,s");
    await emitDesktopEvent(page, "pihub-agent-event", envelope({ type: "extension_ui_request", id: "perm-1", method: "custom", lines: [], closed: true }));
    await expect(card).toHaveCount(0);
  });

  test("@ 提及从文件索引补全并插入相对路径", async ({ page }) => {
    const composer = page.getByRole("textbox", { name: "消息输入" });
    await composer.click();
    await composer.pressSequentially("@App");
    const menu = page.locator(".mention-menu");
    await expect(menu.getByText("@src/App.tsx")).toBeVisible();
    await menu.getByText("@src/App.tsx").click();
    await expect(composer).toHaveValue("@src/App.tsx ");
    await expect(menu).toHaveCount(0);
  });

  test("文件面板右键菜单可将文件插入消息引用", async ({ page }) => {
    const row = page.locator(".native-file-list > button", { hasText: "README.md" });
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "在消息中引用" }).click();
    await expect(page.getByRole("textbox", { name: "消息输入" })).toHaveValue("@README.md ");
  });

  test("连续纯工具调用消息合并为一个分组卡片", async ({ page }) => {
    const composer = page.getByRole("textbox", { name: "消息输入" });
    await composer.fill("跑两个命令");
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect.poll(() => desktopListenerCount(page, "pihub-agent-event")).toBe(1);
    const envelope = (event: Record<string, unknown>) => ({ deviceId: "alpha", deviceOrigin: "https://studio.tailnet.ts.net:30141", sessionId: "session-1", generation: 1, event });
    const call = (id: string, command: string) => ({ type: "message_end", message: { role: "assistant", timestamp: Date.now(), model: "gpt-5", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] } });
    const result = (id: string) => ({ type: "message_end", message: { role: "toolResult", toolCallId: id, timestamp: Date.now(), content: [{ type: "text", text: "done" }] } });
    await emitDesktopEvent(page, "pihub-agent-event", envelope(call("c1", "ls")));
    await emitDesktopEvent(page, "pihub-agent-event", envelope(result("c1")));
    await emitDesktopEvent(page, "pihub-agent-event", envelope(call("c2", "pwd")));
    await emitDesktopEvent(page, "pihub-agent-event", envelope(result("c2")));
    const group = page.locator(".tool-group");
    await expect(group).toHaveCount(1);
    await expect(group.locator(".tool-group-head")).toContainText("2 个工具调用");
    await expect(group.locator(".original-tool-call")).toHaveCount(2);
    // 分组可整体折叠
    await group.locator(".tool-group-head").click();
    await expect(group.locator(".original-tool-call")).toHaveCount(0);
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
    expect((await desktopCalls(page)).some((call) => call.command === "upload_remote_commit" && String(call.args?.path).includes("conflict=overwrite"))).toBe(true);
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

test.describe("Server GitHub 签名更新", () => {
  test("检测到 GitHub 新版本后经 supervisor 安装", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await installDesktopMock(page, { updateScenario: "available" });
    const dialog = await openUpdatesPanel(page);
    const server = dialog.locator(".setup-row").filter({ hasText: "PiHub Server" });

    await expect(server).toContainText("当前 v0.0.1 · GitHub stable 最新 v0.0.2");
    await server.getByRole("button", { name: "安装 v0.0.2" }).click();
    await expect(dialog.getByText("更新完成", { exact: true })).toBeVisible({ timeout: 20000 });
    await expect(dialog.locator(".update-phase.succeeded")).toContainText("v0.0.2");
    await expect(server).toContainText("已就绪");

    const updateCalls = (await desktopCalls(page)).filter((call) => call.args?.path === "/api/pihub/updates");
    expect(updateCalls.some((call) => call.args?.method === "POST")).toBe(true);
    // GitHub 流程由服务端 supervisor 下载安装，桌面端不再 SSH 直传
    expect((await desktopCalls(page)).filter((call) => call.command === "bootstrap_tailnet_peer")).toHaveLength(0);
    expect((await desktopCalls(page)).filter((call) => call.command === "check_local_server_update")).toHaveLength(0);
  });

  test("有会话运行时需确认后才强制更新，Esc 只关闭最上层确认框", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await installDesktopMock(page, { updateScenario: "busy" });
    const dialog = await openUpdatesPanel(page);
    const server = dialog.locator(".setup-row").filter({ hasText: "PiHub Server" });
    await expect(server.getByRole("button", { name: "安装 v0.0.2" })).toBeEnabled();
    await setDesktopRunningSessions(page, ["session-1"]);

    await server.getByRole("button", { name: "安装 v0.0.2" }).click();
    const confirm = page.getByRole("alertdialog", { name: /有会话正在运行/ });
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(server.getByRole("button", { name: "安装 v0.0.2" })).toBeFocused();
    expect((await desktopCalls(page)).filter((call) => call.args?.path === "/api/pihub/updates" && call.args?.method === "POST")).toHaveLength(0);

    await server.getByRole("button", { name: "安装 v0.0.2" }).click();
    await confirm.getByRole("button", { name: "强制更新" }).click();
    await expect(dialog.getByText("更新完成", { exact: true })).toBeVisible({ timeout: 20000 });
    const posts = (await desktopCalls(page)).filter((call) => call.args?.path === "/api/pihub/updates" && call.args?.method === "POST");
    expect(posts).toHaveLength(1);
    expect((posts[0].args?.body as { force?: boolean }).force).toBe(true);
  });

  test("已是最新时显示已就绪", async ({ page }) => {
    await installDesktopMock(page, { updateScenario: "none" });
    const dialog = await openUpdatesPanel(page);
    const server = dialog.locator(".setup-row").filter({ hasText: "PiHub Server" });
    await expect(server).toContainText("当前 v0.0.1 · GitHub stable 最新 v0.0.1");
    await expect(server).toContainText("已就绪");
    await expect(dialog.getByRole("button", { name: /安装 v/ })).toHaveCount(0);
  });

  test("签名清单校验失败时显示错误并可重新检查", async ({ page }) => {
    await installDesktopMock(page, { updateScenario: "signature-failure" });
    const dialog = await openUpdatesPanel(page);
    await expect(dialog.getByRole("alert")).toContainText("Signed public release could not be verified");
    const server = dialog.locator(".setup-row").filter({ hasText: "PiHub Server" });
    await expect(server).toContainText("GitHub 更新检查失败");
    await server.getByRole("button", { name: "重新检查" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Signed public release could not be verified");
  });

  test("服务未托管时显示手动更新，不提供安装按钮", async ({ page }) => {
    await installDesktopMock(page, { updateScenario: "unsupported" });
    const dialog = await openUpdatesPanel(page);
    const server = dialog.locator(".setup-row").filter({ hasText: "PiHub Server" });
    await expect(server).toContainText("手动更新");
    await expect(server).toContainText("GitHub stable 最新 v0.0.2");
    await expect(dialog.getByRole("button", { name: /安装 v/ })).toHaveCount(0);
  });

  test("更新事务失败时提示已回滚", async ({ page }) => {
    await installDesktopMock(page, { updateScenario: "failed" });
    const dialog = await openUpdatesPanel(page);
    await expect(dialog.getByRole("alert")).toContainText("PiHub Server 更新失败（invalid_manifest）");
  });

  test("组件版本面板展示设备已安装版本", async ({ page }) => {
    await installDesktopMock(page, { updateScenario: "none" });
    const dialog = await openUpdatesPanel(page);
    const components = dialog.locator(".extension-status-panel").filter({ hasText: "组件版本" });
    await expect(components).toContainText("Pi Agent 运行时");
    await expect(components).toContainText("Todo Rail");
    await expect(components).toContainText("v0.2.3");
  });

  test("GitHub 流程的最小窗口无溢出且通过 axe", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 620 });
    await installDesktopMock(page, { updateScenario: "available" });
    const dialog = await openUpdatesPanel(page);
    await expect(dialog.locator(".setup-row").filter({ hasText: "PiHub Server" })).toContainText("GitHub stable 最新 v0.0.2");
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

  test("桌面端通过事件流接收终端输出", async ({ page }) => {
    await installDesktopMock(page);
    await page.goto("/?workspace=alpha");
    await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
    await page.getByRole("tab", { name: "终端", exact: true }).click();
    await expect.poll(() => desktopListenerCount(page, "pihub-terminal-event")).toBe(1);
    await emitDesktopEvent(page, "pihub-terminal-event", {
      deviceId: "alpha",
      deviceOrigin: "https://studio.tailnet.ts.net:30141",
      terminalId: "terminal-1",
      generation: 1,
      event: { type: "output", data: "pihub-pty-stream-ok\r\n" },
    });
    await expect(page.locator(".xterm-rows")).toContainText("pihub-pty-stream-ok");
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
