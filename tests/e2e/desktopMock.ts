import type { Page } from "@playwright/test";

export interface DesktopMockOptions {
  desktopUpdateScenario?: "available" | "none" | "signature-failure";
  pairingFailure?: "invalid-once" | "network-once" | "rate-limit";
  remoteDelayMs?: number;
  remoteFailure?: "offline" | "offline-once";
  resourceFailure?: "managed" | "plugin-once" | "read-once" | "trust-once";
  resourceTrust?: "forbidden" | "trusted" | "untrusted";
  terminalFailure?: "create" | "read";
  updateScenario?: "apply-failure" | "available" | "busy" | "failed" | "none" | "signature-failure" | "unsupported";
}

export async function installDesktopMock(page: Page, options: DesktopMockOptions = {}): Promise<void> {
  await page.addInitScript(({ desktopUpdateScenario = "none", pairingFailure, remoteDelayMs = 0, remoteFailure, resourceFailure, resourceTrust = "trusted", terminalFailure, updateScenario = "none" }) => {
    const now = new Date().toISOString();
    const devices = [
      { id: "alpha", name: "Studio Mac", host: "studio.tailnet.ts.net", url: "https://studio.tailnet.ts.net:30141", source: "tailscale", favorite: true, accent: "#fa6f46", os: "macos" },
      { id: "beta", name: "Build Linux", host: "build.tailnet.ts.net", url: "https://build.tailnet.ts.net:30141", source: "tailscale", favorite: false, accent: "#55c7a5", os: "linux" },
      { id: "gamma", name: "Office Windows", host: "office.tailnet.ts.net", url: "https://office.tailnet.ts.net:30141", source: "tailscale", favorite: false, accent: "#64a9ff", os: "windows" },
    ];
    const sessions = [
      { id: "session-1", cwd: "/projects/pihub", name: "项目规划", created: now, modified: now, messageCount: 2, firstMessage: "规划 PiHub", projectRoot: "/projects/pihub", projectKey: "pihub" },
      { id: "session-2", cwd: "/projects/pihub-worktrees/feature-e2e", name: "实现记录", created: now, modified: now, messageCount: 2, firstMessage: "实现桌面端", projectRoot: "/projects/pihub", projectKey: "pihub", worktreeBranch: "feature/e2e" },
    ];
    const details: Record<string, unknown> = {
      "session-1": {
        sessionId: "session-1",
        info: sessions[0],
        context: {
          messages: [
            { role: "user", content: "请规划 PiHub 的发布流程", timestamp: 1 },
            { role: "assistant", content: "先建立可验证的发布清单，再逐项收敛。", timestamp: 2 },
          ],
          entryIds: ["entry-1", "entry-2"],
          thinkingLevel: "medium",
          model: { provider: "openai", modelId: "gpt-5" },
          truncated: false,
          totalMessages: 2,
        },
        totalActiveMs: 2500,
      },
      "session-2": {
        sessionId: "session-2",
        info: sessions[1],
        context: {
          messages: [
            { role: "user", content: "记录桌面端实现进度", timestamp: 3 },
            { role: "assistant", content: "浏览器测试桥已经接通。", timestamp: 4 },
          ],
          entryIds: ["entry-3", "entry-4"],
          thinkingLevel: "low",
          model: { provider: "openai", modelId: "gpt-5" },
          truncated: false,
          totalMessages: 2,
        },
        totalActiveMs: 1800,
      },
    };
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const credentials = new Set(["https://studio.tailnet.ts.net:30141"]);
    const runningSessionIds = new Set<string>();
    const directories = new Set(["/projects/pihub", "/projects/pihub/src", "/projects/pihub-worktrees", "/projects/pihub-worktrees/feature-e2e"]);
    const files = new Map<string, { content: string; language: string }>([
      ["/projects/pihub/README.md", { content: "# PiHub\n\nBrowser mock file.", language: "markdown" }],
      ["/projects/pihub/src/App.tsx", { content: "export default function App() { return null; }\n", language: "typescript" }],
    ]);
    let modelsConfig: Record<string, unknown> = { providers: { openai: { baseUrl: "https://api.openai.com" } } };
    let newApiConfig = { providers: [] as Array<{ name: string; baseUrl: string; authenticated: boolean; overrideCount: number }>, settings: { sendSessionAffinityHeaders: true } };
    let worktrees = [
      { path: "/projects/pihub", branch: "main", isMain: true },
      { path: "/projects/pihub-worktrees/feature-e2e", branch: "feature/e2e", isMain: false },
    ];
    let projectTrust = { requiresTrust: true, trusted: resourceTrust === "trusted" };
    let skills = [
      {
        name: "release-audit",
        description: "检查发布清单、签名资产与隐私边界。",
        filePath: "/opt/pihub/skills/release-audit/SKILL.md",
        baseDir: "/opt/pihub/skills/release-audit",
        disableModelInvocation: false,
        sourceInfo: { source: "pihub/release-audit", scope: "global" },
        install: { package: "pihub/catalog@release-audit", scope: "global", source: "pihub/catalog", canCheckForUpdates: false },
      },
      {
        name: "project-conventions",
        description: "应用当前项目已审查的工程约定。",
        filePath: "/projects/pihub/.agents/skills/project-conventions/SKILL.md",
        baseDir: "/projects/pihub/.agents/skills/project-conventions",
        disableModelInvocation: true,
        sourceInfo: { source: "project", scope: "project" },
      },
    ];
    let plugins = [
      {
        id: "pkg_guardrails",
        label: "@pihub/guardrails",
        scope: "global",
        disabled: false,
        version: "0.0.1",
        counts: { extensions: 1, skills: 0, prompts: 1, themes: 0 },
        status: "loaded",
      },
      {
        id: "pkg_project_tools",
        label: "project-tools",
        scope: "project",
        disabled: true,
        counts: { extensions: 1, skills: 0, prompts: 0, themes: 0 },
        status: "disabled",
      },
    ];
    let resourceReadFailures = resourceFailure === "read-once" ? 1 : 0;
    let resourceTrustFailures = resourceFailure === "trust-once" ? 1 : 0;
    let resourcePluginFailures = resourceFailure === "plugin-once" ? 1 : 0;
    let remoteOnline = remoteFailure !== "offline";
    let offlineFailuresRemaining = remoteFailure === "offline-once" ? 1 : 0;
    let serverVersion = "0.0.1";
    type DesktopUpdateMockState = {
      phase: "idle" | "checking" | "available" | "upToDate" | "downloading" | "verifying" | "installing" | "readyToRestart" | "restarting" | "failed";
      currentVersion: string;
      availableVersion?: string;
      downloadedBytes?: number;
      totalBytes?: number;
      checkedAt?: number;
      errorCode?: string;
      errorMessage?: string;
    };
    let desktopUpdateState: DesktopUpdateMockState = { phase: "idle", currentVersion: "0.0.1" };
    let desktopUpdateInstallGeneration = 0;
    let updateOperationId = "";
    let updatePollCount = 0;
    let terminalCounter = 0;
    let terminalReadCount = 0;
    let pairingAttempts = 0;
    let sessionCounter = sessions.length;
    let streamGeneration = 0;

    function clone<T>(value: T): T {
      return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
    }

    function delay(ms: number): Promise<void> {
      return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
    }

    function normalizePath(value: string): string {
      const normalized = `/${value.replaceAll("\\", "/")}`.replace(/\/{2,}/g, "/").replace(/\/$/, "");
      return normalized || "/";
    }

    function parentPath(value: string): string {
      const normalized = normalizePath(value);
      const index = normalized.lastIndexOf("/");
      return index <= 0 ? "/" : normalized.slice(0, index);
    }

    function baseName(value: string): string {
      return normalizePath(value).split("/").at(-1) || "";
    }

    function resolveDestination(source: string, destination: string): string {
      return normalizePath(destination.includes("/") || destination.includes("\\") ? destination : `${parentPath(source)}/${destination}`);
    }

    function remoteFilePath(requestPath: string): string {
      const parsed = new URL(requestPath, "https://mock.invalid");
      return normalizePath(parsed.pathname.slice("/api/files/".length).split("/").map(decodeURIComponent).join("/"));
    }

    function directoryListing(directory: string) {
      const normalized = normalizePath(directory);
      const entries = [
        ...[...directories]
          .filter((candidate) => candidate !== normalized && parentPath(candidate) === normalized)
          .map((candidate) => ({ name: baseName(candidate), isDir: true, size: 0, modified: now })),
        ...[...files.entries()]
          .filter(([candidate]) => parentPath(candidate) === normalized)
          .map(([candidate, file]) => ({ name: baseName(candidate), isDir: false, size: file.content.length, modified: now })),
      ];
      return { path: normalized, entries };
    }

    function resourceCounts(items: typeof plugins) {
      return items.reduce((totals, plugin) => ({
        extensions: totals.extensions + plugin.counts.extensions,
        skills: totals.skills + plugin.counts.skills,
        prompts: totals.prompts + plugin.counts.prompts,
        themes: totals.themes + plugin.counts.themes,
      }), { extensions: 0, skills: 0, prompts: 0, themes: 0 });
    }

    function visibleSkills() {
      return projectTrust.trusted ? skills : skills.filter((skill) => skill.sourceInfo.scope !== "project");
    }

    function visiblePlugins() {
      return projectTrust.trusted ? plugins : plugins.filter((plugin) => plugin.scope !== "project");
    }

    function moveEntry(sourceValue: string, destinationValue: string): void {
      const source = normalizePath(sourceValue);
      const destination = resolveDestination(source, destinationValue);
      const file = files.get(source);
      if (file) {
        files.delete(source);
        files.set(destination, file);
        return;
      }
      if (!directories.has(source)) return;
      const directoryEntries = [...directories].filter((candidate) => candidate === source || candidate.startsWith(`${source}/`));
      const fileEntries = [...files.entries()].filter(([candidate]) => candidate.startsWith(`${source}/`));
      for (const candidate of directoryEntries) directories.delete(candidate);
      for (const [candidate] of fileEntries) files.delete(candidate);
      for (const candidate of directoryEntries) directories.add(`${destination}${candidate.slice(source.length)}`);
      for (const [candidate, value] of fileEntries) files.set(`${destination}${candidate.slice(source.length)}`, value);
    }

    function emit(event: string, payload: unknown): void {
      for (const callback of listeners.get(event) ?? []) callback(clone(payload));
    }

    function setDesktopUpdate(next: DesktopUpdateMockState): DesktopUpdateMockState {
      desktopUpdateState = next;
      emit("pihub-desktop-update", desktopUpdateState);
      return clone(desktopUpdateState);
    }

    async function agegrRequest(args: Record<string, unknown>): Promise<unknown> {
      const path = String(args.path ?? "");
      const method = String(args.method ?? "GET");
      const body = (args.body ?? {}) as Record<string, unknown>;
      await delay(remoteDelayMs);
      if (!remoteOnline || offlineFailuresRemaining > 0) {
        if (offlineFailuresRemaining > 0) offlineFailuresRemaining -= 1;
        throw new Error("网络离线：无法连接远程设备");
      }
      if (path.startsWith("/api/project-trust")) {
        if (resourceTrust === "forbidden") throw new Error("Insufficient device capability");
        if (method === "POST") {
          if (resourceTrustFailures > 0) {
            resourceTrustFailures -= 1;
            throw new Error("Wait for the active session to finish before trusting this project");
          }
          projectTrust = { requiresTrust: true, trusted: true };
        }
        return clone(projectTrust);
      }
      if (path.startsWith("/api/skills")) {
        if (method === "GET") {
          if (resourceReadFailures > 0) {
            resourceReadFailures -= 1;
            throw new Error("临时读取失败");
          }
          return { skills: clone(visibleSkills()), diagnostics: [], projectResourcesLoaded: projectTrust.trusted };
        }
        if (method === "PATCH") {
          const filePath = String(body.filePath ?? "");
          if (!skills.some((skill) => skill.filePath === filePath)) throw new Error("Access denied");
          skills = skills.map((skill) => skill.filePath === filePath ? { ...skill, disableModelInvocation: body.disableModelInvocation === true } : skill);
          return { success: true };
        }
      }
      if (path.startsWith("/api/plugins")) {
        if (method === "GET") {
          const visible = visiblePlugins();
          return { packages: clone(visible), totals: resourceCounts(visible), diagnostics: [], projectResourcesLoaded: projectTrust.trusted };
        }
        if (method === "POST") {
          const action = String(body.action ?? "");
          const packageId = String(body.packageId ?? "");
          const scope = String(body.scope ?? "");
          if (!plugins.some((plugin) => plugin.id === packageId && plugin.scope === scope)) throw new Error("Access denied");
          if (action !== "enable" && action !== "disable") throw new Error("signed_catalog_required: Signed catalog required (HTTP 410)");
          if (resourceFailure === "managed") throw new Error("signed_catalog_required: Signed catalog required (HTTP 410)");
          if (resourcePluginFailures > 0) {
            resourcePluginFailures -= 1;
            throw new Error("Plugin operation failed");
          }
          plugins = plugins.map((plugin) => plugin.id === packageId && plugin.scope === scope
            ? { ...plugin, disabled: action === "disable", status: action === "disable" ? "disabled" : "loaded" }
            : plugin);
          const visible = visiblePlugins();
          return { packages: clone(visible), totals: resourceCounts(visible), diagnostics: [], projectResourcesLoaded: projectTrust.trusted };
        }
      }
      if (path === "/api/sessions") return { sessions: clone(sessions), runningSessionIds: [...runningSessionIds] };
      if (path === "/api/agent/new" && method === "POST") {
        const id = `session-${++sessionCounter}`;
        const cwd = normalizePath(String(body.cwd ?? "/projects/pihub"));
        const session = { id, cwd, name: "新会话", created: now, modified: now, messageCount: 0, firstMessage: "", projectRoot: cwd, projectKey: cwd };
        sessions.push(session);
        details[id] = { sessionId: id, info: session, context: { messages: [], entryIds: [], thinkingLevel: "medium", model: { provider: "openai", modelId: "gpt-5" }, truncated: false, totalMessages: 0 }, totalActiveMs: 0 };
        return { success: true, sessionId: id, model: { provider: "openai", modelId: "gpt-5" }, thinkingLevel: "medium" };
      }
      const sessionMatch = path.match(/^\/api\/sessions\/([^/?]+)/);
      if (sessionMatch && method === "DELETE") {
        const id = decodeURIComponent(sessionMatch[1]);
        const index = sessions.findIndex((item) => item.id === id);
        if (index >= 0) sessions.splice(index, 1);
        delete details[id];
        return { success: true };
      }
      if (sessionMatch && method === "PATCH") {
        const id = decodeURIComponent(sessionMatch[1]);
        const session = sessions.find((item) => item.id === id);
        if (session && typeof body.name === "string") session.name = body.name;
        return { success: true };
      }
      if (sessionMatch && path.includes("/auto-name")) return { title: "自动生成标题" };
      if (sessionMatch && path.includes("/thinking")) return { thinking: "测试思考内容" };
      if (sessionMatch) return clone(details[decodeURIComponent(sessionMatch[1])] ?? null);
      if (/^\/api\/agent\/running/.test(path)) return { runningSessionIds: [...runningSessionIds] };
      const agentMatch = path.match(/^\/api\/agent\/([^/?]+)$/);
      if (agentMatch && method === "GET") {
        const id = decodeURIComponent(agentMatch[1]);
        return { running: runningSessionIds.has(id), state: runningSessionIds.has(id) ? { isStreaming: true } : undefined };
      }
      if (agentMatch && method === "POST") {
        const id = decodeURIComponent(agentMatch[1]);
        if (body.type === "get_tools") return { data: [{ name: "read", active: true }, { name: "bash", active: true }] };
        if (body.type === "get_commands") return { data: { commands: [{ name: "review", description: "审查当前改动", source: "mock" }] } };
        if (body.type === "prompt" || body.type === "steer") runningSessionIds.add(id);
        if (body.type === "abort") runningSessionIds.delete(id);
        if (body.type === "set_model") {
          const detail = details[id] as { context?: { model?: unknown } } | undefined;
          if (detail?.context) detail.context.model = { provider: body.provider, modelId: body.modelId };
        }
        if (body.type === "set_thinking_level") {
          const detail = details[id] as { context?: { thinkingLevel?: unknown } } | undefined;
          if (detail?.context) detail.context.thinkingLevel = body.level;
        }
        return { success: true, data: {} };
      }
      if (path.startsWith("/api/models?")) return {
        models: { "openai:gpt-5": "GPT-5" },
        modelList: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }],
        defaultModel: { provider: "openai", modelId: "gpt-5" },
        thinkingLevels: { "openai:gpt-5": ["off", "low", "medium", "high"] },
      };
      if (path.startsWith("/api/files/")) {
        const parsed = new URL(path, "https://mock.invalid");
        const target = remoteFilePath(path);
        const type = parsed.searchParams.get("type");
        if (type === "list") return clone(directoryListing(target));
        if (type === "read") {
          const file = files.get(target);
          if (!file) throw new Error(`文件不存在：${target}`);
          return { content: file.content, language: file.language, size: file.content.length };
        }
        if (type === "upload-check") {
          const fileNames = Array.isArray(body.fileNames) ? body.fileNames.map(String) : [];
          return {
            conflicts: fileNames.filter((name) => files.has(normalizePath(`${target}/${name}`))),
            nonReplaceable: fileNames.filter((name) => directories.has(normalizePath(`${target}/${name}`))),
          };
        }
        if (type === "download") return { success: true };
      }
      if (path.startsWith("/api/file-index")) {
        const cwd = normalizePath(new URL(path, "https://mock.invalid").searchParams.get("cwd") ?? "/projects/pihub");
        return { files: [...files.keys()].filter((candidate) => candidate.startsWith(`${cwd}/`)).map((candidate) => candidate.slice(cwd.length + 1)) };
      }
      if (path.startsWith("/api/git/status")) return { isGitRepository: true, repositoryRoot: "/projects/pihub", files: [{ filePath: "src/App.tsx", status: "modified" }], additions: 12, deletions: 3 };
      if (path.startsWith("/api/git/diff")) return { supported: true, status: "modified", patch: "@@ -1 +1 @@\n-old\n+changed\n" };
      if (path.startsWith("/api/worktrees")) {
        const cwd = normalizePath(new URL(path, "https://mock.invalid").searchParams.get("cwd") ?? String(body.cwd ?? "/projects/pihub"));
        if (method === "POST") {
          const branch = String(body.branch ?? "");
          const created = { path: `/projects/pihub-worktrees/${branch.replaceAll("/", "-")}`, branch, isMain: false };
          worktrees = [...worktrees, created];
          directories.add(created.path);
          return clone(created);
        }
        if (method === "DELETE") {
          const target = normalizePath(String(body.path ?? ""));
          worktrees = worktrees.filter((worktree) => worktree.path !== target);
          for (const candidate of [...directories]) if (candidate === target || candidate.startsWith(`${target}/`)) directories.delete(candidate);
          return { success: true };
        }
        return {
          projectRoot: "/projects/pihub",
          projectKey: "pihub",
          isGit: true,
          isTopLevel: cwd === "/projects/pihub",
          currentWorktreePath: worktrees.find((worktree) => worktree.path === cwd)?.path ?? null,
          worktrees: clone(worktrees),
        };
      }
      if (path === "/api/pihub/terminal" && method === "POST") {
        if (body.action === "create") {
          if (terminalFailure === "create") throw new Error("无法建立远程 PTY");
          return { id: `terminal-${++terminalCounter}`, cwd: body.cwd };
        }
        return { success: true };
      }
      if (path.startsWith("/api/pihub/terminal?") && method === "GET") {
        terminalReadCount += 1;
        if (terminalFailure === "read" && terminalReadCount >= 1) throw new Error("远程终端连接已断开");
        return { chunk: terminalReadCount === 1 ? "PiHub terminal ready\r\n" : "", cursor: 22, reset: false };
      }
      if (path.startsWith("/api/cwd/browse")) {
        const requested = new URL(path, "https://mock.invalid").searchParams.get("path");
        const directory = normalizePath(requested ?? "/projects");
        return {
          path: directory,
          parentPath: directory === "/" ? null : parentPath(directory),
          directories: [...directories].filter((candidate) => parentPath(candidate) === directory).map((candidate) => ({ name: baseName(candidate), path: candidate })),
        };
      }
      if (path === "/api/cwd/validate") return { cwd: String(body.cwd ?? "/projects") };
      if (path === "/api/pihub/files" && method === "POST") {
        const action = String(body.action ?? "");
        const target = normalizePath(String(body.path ?? "/projects/pihub"));
        if (action === "mkdir") directories.add(normalizePath(`${target}/${String(body.name ?? "")}`));
        if (action === "touch") files.set(normalizePath(`${target}/${String(body.name ?? "")}`), { content: "", language: "text" });
        if (action === "write") files.set(target, { content: String(body.content ?? ""), language: files.get(target)?.language ?? "text" });
        if ((action === "rename" || action === "move") && typeof body.destination === "string") moveEntry(target, body.destination);
        if (action === "delete") {
          files.delete(target);
          for (const candidate of [...files.keys()]) if (candidate.startsWith(`${target}/`)) files.delete(candidate);
          for (const candidate of [...directories]) if (candidate === target || candidate.startsWith(`${target}/`)) directories.delete(candidate);
        }
        return { success: true };
      }
      if (path === "/api/models-config") {
        if (method === "PUT") modelsConfig = clone(body);
        return clone(modelsConfig);
      }
      if (path === "/api/pihub/newapi") {
        if (method === "GET") return clone(newApiConfig);
        const action = String(body.action ?? "");
        if (action === "save") {
          const name = String(body.name ?? "");
          const existing = newApiConfig.providers.find((provider) => provider.name === name);
          const provider = { name, baseUrl: String(body.baseUrl ?? ""), authenticated: Boolean(body.apiKey) || Boolean(existing?.authenticated), overrideCount: existing?.overrideCount ?? 0 };
          newApiConfig = { providers: [...newApiConfig.providers.filter((item) => item.name !== name), provider], settings: { sendSessionAffinityHeaders: body.sendSessionAffinityHeaders !== false } };
        }
        if (action === "refresh") newApiConfig = { ...newApiConfig, providers: newApiConfig.providers.map((provider) => provider.name === body.name ? { ...provider, overrideCount: 2 } : provider) };
        if (action === "delete") newApiConfig = { ...newApiConfig, providers: newApiConfig.providers.filter((provider) => provider.name !== body.name) };
        return clone(newApiConfig);
      }
      if (path === "/api/pihub/setup") return {
        platform: { os: "darwin", remoteAccess: "tailscale-ssh", openSshRunning: true, terminalBackend: "pty", preferredShell: "zsh" },
        tailscale: { installed: true, connected: true, dnsName: "studio.tailnet.ts.net", sshEnabled: true, serveEnabled: true, serveUrl: "https://studio.tailnet.ts.net" },
        pi: { installed: true },
        defaultExtensions: {
          installed: true,
          installedCount: 5,
          total: 5,
          source: "signed-release",
          packages: [
            { name: "@ff-labs/pi-fff", version: "0.10.5", installed: true },
            { name: "pi-simplify", version: "0.2.3", installed: true },
            { name: "@gotgenes/pi-permission-system", version: "26.3.0", installed: true },
            { name: "@eko24ive/pi-ask", version: "1.2.0", installed: true },
            { name: "@gotgenes/pi-subagents", version: "19.3.2", installed: true },
          ],
        },
        server: { installed: true, packageName: "pihub-server", version: serverVersion, running: true },
        installPlan: [],
        security: { binding: "127.0.0.1", tailnetOnly: true, funnelSupported: false },
      };
      if (path.startsWith("/api/pihub/updates")) {
        if (method === "GET" && updateScenario === "signature-failure") throw new Error("Signed public release could not be verified");
        if (method === "POST") {
          const keys = Object.keys(body).sort();
          if (body.action !== "apply" || keys.some((key) => key !== "action" && key !== "force")) throw new Error("Unsupported update action");
          if (updateScenario === "busy" && body.force !== true) {
            throw new Error("busy: Agent sessions are still running");
          }
          if (updateScenario === "apply-failure") throw new Error("Server update could not be queued: update_runtime_unavailable");
          updateOperationId = "a".repeat(32);
          updatePollCount = 0;
          return { accepted: true, operationId: updateOperationId, update: { phase: "queued", operationId: updateOperationId, targetVersion: "0.0.2", updatedAt: now } };
        }
        const phases = ["queued", "applying", "restarting", "succeeded"];
        const phase = updateScenario === "failed" ? "failed" : updateOperationId ? phases[Math.min(updatePollCount++, phases.length - 1)] : "idle";
        if (phase === "succeeded") serverVersion = "0.0.2";
        const available = updateScenario !== "none" && serverVersion !== "0.0.2";
        return {
          server: { current: serverVersion, latest: updateScenario === "none" ? serverVersion : "0.0.2", updateAvailable: available, platform: "darwin", arch: "arm64", channel: "stable" },
          installSupported: updateScenario !== "unsupported",
          update: { phase, ...(updateOperationId ? { operationId: updateOperationId, targetVersion: "0.0.2" } : {}), ...(phase === "failed" ? { errorCode: "invalid_manifest" } : {}), updatedAt: now },
          running: [...runningSessionIds],
          checkedAt: now,
        };
      }
      throw new Error(`Unmocked remote request: ${method} ${path}`);
    }

    const bridge = {
      async invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
        calls.push({ command, args: clone(args) });
        if (command.startsWith("desktop_update_") && Object.keys(args).length > 0) throw new Error("Desktop updater commands must not accept arguments");
        if (command === "desktop_update_status") return clone(desktopUpdateState);
        if (command === "desktop_update_check") {
          setDesktopUpdate({ ...desktopUpdateState, phase: "checking", errorCode: undefined, errorMessage: undefined });
          await new Promise((resolve) => setTimeout(resolve, 35));
          return desktopUpdateScenario === "none"
            ? setDesktopUpdate({ phase: "upToDate", currentVersion: "0.0.1", checkedAt: Date.now() })
            : setDesktopUpdate({ phase: "available", currentVersion: "0.0.1", availableVersion: "0.0.2", checkedAt: Date.now() });
        }
        if (command === "desktop_update_install") {
          if (!desktopUpdateState.availableVersion) throw new Error("No checked desktop update");
          const generation = ++desktopUpdateInstallGeneration;
          setDesktopUpdate({ ...desktopUpdateState, phase: "downloading", downloadedBytes: 40, totalBytes: 100 });
          await new Promise((resolve) => setTimeout(resolve, 60));
          if (generation !== desktopUpdateInstallGeneration) return clone(desktopUpdateState);
          setDesktopUpdate({ ...desktopUpdateState, phase: "verifying", downloadedBytes: 100, totalBytes: 100 });
          await new Promise((resolve) => setTimeout(resolve, 40));
          if (generation !== desktopUpdateInstallGeneration) return clone(desktopUpdateState);
          if (desktopUpdateScenario === "signature-failure") return setDesktopUpdate({
            ...desktopUpdateState,
            phase: "failed",
            errorCode: "signatureVerificationFailed",
            errorMessage: "更新包签名校验失败，安装已中止。",
          });
          setDesktopUpdate({ ...desktopUpdateState, phase: "installing" });
          await new Promise((resolve) => setTimeout(resolve, 40));
          if (generation !== desktopUpdateInstallGeneration) return clone(desktopUpdateState);
          return setDesktopUpdate({ ...desktopUpdateState, phase: "readyToRestart" });
        }
        if (command === "desktop_update_cancel") {
          if (desktopUpdateState.phase !== "downloading") throw new Error("No cancellable desktop update download");
          desktopUpdateInstallGeneration += 1;
          return setDesktopUpdate({
            ...desktopUpdateState,
            phase: "failed",
            errorCode: "updateCancelled",
            errorMessage: "更新下载已取消，可重新尝试。",
          });
        }
        if (command === "desktop_update_restart") {
          if (desktopUpdateState.phase !== "readyToRestart") throw new Error("Restart requires a successfully installed update");
          return setDesktopUpdate({ ...desktopUpdateState, phase: "restarting" });
        }
        if (command === "list_devices") return clone(devices);
        if (command === "import_legacy_device_metadata") {
          const imported = {
            id: "legacy-delta",
            name: "Legacy Linux",
            host: "legacy.tailnet.ts.net",
            url: "https://legacy.tailnet.ts.net:30141",
            source: "manual",
            favorite: false,
            accent: "#55c7a5",
            os: "linux",
          };
          if (!devices.some((device) => device.id === imported.id)) devices.push(imported);
          return {
            devices: clone(devices),
            imported: 1,
            skipped: 0,
            backup: "devices.before-legacy-import-test.json",
            credentialsMigrated: false,
          };
        }
        if (command === "save_device") {
          const device = clone(args.device as typeof devices[number]);
          const index = devices.findIndex((item) => item.id === device.id);
          if (index >= 0) devices[index] = device; else devices.push(device);
          return clone(devices);
        }
        if (command === "remove_device") {
          const index = devices.findIndex((item) => item.id === args.id);
          if (index >= 0) devices.splice(index, 1);
          return clone(devices);
        }
        if (command === "discover_tailscale") return {
          available: true,
          tailnet: "example.ts.net",
          peers: devices.map((device) => ({
            ...device,
            dnsName: device.host,
            ip: ["100", "64", "0", device.os === "windows" ? "13" : device.os === "linux" ? "12" : "11"].join("."),
            online: true,
            isSelf: false,
            piWeb: false,
            requiresAuth: false,
          })),
        };
        if (command === "credential_status") {
          const url = String(args.url ?? "");
          return credentials.has(url) ? { paired: true, deviceId: "dev_mock_studio" } : { paired: false };
        }
        if (command === "pair_device") {
          pairingAttempts += 1;
          await new Promise((resolve) => setTimeout(resolve, 40));
          if (pairingFailure === "invalid-once" && pairingAttempts === 1) throw new Error("HTTP 401: pairing code is invalid or expired");
          if (pairingFailure === "network-once" && pairingAttempts === 1) throw new Error("network timeout while connecting to device");
          if (pairingFailure === "rate-limit") throw new Error("HTTP 429: too many pairing attempts");
          const url = String(args.url ?? "");
          const code = String(args.code ?? "");
          if (!/^pihub-[A-Za-z0-9_-]{43}$/.test(code)) throw new Error("HTTP 400: invalid pairing code");
          credentials.add(url);
          return { paired: true, deviceId: "dev_mock_office" };
        }
        if (command === "forget_device_credential") {
          credentials.delete(String(args.url ?? ""));
          return { paired: false };
        }
        if (command === "probe_device") {
          const url = String(args.url ?? "");
          await new Promise((resolve) => setTimeout(resolve, url.includes("new-node") ? 80 : 10));
          if (url.includes("build.")) return { state: "offline", error: "连接超时" };
          if (!credentials.has(url) && !url.includes("new-node")) return { state: "auth", error: "需要本机配对" };
          return { state: "online", latencyMs: url.includes("new-node") ? 24 : 12, version: "0.0.1" };
        }
        if (command === "agegr_request") return agegrRequest(args);
        if (command === "start_agent_stream") return ++streamGeneration;
        if (command === "stop_agent_stream" || command === "open_device") return undefined;
        if (command === "upload_remote_files") {
          const directory = remoteFilePath(String(args.path ?? ""));
          const payload = Array.isArray(args.files) ? args.files as Array<{ name?: unknown; data?: unknown }> : [];
          const uploaded: string[] = [];
          for (const item of payload) {
            const name = String(item.name ?? "");
            const binary = atob(String(item.data ?? ""));
            files.set(normalizePath(`${directory}/${name}`), { content: binary, language: "text" });
            uploaded.push(name);
          }
          return { uploaded, skipped: [], errors: [] };
        }
        if (command === "download_remote_file") return { path: `/Users/example/Downloads/${String(args.name ?? "download.bin")}` };
        if (command === "bootstrap_tailnet_peer") return { success: true, output: "已安装签名版 PiHub Server", installed: true, requiresApproval: false };
        if (command === "open_tailscale_approval") return undefined;
        if (command === "bundled_versions") return { pihubServer: "0.0.1", app: "0.0.1" };
        throw new Error(`Unmocked desktop command: ${command}`);
      },
      async listen(event: string, callback: (payload: unknown) => void): Promise<() => void> {
        const callbacks = listeners.get(event) ?? new Set();
        callbacks.add(callback);
        listeners.set(event, callbacks);
        return () => callbacks.delete(callback);
      },
      window: {
        async isFullscreen() { return false; },
        async onResized() { return () => undefined; },
        async startDragging() { calls.push({ command: "window:startDragging" }); },
      },
    };

    Object.defineProperty(window, "__PIHUB_DESKTOP_BRIDGE__", { value: bridge, configurable: true });
    Object.defineProperty(window, "__PIHUB_TEST__", {
      value: {
        calls,
        devices,
        sessions,
        details,
        emit,
        listenerCount(event: string) { return listeners.get(event)?.size ?? 0; },
        setNetwork(online: boolean) { remoteOnline = online; },
        snapshot() {
          return {
            files: [...files.entries()],
            directories: [...directories],
            modelsConfig: clone(modelsConfig),
            newApiConfig: clone(newApiConfig),
            runningSessionIds: [...runningSessionIds],
            worktrees: clone(worktrees),
            projectTrust: clone(projectTrust),
            skills: clone(skills),
            plugins: clone(plugins),
          };
        },
      },
      configurable: true,
    });
  }, options);
}

export async function desktopCalls(page: Page): Promise<Array<{ command: string; args?: Record<string, unknown> }>> {
  return page.evaluate(() => (window as unknown as { __PIHUB_TEST__: { calls: Array<{ command: string; args?: Record<string, unknown> }> } }).__PIHUB_TEST__.calls);
}

export async function emitDesktopEvent(page: Page, event: string, payload: unknown): Promise<void> {
  await page.evaluate(({ eventName, value }) => {
    (window as unknown as { __PIHUB_TEST__: { emit: (name: string, payload: unknown) => void } }).__PIHUB_TEST__.emit(eventName, value);
  }, { eventName: event, value: payload });
}

export async function desktopListenerCount(page: Page, event: string): Promise<number> {
  return page.evaluate((eventName) => {
    return (window as unknown as { __PIHUB_TEST__: { listenerCount: (name: string) => number } }).__PIHUB_TEST__.listenerCount(eventName);
  }, event);
}

export async function setDesktopNetwork(page: Page, online: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __PIHUB_TEST__: { setNetwork: (next: boolean) => void } }).__PIHUB_TEST__.setNetwork(value);
  }, online);
}

export interface DesktopMockSnapshot {
  files: Array<[string, { content: string; language: string }]>;
  directories: string[];
  modelsConfig: Record<string, unknown>;
  newApiConfig: { providers: Array<{ name: string; baseUrl: string; authenticated: boolean; overrideCount: number }>; settings: { sendSessionAffinityHeaders: boolean } };
  runningSessionIds: string[];
  worktrees: Array<{ path: string; branch: string; isMain: boolean }>;
  projectTrust: { requiresTrust: boolean; trusted: boolean };
  skills: Array<{ name: string; filePath: string; disableModelInvocation: boolean }>;
  plugins: Array<{ id: string; scope: "global" | "project"; disabled: boolean }>;
}

export async function desktopSnapshot(page: Page): Promise<DesktopMockSnapshot> {
  return page.evaluate(() => (window as unknown as { __PIHUB_TEST__: { snapshot: () => DesktopMockSnapshot } }).__PIHUB_TEST__.snapshot());
}

export async function seedLegacySessionCache(page: Page): Promise<void> {
  await page.evaluate(async () => {
    localStorage.setItem("pihub-session-cache-enabled", "1");
    localStorage.setItem("pihub-collapsed:/private/project", "1");
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("pihub-session-cache", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("sessions")) request.result.createObjectStore("sessions");
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("sessions", "readwrite");
        transaction.objectStore("sessions").put({ privateBody: "legacy-secret-body" }, "alpha:session-1");
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      };
    });
  });
}

export async function legacySessionCacheExists(page: Page): Promise<boolean> {
  return page.evaluate(async () => (await indexedDB.databases()).some((database) => database.name === "pihub-session-cache"));
}
