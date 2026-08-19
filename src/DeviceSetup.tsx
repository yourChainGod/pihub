import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, CircleArrowUp, LoaderCircle, PackageCheck, RefreshCw, ShieldCheck, X } from "lucide-react";
import { PiHubProviderIcon, PiHubServeIcon, PiHubSshIcon, PiHubTailnetIcon } from "./PiHubIcons";
import { ConfirmDialog, useDialogFocus } from "./dialogs";
import { cancelDesktopUpdate, checkDesktopUpdate, desktopUpdatePercent, desktopUpdateStatus, installDesktopUpdate, onDesktopUpdate, restartAfterDesktopUpdate } from "./desktopUpdater";
import type { DesktopUpdateState } from "./desktopUpdater";
import { applyRemoteServerUpdate, BusyUpdateError, loadRemoteSetup, loadRemoteUpdates, openTailscaleApproval, runRemoteSetup } from "./lib";
import type { Device, RemoteServerUpdatePhase, RemoteSetupStatus, RemoteUpdates } from "./types";

type SetupAction = "tailscale-serve" | "tailscale-ssh-enable" | "provider-install";

export default function DeviceSetup({ device, onClose }: { device: Device; cwd?: string; onClose: () => void }) {
  const [tab, setTab] = useState<"components" | "updates">("components");
  const [status, setStatus] = useState<RemoteSetupStatus | null>(null);
  const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const [output, setOutput] = useState(""); const [approvalUrl, setApprovalUrl] = useState("");
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  const refresh = useCallback(async () => { setError(""); try { setStatus(await loadRemoteSetup(device)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }, [device]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function action(value: SetupAction) {
    setBusy(value); setError(""); setOutput(""); setApprovalUrl("");
    try {
      const result = await runRemoteSetup(device, value); setApprovalUrl(result.approvalUrl || "");
      setOutput(result.requiresApproval ? "Tailscale Serve 需要管理员授权。授权后点击刷新即可继续。" : result.output || "操作完成");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(""); }
  }
  const windows = status?.platform?.os === "win32"; const plan = status?.installPlan ?? [];
  const extensions = status?.defaultExtensions;
  return <div className="modal-backdrop setup-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialogRef} className="device-setup" role="dialog" aria-modal="true" aria-label={`${device.name} 设备中心`}>
    <header role="presentation"><div><h2>{device.name} · 设备中心</h2><p>组件状态、版本检查与一键更新。</p></div><button onClick={onClose} aria-label="关闭"><X size={16} /></button></header>
    <nav className="models-config-tabs"><button className={tab === "components" ? "active" : ""} onClick={() => setTab("components")}>组件与安全</button><button className={tab === "updates" ? "active" : ""} onClick={() => setTab("updates")}>版本更新</button></nav>
    {tab === "updates" ? <UpdatesPanel device={device} onServerUpdated={() => void refresh()} /> : !status && !error ? <div className="setup-loading"><LoaderCircle className="spin" />读取服务端状态…</div> : <div className="setup-content">
      <div className="setup-plan"><strong>{plan.length ? `待配置 ${plan.length} 项` : "核心组件已齐全"}</strong><span>{plan.length ? plan.join(" · ") : "远程访问与核心组件已就绪"}</span></div>
      <SetupRow icon={<PiHubServeIcon />} title="Tailscale Serve" description={status?.tailscale.serveUrl || status?.tailscale.dnsName || "将 127.0.0.1:30141 安全映射到 Tailnet HTTPS"} ok={status?.tailscale.serveEnabled} action="启用 Serve" busy={busy === "tailscale-serve"} onClick={() => void action("tailscale-serve")} />
      {windows ? <SetupRow icon={<PiHubSshIcon />} title="Windows OpenSSH" description={`官方 OpenSSH · ${status?.platform?.terminalBackend || "ConPTY"} · ${status?.platform?.preferredShell || "PowerShell"}`} ok={status?.platform?.openSshRunning} action="查看配置说明" busy={false} onClick={() => setOutput("Windows 首次启用 OpenSSH 需要本机管理员确认。请在 Windows 管理员 PowerShell 中运行 scripts/windows/Initialize-PiHubOpenSSH.ps1；PiHub 不会绕过 UAC，也不会保存密码。")} /> : <SetupRow icon={<PiHubSshIcon />} title="Tailscale SSH" description="通过 Tailnet ACL 管理 SSH，不开放 22 端口到公网" ok={status?.tailscale.sshEnabled} action="启用 SSH" busy={busy === "tailscale-ssh-enable"} onClick={() => void action("tailscale-ssh-enable")} />}
      <SetupRow icon={<PiHubProviderIcon />} title="NewAPI Provider" description="已由 PiHub Server 内置，无需单独安装插件" ok={true} action="已内置" busy={false} onClick={() => undefined} />
      <ReadOnlySetupRow icon={<PackageCheck size={17} />} title={`默认扩展 ${extensions?.installedCount ?? 0}/${extensions?.total ?? 5}`} description="由签名 Server 版本管理，随服务端更新，不执行在线安装" ok={extensions?.installed === true} label={extensions ? `${extensions.installedCount}/${extensions.total}` : "状态未知"} />
      <div className="security-proof"><PiHubTailnetIcon size={16} /><div><strong>Tailnet-only 已强制开启</strong><span>服务绑定 {status?.security.binding || "127.0.0.1"} · Funnel 不受支持 · 普通 LAN 与公网请求会被拒绝</span></div></div>
      {error && <div className="setup-error" role="alert">{error}</div>}{output && <pre className="setup-output">{output}</pre>}{approvalUrl && <button className="approval-button" onClick={() => void openTailscaleApproval(approvalUrl)}>打开 Tailscale 官方授权页</button>}
    </div>}
    {tab === "components" && <footer><button onClick={() => void refresh()} disabled={Boolean(busy)}><RefreshCw className={busy ? "spin" : ""} size={13} />刷新</button><button className="primary-setup" onClick={onClose}>完成</button></footer>}
  </section></div>;
}

const ACTIVE_UPDATE_PHASES = new Set<RemoteServerUpdatePhase>(["recovering", "queued", "applying", "restarting"]);
const UPDATE_ERROR_LABELS: Record<string, string> = {
  concurrent_update: "已有更新正在执行",
  downgrade_blocked: "已阻止版本降级",
  download_failed: "发布包下载失败",
  extraction_failed: "发布包解压失败",
  health_failed: "新版本健康检查失败",
  health_timeout: "新版本健康检查超时",
  integrity_failed: "发布包完整性校验失败",
  invalid_manifest: "发布清单无效",
  journal_corrupt: "更新恢复状态无效",
  no_compatible_asset: "没有匹配此设备的发布包",
  release_unavailable: "无法验证 GitHub 签名发布",
  recovery_failed: "更新恢复失败",
  rollback_failed: "版本回滚失败",
  storage_failure: "更新存储不可用",
  switch_failed: "版本切换失败",
  unsafe_archive: "发布包未通过安全检查",
  update_failed: "更新未完成",
  update_runtime_invalid: "稳定更新运行器状态无效",
  update_runtime_timeout: "稳定更新运行器响应超时",
  update_runtime_unavailable: "稳定更新运行器不可用",
  version_conflict: "发布版本与当前状态冲突",
};

function versionLabel(value: string | null | undefined): string {
  return value ? `v${value.replace(/^v/, "")}` : "未知";
}

function updateErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/signed public release|signature|release_unavailable/i.test(message)) return "无法验证 GitHub 签名发布，请稍后重试。";
  if (/stable update launcher|update_runtime/i.test(message)) return "此设备的稳定更新运行器暂不可用。";
  if (/PIHUB_AUTH_FORBIDDEN/.test(message)) return "当前设备没有安装系统更新的权限。";
  if (/PIHUB_AUTH_REQUIRED/.test(message)) return "设备配对已失效，请重新配对后再更新。";
  return "更新请求失败，请稍后重试。";
}

function updatePhaseCopy(updates: RemoteUpdates): { title: string; detail: string } | null {
  const state = updates.update;
  if (!state || state.phase === "idle") return null;
  if (state.phase === "recovering") return { title: "正在恢复更新", detail: "稳定后台正在检查上一次更新状态。" };
  if (state.phase === "queued") return { title: "更新已排队", detail: "稳定后台已接收签名更新请求。" };
  if (state.phase === "applying") return { title: "正在验证并安装", detail: "正在校验签名、检查发布包并准备新版本。" };
  if (state.phase === "restarting") return { title: "正在重启 PiHub Server", detail: `正在切换至 ${versionLabel(state.targetVersion || updates.server.latest)}，连接可能短暂中断。` };
  if (state.phase === "succeeded") return { title: "更新完成", detail: `已安全切换至 ${versionLabel(state.resultVersion || updates.server.current)}。` };
  const label = UPDATE_ERROR_LABELS[state.errorCode || ""] || "更新未完成";
  return { title: label, detail: `更新已停止 · 错误代码 ${state.errorCode || "unknown"}` };
}

const ACTIVE_DESKTOP_PHASES = new Set<DesktopUpdateState["phase"]>(["checking", "downloading", "verifying", "installing", "restarting"]);

function desktopUpdateDescription(state: DesktopUpdateState | null, error: string): string {
  if (!state) return error || "正在读取本机版本状态…";
  const current = versionLabel(state.currentVersion);
  const available = versionLabel(state.availableVersion);
  if (state.phase === "idle") return `当前 ${current} · GitHub stable 通道`;
  if (state.phase === "checking") return `当前 ${current} · 正在读取 GitHub 发布清单`;
  if (state.phase === "available") return `当前 ${current} · 可更新至 ${available}`;
  if (state.phase === "upToDate") return `当前 ${current} · 已是最新版本`;
  if (state.phase === "downloading") {
    const percent = desktopUpdatePercent(state);
    return `正在下载 ${available}${percent === null ? "" : ` · ${percent}%`}`;
  }
  if (state.phase === "verifying") return `正在验证 ${available} 的发布签名`;
  if (state.phase === "installing") return `签名有效 · 正在安装 ${available}`;
  if (state.phase === "readyToRestart") return `${available} 已安装并通过签名验证`;
  if (state.phase === "restarting") return "正在重启 PiHub Desktop…";
  return state.errorMessage || "桌面更新未完成，当前版本仍可继续使用。";
}

function desktopUpdateAction(state: DesktopUpdateState | null): string {
  if (!state || state.phase === "idle" || state.phase === "upToDate") return "检查桌面更新";
  if (state.phase === "checking") return "检查中…";
  if (state.phase === "available") return "下载并安装";
  if (state.phase === "downloading") return "下载中…";
  if (state.phase === "verifying") return "验证签名…";
  if (state.phase === "installing") return "安装中…";
  if (state.phase === "readyToRestart") return "重启 PiHub";
  if (state.phase === "restarting") return "正在重启…";
  return state.availableVersion ? "重试安装" : "重新检查";
}

function desktopCommandError(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") return cause.message;
  if (cause instanceof Error && cause.message) return cause.message;
  return "桌面更新操作失败，请稍后重试。";
}

function DesktopUpdateRow() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [acting, setActing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void desktopUpdateStatus()
      .then((value) => { if (active && value) setState(value); })
      .catch((cause) => { if (active) setError(desktopCommandError(cause)); });
    void onDesktopUpdate((value) => { if (active) { setState(value); setError(""); } })
      .then((stop) => { if (active) unsubscribe = stop; else stop(); })
      .catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, []);

  async function runAction() {
    setActing(true); setError("");
    try {
      const next = state?.phase === "readyToRestart"
        ? await restartAfterDesktopUpdate()
        : state?.phase === "available" || (state?.phase === "failed" && Boolean(state.availableVersion))
          ? await installDesktopUpdate()
          : await checkDesktopUpdate();
      setState(next);
    } catch (cause) { setError(desktopCommandError(cause)); }
    finally { setActing(false); }
  }

  async function cancelDownload() {
    setCancelling(true); setError("");
    try { setState(await cancelDesktopUpdate()); }
    catch (cause) { setError(desktopCommandError(cause)); }
    finally { setCancelling(false); }
  }

  const active = acting || Boolean(state && ACTIVE_DESKTOP_PHASES.has(state.phase));
  const percent = state ? desktopUpdatePercent(state) : null;
  return <div className="desktop-update-block" aria-live="polite">
    <SetupRow icon={<CircleArrowUp size={17} />} title="PiHub Desktop" description={desktopUpdateDescription(state, error)} action={desktopUpdateAction(state)} busy={active} onClick={() => void runAction()} />
    {state?.phase === "downloading" && <div className="desktop-update-download-controls">
      {percent !== null && <progress className="desktop-update-progress" aria-label="桌面更新下载进度" max={100} value={percent} />}
      <button className="desktop-update-cancel" type="button" disabled={cancelling} onClick={() => void cancelDownload()}><X size={13} />取消下载</button>
    </div>}
    {(state?.phase === "failed" || state?.phase === "readyToRestart") && <div className={`update-phase desktop-${state.phase}`} role={state.phase === "failed" ? "alert" : "status"}>{state.phase === "failed" ? <CircleAlert size={17} /> : <Check size={17} />}<div><strong>{state.phase === "failed" ? "桌面更新未完成" : "桌面更新已就绪"}</strong><span>{state.phase === "failed" ? `${state.errorMessage || error || "请稍后重试"} · 错误代码 ${state.errorCode || "unknown"}` : "关闭正在处理的内容后重启，即可使用新版本。"}</span></div></div>}
    {error && state?.phase !== "failed" && <div className="setup-error" role="alert">{error}</div>}
  </div>;
}

function UpdatesPanel({ device, onServerUpdated }: { device: Device; onServerUpdated: () => void }) {
  const [updates, setUpdates] = useState<RemoteUpdates | null>(null);
  const [applying, setApplying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [forcePrompt, setForcePrompt] = useState(false);
  const updatesRef = useRef<RemoteUpdates | null>(null);
  const notifiedOperationRef = useRef("");
  const forcePromptReturnFocusRef = useRef<HTMLElement | null>(null);
  const serverUpdateButtonRef = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async (silent = false) => {
    if (!silent) { setRefreshing(true); setError(""); }
    try {
      const remote = await loadRemoteUpdates(device);
      updatesRef.current = remote;
      setUpdates(remote);
      setError("");
    } catch (cause) {
      const restarting = updatesRef.current?.update?.phase === "restarting";
      setError(restarting ? "服务正在重启，等待重新连接…" : updateErrorMessage(cause));
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [device]);
  useEffect(() => { void refresh(); }, [refresh]);
  const phase = updates?.update?.phase;
  useEffect(() => {
    if (!phase || !ACTIVE_UPDATE_PHASES.has(phase)) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      await refresh(true);
      if (!cancelled) timer = window.setTimeout(() => { void poll(); }, 1_200);
    };
    timer = window.setTimeout(() => { void poll(); }, 1_200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [phase, refresh]);
  useEffect(() => {
    const state = updates?.update;
    if (state?.phase !== "succeeded") return;
    const key = state.operationId || state.resultVersion || state.updatedAt;
    if (notifiedOperationRef.current === key) return;
    notifiedOperationRef.current = key;
    onServerUpdated();
  }, [onServerUpdated, updates]);

  async function applyUpdate(force = false) {
    if (!updates?.installSupported) return;
    if (!force) forcePromptReturnFocusRef.current = serverUpdateButtonRef.current;
    if (!force && updates.running.length > 0) { setForcePrompt(true); return; }
    setApplying(true); setError("");
    try {
      const accepted = await applyRemoteServerUpdate(device, force);
      setUpdates((current) => {
        if (!current) return current;
        const next = { ...current, update: accepted.update };
        updatesRef.current = next;
        return next;
      });
    } catch (cause) {
      if (!force && cause instanceof BusyUpdateError) { setForcePrompt(true); return; }
      setError(updateErrorMessage(cause));
    } finally { setApplying(false); }
  }

  if (!updates && !error) return <div className="setup-content"><DesktopUpdateRow /><div className="setup-loading"><LoaderCircle className="spin" />检查远程 Server 版本…</div></div>;
  if (!updates) return <div className="setup-content"><DesktopUpdateRow /><div className="update-empty"><div className="setup-error" role="alert">{error}</div><button className="secondary-button compact" onClick={() => void refresh()}>重新检查 Server</button></div></div>;
  const active = Boolean(phase && ACTIVE_UPDATE_PHASES.has(phase));
  const phaseCopy = updatePhaseCopy(updates);
  const upToDate = !updates.server.updateAvailable && !active;
  const action = !updates.installSupported
    ? "此设备不支持应用内更新"
    : active ? "更新进行中"
      : updates.server.updateAvailable ? "安装签名更新" : "已是最新版本";
  return <div className="setup-content">
    <DesktopUpdateRow />
    <div className={`update-install-status ${updates.installSupported ? "supported" : "unsupported"}`}>{updates.installSupported ? <ShieldCheck size={16} /> : <CircleAlert size={16} />}<div><strong>{updates.installSupported ? "GitHub stable 签名通道" : "稳定更新运行器未安装"}</strong><span>{updates.installSupported ? "发布清单、平台包与校验摘要均在安装前验证" : "此设备仍可继续使用当前版本"}</span></div></div>
    {updates.running.length > 0 && <div className="setup-plan"><strong>{updates.running.length} 个会话正在运行</strong><span>安装更新会重启 PiHub Server，需要再次确认。</span></div>}
    <SetupRow icon={<PiHubServeIcon />} title="PiHub Server" description={`当前 ${versionLabel(updates.server.current)} · 最新 ${versionLabel(updates.server.latest)} · ${updates.server.platform}/${updates.server.arch}`} ok={upToDate} action={action} busy={applying || active} disabled={!updates.installSupported} buttonRef={serverUpdateButtonRef} onClick={() => void applyUpdate()} />
    {phaseCopy && <div className={`update-phase ${phase || "idle"}`} role={phase === "failed" ? "alert" : "status"} aria-live="polite">{phase === "failed" ? <CircleAlert size={17} /> : phase === "succeeded" ? <Check size={17} /> : <LoaderCircle className={active ? "spin" : ""} size={17} />}<div><strong>{phaseCopy.title}</strong><span>{phaseCopy.detail}</span></div></div>}
    {error && <div className="setup-error" role="alert">{error}</div>}
    <footer className="updates-footer"><span>Server 上次检查 {new Date(updates.checkedAt).toLocaleTimeString("zh-CN")}</span><button onClick={() => void refresh()} disabled={refreshing || applying}><RefreshCw className={refreshing ? "spin" : ""} size={13} />检查 Server</button></footer>
    {forcePrompt && <ConfirmDialog title="有会话正在运行" message={`当前 ${updates.running.length || "部分"} 个会话仍在运行。更新会重启服务并中断这些会话。`} confirmLabel="仍要更新" danger returnFocus={forcePromptReturnFocusRef.current} onConfirm={() => { setForcePrompt(false); void applyUpdate(true); }} onClose={() => setForcePrompt(false)} />}
  </div>;
}

function SetupRow({ icon, title, description, ok, action, busy, disabled = false, buttonRef, onClick }: { icon: React.ReactNode; title: string; description: string; ok?: boolean; action: string; busy: boolean; disabled?: boolean; buttonRef?: React.Ref<HTMLButtonElement>; onClick: () => void }) { return <div className="setup-row"><span className="setup-icon">{icon}</span><div><strong>{title}</strong><small>{description}</small></div>{ok ? <span className="setup-ok"><Check size={13} />已就绪</span> : <button ref={buttonRef} onClick={onClick} disabled={busy || disabled}>{busy && <LoaderCircle className="spin" size={13} />}<span>{action}</span></button>}</div>; }

function ReadOnlySetupRow({ icon, title, description, ok, label }: { icon: React.ReactNode; title: string; description: string; ok: boolean; label: string }) { return <div className="setup-row setup-row-readonly"><span className="setup-icon">{icon}</span><div><strong>{title}</strong><small>{description}</small></div><span className={ok ? "setup-ok" : "setup-readonly-warning"}>{ok ? <Check size={13} /> : <CircleAlert size={13} />}{label}</span></div>; }
