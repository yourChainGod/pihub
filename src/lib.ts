import type { AttachedImage, Device, DeviceCredentialStatus, DeviceStatus, NewRemoteSession, RemoteAgentEventPayload, RemoteAgentState, RemoteDirectoryBrowse, RemoteDirectoryListing, RemoteFilePreview, RemoteGitDiff, RemoteGitStatus, RemoteModelsResponse, RemoteNewApiConfig, RemotePermissionRule, RemotePermissionsResponse, RemotePluginPackageInfo, RemotePluginsResponse, RemoteProjectTrustStatus, RemoteServerUpdateAccepted, RemoteSession, RemoteSetupStatus, RemoteSkillInfo, RemoteSkillsResponse, RemoteSubagentsResponse, RemoteTerminalEventPayload, RemoteTodosResponse, RemoteUpdates, RemoteWorktrees, SessionDetail, TailnetScan, RemoteComponents, RemoteComponentUpdateAccepted } from "./types.ts";
import { invokeDesktop, isDesktopEnvironment, listenDesktopEvent } from "./desktopTransport.ts";

const inTauri = isDesktopEnvironment;

export function isTauriEnvironment(): boolean { return inTauri(); }

export async function listDevices(): Promise<Device[]> {
  if (inTauri()) return invokeDesktop("list_devices");
  const raw = localStorage.getItem("pihub-devices");
  return raw ? JSON.parse(raw) : [];
}

export interface LegacyDeviceImportResult {
  devices: Device[];
  imported: number;
  skipped: number;
  backup?: string;
  credentialsMigrated: false;
}

export async function importLegacyDeviceMetadata(): Promise<LegacyDeviceImportResult> {
  if (!inTauri()) throw new Error("旧版设备导入仅在 PiHub Desktop 中可用");
  const result = await invokeDesktop<LegacyDeviceImportResult>("import_legacy_device_metadata");
  if (result.credentialsMigrated !== false) throw new Error("旧版导入返回了不安全的凭据迁移状态");
  return result;
}

export async function saveDevice(device: Device): Promise<Device[]> {
  if (inTauri()) return invokeDesktop("save_device", { device });
  const current = await listDevices();
  const next = [...current.filter((item) => item.id !== device.id), device];
  localStorage.setItem("pihub-devices", JSON.stringify(next));
  return next;
}

export async function removeDevice(id: string): Promise<Device[]> {
  if (inTauri()) return invokeDesktop("remove_device", { id });
  const next = (await listDevices()).filter((item) => item.id !== id);
  localStorage.setItem("pihub-devices", JSON.stringify(next));
  return next;
}

export async function scanTailnet(port?: number, probeServices = true): Promise<TailnetScan> {
  if (inTauri()) return invokeDesktop("discover_tailscale", { port, probeServices });
  await new Promise((resolve) => setTimeout(resolve, 900));
  return { available: false, peers: [], message: "请在 Tauri 应用中使用 Tailscale 自动发现" };
}

export interface BootstrapResult { success: boolean; output: string; installed: boolean; requiresApproval: boolean; approvalUrl?: string }

export const DEFAULT_BOOTSTRAP_EXTENSIONS = Object.freeze([
  Object.freeze({ name: "@cortexkit/pi-magic-context", version: "0.38.0", label: "Magic Context", description: "持久上下文与压缩记忆（todowrite 已关闭）" }),
  Object.freeze({ name: "pi-todo-rail", version: "0.2.3", label: "Todo Rail", description: "项目待办栏与会话内任务状态" }),
  Object.freeze({ name: "@ff-labs/pi-fff", version: "0.10.5", label: "FFF 搜索", description: "快速文件搜索工具" }),
  Object.freeze({ name: "pi-simplify", version: "0.2.3", label: "Simplify", description: "简化常用 Pi 工作流" }),
  Object.freeze({ name: "@gotgenes/pi-permission-system", version: "26.3.0", label: "权限系统", description: "命令与路径权限审查" }),
  Object.freeze({ name: "@eko24ive/pi-ask", version: "1.2.0", label: "Ask User", description: "交互式确认与提问" }),
  Object.freeze({ name: "@gotgenes/pi-subagents", version: "19.3.2", label: "Subagents", description: "受控子代理工具" }),
] as const);

export async function bootstrapTailnetPeer(host: string, os?: string, username?: string, installDefaultExtensions = true, selectedExtensions?: string[], options: { localArchiveDir?: string; autoPair?: boolean } = {}): Promise<BootstrapResult> {
  if (!inTauri()) throw new Error("请在 PiHub 客户端中使用 SSH 配置");
  return invokeDesktop("bootstrap_tailnet_peer", { host, os, username, installDefaultExtensions, selectedExtensions, localArchiveDir: options.localArchiveDir || undefined, autoPair: options.autoPair === true });
}

/** Extracts the one-time auto-pairing code from bootstrap output, if present. */
export function bootstrapPairingCode(output: string): string | null {
  const match = /(?:^|\n)PIHUB_PAIRING_CODE=(pihub-[A-Za-z0-9_-]{43})(?=\n|$)/.exec(output);
  return match ? match[1] : null;
}

/** Removes pairing-code marker lines so secrets never reach the UI or logs. */
export function scrubBootstrapSecrets(text: string): string {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("PIHUB_PAIRING_CODE=")).join("\n");
}

/** Subscribes to live remote-script output during SSH bootstrap. Returns an unsubscribe function. */
export async function onBootstrapLog(callback: (line: string, stream: string) => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  return listenDesktopEvent<{ line: string; stream: string }>("pihub-bootstrap-log", (payload) => callback(payload.line, payload.stream));
}

export async function openTailscaleApproval(url: string): Promise<void> {
  if (!inTauri()) { window.open(url, "_blank", "noopener,noreferrer"); return; }
  return invokeDesktop("open_tailscale_approval", { url });
}

export async function probe(url: string): Promise<DeviceStatus> {
  if (inTauri()) return invokeDesktop("probe_device", { url });
  return { state: "offline", error: "浏览器预览无法跨域检测" };
}

export function normalizePairingCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return `pihub-${trimmed.replace(/^pihub-/i, "")}`;
}

export function isValidPairingCode(value: string): boolean {
  return /^pihub-[A-Za-z0-9_-]{43}$/.test(normalizePairingCode(value));
}

export async function pairDevice(url: string, code: string): Promise<DeviceCredentialStatus & { paired: true }> {
  if (!inTauri()) throw new Error("请在 PiHub 桌面客户端中完成配对");
  const result = await invokeDesktop<DeviceCredentialStatus>("pair_device", { url, code: normalizePairingCode(code) });
  if (!result.paired || typeof result.deviceId !== "string" || !result.deviceId) throw new Error("设备返回了无效的配对结果");
  return { paired: true, deviceId: result.deviceId };
}

export async function credentialStatus(url: string): Promise<DeviceCredentialStatus> {
  if (!inTauri()) return { paired: false };
  const result = await invokeDesktop<DeviceCredentialStatus>("credential_status", { url });
  return result.paired && typeof result.deviceId === "string" && result.deviceId
    ? { paired: true, deviceId: result.deviceId }
    : { paired: false };
}

export async function forgetDeviceCredential(url: string): Promise<DeviceCredentialStatus & { paired: false }> {
  if (!inTauri()) return { paired: false };
  await invokeDesktop("forget_device_credential", { url });
  return { paired: false };
}

export async function openDevice(device: Device): Promise<void> {
  if (inTauri()) return invokeDesktop("open_device", { device });
  window.open(device.url, "_blank", "noopener,noreferrer");
}

async function remote<T>(device: Device, path: string, method = "GET", body?: unknown): Promise<T> {
  if (inTauri()) return invokeDesktop("agegr_request", { url: device.url, path, method, body });
  const response = await fetch(`${device.url}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

export async function loadRemoteSessions(device: Device): Promise<{ sessions: RemoteSession[]; runningSessionIds: string[] }> {
  return remote(device, "/api/sessions");
}

export async function loadRemoteSession(device: Device, sessionId: string, limit = 40, after?: string, before?: string): Promise<SessionDetail> {
  const cursor = after ? `&after=${encodeURIComponent(after)}` : before ? `&before=${encodeURIComponent(before)}` : "";
  return remote(device, `/api/sessions/${encodeURIComponent(sessionId)}?deferThinking=1&deferMedia=1&desktop=1&limit=${limit}${cursor}`);
}

export async function sendRemotePrompt(device: Device, sessionId: string, message: string, images?: AttachedImage[]): Promise<void> {
  await remote(device, `/api/agent/${encodeURIComponent(sessionId)}`, "POST", {
    type: "prompt", message,
    ...(images?.length ? { images: images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })) } : {}),
  });
}

export async function steerRemotePrompt(device: Device, sessionId: string, message: string, images?: AttachedImage[]): Promise<void> {
  await remote(device, `/api/agent/${encodeURIComponent(sessionId)}`, "POST", {
    type: "steer", message,
    ...(images?.length ? { images: images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })) } : {}),
  });
}

export async function loadRemoteAgentState(device: Device, sessionId: string): Promise<RemoteAgentState> {
  return remote(device, `/api/agent/${encodeURIComponent(sessionId)}`);
}

export async function loadRemoteThinking(device: Device, sessionId: string, entryId: string, blockIndex: number): Promise<string> {
  const result = await remote<{ thinking?: unknown }>(device, `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`);
  if (typeof result.thinking !== "string") throw new Error("思考内容不可用");
  return result.thinking;
}

export async function renameRemoteSession(device: Device, sessionId: string, name: string): Promise<void> {
  await remote(device, `/api/sessions/${encodeURIComponent(sessionId)}`, "PATCH", { name });
}

export async function deleteRemoteSession(device: Device, sessionId: string): Promise<void> {
  await remote(device, `/api/sessions/${encodeURIComponent(sessionId)}`, "DELETE");
}

export async function autoNameRemoteSession(device: Device, sessionId: string): Promise<{ title: string }> {
  return remote(device, `/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, "POST");
}

export async function compactRemoteSession(device: Device, sessionId: string, customInstructions?: string): Promise<unknown> {
  return remote(device, `/api/agent/${encodeURIComponent(sessionId)}`, "POST", { type: "compact", ...(customInstructions ? { customInstructions } : {}) });
}

export async function abortRemoteCompaction(device: Device, sessionId: string): Promise<void> {
  await remote(device, `/api/agent/${encodeURIComponent(sessionId)}`, "POST", { type: "abort_compaction" });
}

export async function forkRemoteSession(device: Device, sessionId: string, entryId: string): Promise<{ cancelled?: boolean; newSessionId?: string }> {
  const envelope = await remote<{ success: boolean; data: { cancelled?: boolean; newSessionId?: string } }>(device, `/api/agent/${encodeURIComponent(sessionId)}`, "POST", { type: "fork", entryId });
  return envelope?.data ?? {};
}

export async function navigateRemoteTree(device: Device, sessionId: string, targetId: string): Promise<void> {
  await remote(device, `/api/agent/${encodeURIComponent(sessionId)}`, "POST", { type: "navigate_tree", targetId });
}

export async function exportRemoteSession(device: Device, sessionId: string, name: string): Promise<string> {
  if (!inTauri()) { window.open(`${device.url}/api/sessions/${encodeURIComponent(sessionId)}/export`, "_blank", "noopener,noreferrer"); return ""; }
  const result = await invokeDesktop<{ path: string }>("export_session_html", { url: device.url, sessionId, name });
  return result.path;
}

export async function sendRemoteAgentCommand(device: Device, sessionId: string, command: Record<string, unknown>): Promise<unknown> {
  return remote(device, `/api/agent/${encodeURIComponent(sessionId)}`, "POST", command);
}

export function remoteAgentStreamKey(device: Pick<Device, "id" | "url">, sessionId: string): string {
  return JSON.stringify([device.id, new URL(device.url).origin, sessionId]);
}

export function remoteAgentEventMatchesDevice(payload: RemoteAgentEventPayload, device: Pick<Device, "id" | "url">): boolean {
  return payload.deviceId === device.id && payload.deviceOrigin === new URL(device.url).origin;
}

export async function startRemoteAgentStream(device: Device, sessionId: string): Promise<number> {
  if (!inTauri()) throw new Error("实时会话仅支持 PiHub 桌面客户端");
  return invokeDesktop<number>("start_agent_stream", { url: device.url, deviceId: device.id, sessionId });
}

export async function stopRemoteAgentStream(device: Device, sessionId: string): Promise<void> {
  if (inTauri()) await invokeDesktop("stop_agent_stream", { url: device.url, deviceId: device.id, sessionId });
}

export function remoteTerminalEventMatchesDevice(payload: RemoteTerminalEventPayload, device: Pick<Device, "id" | "url">): boolean {
  return payload.deviceId === device.id && payload.deviceOrigin === new URL(device.url).origin;
}

export async function startRemoteTerminalStream(device: Device, terminalId: string): Promise<number> {
  if (!inTauri()) throw new Error("实时终端仅支持 PiHub 桌面客户端");
  return invokeDesktop<number>("start_terminal_stream", { url: device.url, deviceId: device.id, terminalId });
}

export async function stopRemoteTerminalStream(device: Device, terminalId: string): Promise<void> {
  if (inTauri()) await invokeDesktop("stop_terminal_stream", { url: device.url, deviceId: device.id, terminalId });
}

export async function loadRemoteModels(device: Device, cwd: string): Promise<RemoteModelsResponse> {
  return remote(device, `/api/models?cwd=${encodeURIComponent(cwd)}`);
}

export async function loadRemoteModelsConfig(device: Device): Promise<Record<string, unknown>> {
  return remote(device, "/api/models-config");
}

export async function saveRemoteModelsConfig(device: Device, config: Record<string, unknown>): Promise<void> {
  await remote(device, "/api/models-config", "PUT", config);
}

export async function loadRemoteNewApi(device: Device): Promise<RemoteNewApiConfig> {
  return remote(device, "/api/pihub/newapi");
}

export async function saveRemoteNewApiProvider(device: Device, data: { name: string; baseUrl: string; apiKey?: string; sendSessionAffinityHeaders: boolean }): Promise<RemoteNewApiConfig> {
  return remote(device, "/api/pihub/newapi", "POST", { action: "save", ...data });
}

export async function refreshRemoteNewApiProvider(device: Device, name: string, cwd: string): Promise<RemoteNewApiConfig> {
  return remote(device, "/api/pihub/newapi", "POST", { action: "refresh", name, cwd });
}

export async function deleteRemoteNewApiProvider(device: Device, name: string): Promise<RemoteNewApiConfig> {
  return remote(device, "/api/pihub/newapi", "POST", { action: "delete", name });
}

export async function stopRemoteAgent(device: Device, sessionId: string): Promise<void> {
  await remote(device, `/api/agent/${encodeURIComponent(sessionId)}`, "POST", { type: "abort" });
}

export async function loadRemoteRunning(device: Device): Promise<string[]> {
  const result = await remote<{ runningSessionIds: string[] }>(device, "/api/agent/running");
  return result.runningSessionIds;
}

export async function loadRemoteFiles(device: Device, cwd: string): Promise<string[]> {
  const result = await remote<{ files: string[] }>(device, `/api/file-index?cwd=${encodeURIComponent(cwd)}`);
  return result.files;
}

/** Server-side fuzzy file search — used for @ mentions when the cached index is missing or truncated. */
export async function loadRemoteFileMatches(device: Device, cwd: string, q: string): Promise<string[]> {
  const result = await remote<{ files: string[] }>(device, `/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`);
  return result.files;
}

export async function loadRemoteGit(device: Device, cwd: string): Promise<RemoteGitStatus> {
  return remote(device, `/api/git/status?cwd=${encodeURIComponent(cwd)}`);
}

export async function loadRemoteGitDiff(device: Device, cwd: string, filePath: string): Promise<RemoteGitDiff> {
  return remote(device, `/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`);
}

export async function loadRemoteWorktrees(device: Device, cwd: string): Promise<RemoteWorktrees> {
  return remote(device, `/api/worktrees?cwd=${encodeURIComponent(cwd)}`);
}

export async function loadRemoteProjectTrust(device: Device, cwd: string): Promise<RemoteProjectTrustStatus> {
  return remote(device, `/api/project-trust?cwd=${encodeURIComponent(cwd)}`);
}

export async function trustRemoteProject(device: Device, cwd: string): Promise<RemoteProjectTrustStatus> {
  return remote(device, "/api/project-trust", "POST", { cwd });
}

export async function loadRemoteSkills(device: Device, cwd: string): Promise<RemoteSkillsResponse> {
  return remote(device, `/api/skills?cwd=${encodeURIComponent(cwd)}`);
}

export async function setRemoteSkillEnabled(device: Device, skill: Pick<RemoteSkillInfo, "filePath">, enabled: boolean): Promise<void> {
  await remote(device, "/api/skills", "PATCH", {
    filePath: skill.filePath,
    disableModelInvocation: !enabled,
  });
}

export async function loadRemotePlugins(device: Device, cwd: string): Promise<RemotePluginsResponse> {
  return remote(device, `/api/plugins?cwd=${encodeURIComponent(cwd)}`);
}

export async function setRemotePluginEnabled(device: Device, cwd: string, plugin: Pick<RemotePluginPackageInfo, "id" | "scope">, enabled: boolean): Promise<RemotePluginsResponse> {
  return remote(device, "/api/plugins", "POST", {
    action: enabled ? "enable" : "disable",
    packageId: plugin.id,
    scope: plugin.scope,
    cwd,
  });
}

export async function createRemoteWorktree(device: Device, cwd: string, branch: string): Promise<{ path: string; branch: string }> {
  return remote(device, "/api/worktrees", "POST", { cwd, branch });
}

export async function deleteRemoteWorktree(device: Device, cwd: string, path: string, force = false): Promise<void> {
  await remote(device, "/api/worktrees", "DELETE", { cwd, path, force });
}

export async function loadRemoteFile(device: Device, cwd: string, relativePath: string, sessionId: string): Promise<RemoteFilePreview> {
  const absolutePath = `${cwd.replace(/[\\/]$/, "")}/${relativePath}`.replaceAll("\\", "/");
  const routePath = absolutePath.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return remote(device, `/api/files/${routePath}?type=read&sessionId=${encodeURIComponent(sessionId)}`);
}

function encodedRemotePath(absolutePath: string): string { return absolutePath.replaceAll("\\", "/").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/"); }

export async function loadRemoteDirectory(device: Device, absolutePath: string, sessionId: string): Promise<RemoteDirectoryListing> {
  return remote(device, `/api/files/${encodedRemotePath(absolutePath)}?type=list&sessionId=${encodeURIComponent(sessionId)}`);
}

export async function loadRemoteAbsoluteFile(device: Device, absolutePath: string, sessionId: string): Promise<RemoteFilePreview> {
  return remote(device, `/api/files/${encodedRemotePath(absolutePath)}?type=read&sessionId=${encodeURIComponent(sessionId)}`);
}

/** Streams a remote file into ~/Downloads as raw bytes (binary-safe). Returns the local path. */
export async function downloadRemoteFile(device: Device, absolutePath: string, sessionId: string): Promise<string> {
  const name = absolutePath.split(/[\\/]/).pop() || "download.bin";
  const downloadPath = `/api/files/${encodedRemotePath(absolutePath)}?type=download&sessionId=${encodeURIComponent(sessionId)}`;
  if (!inTauri()) {
    const link = document.createElement("a");
    link.href = `${device.url}${downloadPath}`;
    link.download = name;
    link.click();
    return name;
  }
  const result = await invokeDesktop<{ path: string }>("download_remote_file", { url: device.url, path: downloadPath, name });
  return result.path;
}

export interface RemoteUploadResult { uploaded?: string[]; skipped?: string[]; errors?: Array<{ name: string; error: string }> }

/** Pre-flight conflict check, same contract as the web FileExplorer. */
export async function uploadRemoteCheck(device: Device, directory: string, fileNames: string[]): Promise<{ conflicts: string[]; nonReplaceable: string[] }> {
  return remote(device, `/api/files/${encodedRemotePath(directory)}?type=upload-check`, "POST", { fileNames });
}

function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary);
  });
}

/** Tauri uploads stage 8MB slices via IPC so no single message carries a whole (base64-inflated) file. */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Uploads files into a remote directory. Tauri: chunked base64 → Rust multipart (binary-safe); browser: native FormData. */
export async function uploadRemoteFiles(device: Device, directory: string, files: File[], conflict: "error" | "overwrite" | "skip"): Promise<RemoteUploadResult> {
  const path = `/api/files/${encodedRemotePath(directory)}?type=upload&conflict=${conflict}`;
  if (inTauri()) {
    const uploadId = crypto.randomUUID();
    try {
      for (const file of files) {
        const chunks = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES));
        for (let index = 0; index < chunks; index += 1) {
          const data = await blobToBase64(file.slice(index * UPLOAD_CHUNK_BYTES, (index + 1) * UPLOAD_CHUNK_BYTES));
          await invokeDesktop("upload_remote_chunk", { url: device.url, uploadId, name: file.name, index, data });
        }
      }
      return await invokeDesktop("upload_remote_commit", { url: device.url, path, uploadId, names: files.map((file) => file.name) });
    } catch (error) {
      await invokeDesktop("upload_remote_abort", { uploadId }).catch(() => undefined);
      throw error;
    }
  }
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  const response = await fetch(`${device.url}${path}`, { method: "POST", body: form });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((value as { error?: string }).error || `HTTP ${response.status}`);
  return value as RemoteUploadResult;
}

export async function createRemoteSession(device: Device, cwd: string): Promise<NewRemoteSession> {
  return remote(device, "/api/agent/new", "POST", { cwd, type: "ensure_session" });
}

export async function browseRemoteDirectories(device: Device, path?: string): Promise<RemoteDirectoryBrowse> {
  return remote(device, `/api/cwd/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);
}

export async function validateRemoteDirectory(device: Device, cwd: string): Promise<{ cwd: string }> {
  return remote(device, "/api/cwd/validate", "POST", { cwd });
}

export async function remoteFileAction(device: Device, action: "mkdir" | "touch" | "write" | "rename" | "move" | "delete", path: string, options: { name?: string; content?: string; destination?: string } = {}): Promise<void> {
  await remote(device, "/api/pihub/files", "POST", { action, path, ...options });
}

export async function createRemoteTerminal(device: Device, cwd: string): Promise<{ id: string; cwd: string }> {
  return remote(device, "/api/pihub/terminal", "POST", { action: "create", cwd });
}
export async function writeRemoteTerminal(device: Device, id: string, data: string): Promise<void> { await remote(device, "/api/pihub/terminal", "POST", { action: "input", id, data }); }
export async function resizeRemoteTerminal(device: Device, id: string, cols: number, rows: number): Promise<void> { await remote(device, "/api/pihub/terminal", "POST", { action: "resize", id, data: `${cols}x${rows}` }); }
export async function closeRemoteTerminal(device: Device, id: string): Promise<void> { await remote(device, "/api/pihub/terminal", "POST", { action: "close", id }); }
export async function readRemoteTerminal(device: Device, id: string, offset: number): Promise<{ chunk: string; cursor: number; reset: boolean }> { return remote(device, `/api/pihub/terminal?id=${encodeURIComponent(id)}&offset=${offset}`); }
export async function loadRemoteSetup(device: Device): Promise<RemoteSetupStatus> { return remote(device, "/api/pihub/setup"); }

/** The shared local release directory setting ("连接设置" → 本地发布包目录). */
// Self-use build: default to this machine's release-artifacts so the updates
// panel works out of the box; the settings field still overrides it.
export const DEFAULT_LOCAL_RELEASE_DIR = "/Users/zhangshijie/Documents/Project/pihub/release-artifacts";
export function localReleaseDirectory(): string {
  return (localStorage.getItem("pihub-local-release-dir") ?? "").trim() || DEFAULT_LOCAL_RELEASE_DIR;
}

export interface LocalComponentVersion {
  name: string;
  version: string;
}

export interface LocalServerUpdate {
  latest: string;
  archiveName: string;
  updateAvailable: boolean;
  /** Component versions bundled in the selected archive (asset.json or compiled-in pins). */
  pi: LocalComponentVersion;
  extensions: LocalComponentVersion[];
}

/** Detects the newest local release asset for a platform; purely local, never touches GitHub. */
export async function checkLocalServerUpdate(directory: string, platform: string, currentVersion?: string | null): Promise<LocalServerUpdate> {
  if (!inTauri()) throw new Error("本地发布包检测仅在 PiHub 桌面客户端中可用");
  return invokeDesktop("check_local_server_update", { directory, platform, currentVersion: currentVersion || undefined });
}

export async function loadRemoteUpdates(device: Device): Promise<RemoteUpdates> {
  return remote(device, "/api/pihub/updates");
}

export class BusyUpdateError extends Error {
  running: string[];
  constructor(message: string, running: string[]) { super(message); this.running = running; }
}

export async function applyRemoteServerUpdate(device: Device, force = false): Promise<RemoteServerUpdateAccepted> {
  try {
    return await remote(device, "/api/pihub/updates", "POST", { action: "apply", ...(force ? { force: true } : {}) });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/busy|concurrent[_ ]update|sessions? (?:are )?still running|正在运行/i.test(message)) throw new BusyUpdateError(message, []);
    throw cause;
  }
}

/** Reads per-layer component versions (Server / Pi / extensions) from the device. */
export async function loadRemoteComponents(device: Device): Promise<RemoteComponents> {
  return remote(device, "/api/pihub/components");
}

/**
 * Queues a Pi Agent or extension update on the device.
 *
 * Running agent sessions make the server answer 409 `busy` unless `force` is
 * set, matching the server-update contract; callers surface a confirmation and
 * retry with force so the operator decides whether to interrupt the sessions.
 */
export async function applyRemoteComponentUpdate(
  device: Device,
  component: "pi" | "extensions",
  options: { force?: boolean; target?: string } = {},
): Promise<RemoteComponentUpdateAccepted> {
  const { force = false, target } = options;
  try {
    return await remote(device, "/api/pihub/components", "POST", {
      component,
      action: "update",
      ...(target ? { target } : {}),
      ...(force ? { force: true } : {}),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/busy|concurrent[_ ]update|sessions? (?:are )?still running|正在运行/i.test(message)) {
      throw new BusyUpdateError(message, []);
    }
    throw cause;
  }
}

export async function bundledVersions(): Promise<{ pihubServer: string; app: string }> {
  if (inTauri()) return invokeDesktop("bundled_versions");
  return { pihubServer: "dev", app: "dev" };
}
export async function runRemoteSetup(device: Device, action: "tailscale-serve" | "tailscale-ssh-enable" | "provider-install"): Promise<{ success: boolean; output?: string; requiresApproval?: boolean; approvalUrl?: string }> { return remote(device, "/api/pihub/setup", "POST", { action }); }

export async function createRemoteFolderSession(device: Device, parentPath: string, folderName: string): Promise<NewRemoteSession & { cwd: string }> {
  const name = folderName.trim();
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) throw new Error("文件夹名称无效");
  const parent = (await validateRemoteDirectory(device, parentPath)).cwd;
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const cwd = `${parent.replace(/[\\/]$/, "")}${separator}${name}`;
  await remoteFileAction(device, "mkdir", parent, { name });
  await validateRemoteDirectory(device, cwd);
  return { ...(await createRemoteSession(device, cwd)), cwd };
}

export async function notifyDone(title: string, body: string): Promise<void> {
  if (!inTauri()) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch { /* notifications unavailable */ }
}

export function normalizeUrl(value: string): string {
  const withScheme = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  const parsed = new URL(withScheme);
  if (!parsed.port) parsed.port = "30141";
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = host.split(".").map(Number);
  const tailscaleIpv4 = ipv4.length === 4 && ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127;
  if (parsed.protocol !== "https:" || (!host.endsWith(".ts.net") && !tailscaleIpv4 && !host.startsWith("fd7a:115c:a1e0:"))) throw new Error("只允许 Tailscale MagicDNS 或 Tailscale IP 的 HTTPS 地址");
  return parsed.origin;
}

export function deviceId(value: string): string {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `device-${(hash >>> 0).toString(36)}`;
}

/**
 * Reads the pi-todo-rail list for a session. The list is parsed out of the
 * session transcript, so it always matches what the agent's own todo panel
 * shows — including per-branch state.
 */
export async function loadRemoteTodos(device: Device, sessionId: string): Promise<RemoteTodosResponse> {
  return remote(device, `/api/pihub/todos?sessionId=${encodeURIComponent(sessionId)}`);
}

export async function loadRemotePermissions(device: Device): Promise<RemotePermissionsResponse> {
  return remote(device, "/api/pihub/permissions");
}

export async function addRemotePermissionRule(
  device: Device,
  rule: RemotePermissionRule,
): Promise<RemotePermissionsResponse> {
  return remote(device, "/api/pihub/permissions", "POST", rule);
}

/** Removes a PiHub-owned rule. Rules with `pi-native` scope are read-only. */
export async function removeRemotePermissionRule(
  device: Device,
  pattern: string,
): Promise<RemotePermissionsResponse> {
  return remote(device, "/api/pihub/permissions", "DELETE", { pattern });
}

export async function loadRemoteSubagents(device: Device, sessionId: string): Promise<RemoteSubagentsResponse> {
  return remote(device, `/api/pihub/subagents?sessionId=${encodeURIComponent(sessionId)}`);
}
