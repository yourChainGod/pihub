import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, CircleArrowUp, LoaderCircle, PackageCheck, RefreshCw, ShieldCheck, X } from "lucide-react";
import { PiHubProviderIcon, PiHubServeIcon, PiHubSshIcon, PiHubTailnetIcon } from "./PiHubIcons";
import { ConfirmDialog, useDialogFocus } from "./dialogs";
import { desktopUpdateStatus } from "./desktopUpdater";
import { applyRemoteComponentUpdate, applyRemoteServerUpdate, BusyUpdateError, loadRemoteComponents, loadRemoteSetup, loadRemoteUpdates, openTailscaleApproval, runRemoteSetup } from "./lib";
import type { Device, RemoteComponents, RemoteSetupStatus, RemoteUpdates } from "./types";

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
    {tab === "updates" ? <UpdatesPanel device={device} onServerUpdated={() => void refresh()} /> : !status && !error ? <div className="setup-loading"><LoaderCircle className="spin" />读取服务端状态…</div> : <div className="setup-content" tabIndex={0}>
      <div className="setup-plan"><strong>{plan.length ? `待配置 ${plan.length} 项` : "核心组件已齐全"}</strong><span>{plan.length ? plan.join(" · ") : "远程访问与核心组件已就绪"}</span></div>
      <SetupRow icon={<PiHubServeIcon />} title="Tailscale Serve" description={status?.tailscale.serveUrl || status?.tailscale.dnsName || "将 127.0.0.1:30141 安全映射到 Tailnet HTTPS"} ok={status?.tailscale.serveEnabled} action="启用 Serve" busy={busy === "tailscale-serve"} onClick={() => void action("tailscale-serve")} />
      {windows ? <SetupRow icon={<PiHubSshIcon />} title="Windows OpenSSH" description={`官方 OpenSSH · ${status?.platform?.terminalBackend || "ConPTY"} · ${status?.platform?.preferredShell || "PowerShell"}`} ok={status?.platform?.openSshRunning} action="查看配置说明" busy={false} onClick={() => setOutput("Windows 首次启用 OpenSSH 需要本机管理员确认。请在 Windows 管理员 PowerShell 中运行 scripts/windows/Initialize-PiHubOpenSSH.ps1；PiHub 不会绕过 UAC，也不会保存密码。")} /> : <SetupRow icon={<PiHubSshIcon />} title="Tailscale SSH" description="通过 Tailnet ACL 管理 SSH，不开放 22 端口到公网" ok={status?.tailscale.sshEnabled} action="启用 SSH" busy={busy === "tailscale-ssh-enable"} onClick={() => void action("tailscale-ssh-enable")} />}
      <SetupRow icon={<PiHubProviderIcon />} title="NewAPI Provider" description="已由 PiHub Server 内置，无需单独安装插件" ok={true} action="已内置" busy={false} onClick={() => undefined} />
      <ReadOnlySetupRow icon={<PackageCheck size={17} />} title="PiHub Server" description={status?.server?.version ? `签名版本 ${status.server.version} · 服务正在运行` : "服务端状态未知"} ok={status?.server?.installed === true && status.server.running === true} label={status?.server?.installed ? "已安装" : "未安装"} />
      <ReadOnlySetupRow icon={<PackageCheck size={17} />} title={`可选插件 ${extensions?.installedCount ?? 0}/${extensions?.total ?? 7}`} description="仅来自签名 Server bundle；已配置设备可只安装 Server" ok={extensions?.installed === true} label={extensions ? `${extensions.installedCount}/${extensions.total}` : "状态未知"} />
      {extensions && <div className="extension-status-panel"><div className="extension-status-head"><strong>插件清单</strong><span>{extensions.source === "signed-release" ? "GitHub 签名发布" : "来源未知"}</span></div><div className="extension-status-list">{extensions.packages.map((entry) => <div className="extension-status-item" key={entry.name}><span>{extensionLabel(entry.name)}</span><em className={entry.installed ? "ok" : "off"}>{entry.installed ? "已安装" : "未安装"}</em></div>)}</div>{extensions.magicContext.installed && <div className="magic-context-proof"><ShieldCheck size={14} /><span>Magic Context {extensions.magicContext.configured ? "已配置" : "未配置"} · compaction {extensions.magicContext.compactionEnabled ? "开启" : "关闭"} · todowrite 已禁用</span></div>}</div>}
      <div className="security-proof"><PiHubTailnetIcon size={16} /><div><strong>Tailnet-only 已强制开启</strong><span>服务绑定 {status?.security.binding || "127.0.0.1"} · Funnel 不受支持 · 普通 LAN 与公网请求会被拒绝</span></div></div>
      {error && <div className="setup-error" role="alert">{error}</div>}{output && <pre className="setup-output">{output}</pre>}{approvalUrl && <button className="approval-button" onClick={() => void openTailscaleApproval(approvalUrl)}>打开 Tailscale 官方授权页</button>}
    </div>}
    {tab === "components" && <footer><button onClick={() => void refresh()} disabled={Boolean(busy)}><RefreshCw className={busy ? "spin" : ""} size={13} />刷新</button><button className="primary-setup" onClick={onClose}>完成</button></footer>}
  </section></div>;
}

function versionLabel(value: string | null | undefined): string {
  return value ? `v${value.replace(/^v/, "")}` : "未知";
}

function extensionLabel(name: string): string {
  if (name === "@cortexkit/pi-magic-context") return "Magic Context";
  if (name === "pi-todo-rail") return "Todo Rail";
  if (name === "@ff-labs/pi-fff") return "FFF 搜索";
  if (name === "pi-simplify") return "Simplify";
  if (name === "@gotgenes/pi-permission-system") return "权限系统";
  if (name === "@eko24ive/pi-ask") return "Ask User";
  if (name === "@gotgenes/pi-subagents") return "Subagents";
  return name;
}

function DesktopUpdateRow() {
  const [currentVersion, setCurrentVersion] = useState("");
  useEffect(() => {
    let active = true;
    void desktopUpdateStatus()
      .then((value) => { if (active && value) setCurrentVersion(value.currentVersion); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  return <ReadOnlySetupRow icon={<CircleArrowUp size={17} />} title="PiHub Desktop" description={currentVersion ? `当前 ${versionLabel(currentVersion)} · 自用本地构建，更新请在构建机重新出包安装` : "正在读取本机版本…"} ok={true} label="本地构建" />;
}

function UpdatesPanel({ device, onServerUpdated }: { device: Device; onServerUpdated: () => void }) {
  const [setup, setSetup] = useState<RemoteSetupStatus | null>(null);
  const [components, setComponents] = useState<RemoteComponents | null>(null);
  const [updates, setUpdates] = useState<RemoteUpdates | null>(null);
  const [updatesError, setUpdatesError] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [restartConfirm, setRestartConfirm] = useState(0);
  // Pi / Extensions update state
  const [piUpdating, setPiUpdating] = useState(false);
  const [extUpdating, setExtUpdating] = useState(false);
  const [piUpdateNote, setPiUpdateNote] = useState("");
  const [extUpdateNote, setExtUpdateNote] = useState("");
  const [piUpdateError, setPiUpdateError] = useState("");
  const [extUpdateError, setExtUpdateError] = useState("");
  const [piForceConfirm, setPiForceConfirm] = useState(false);
  const [extForceConfirm, setExtForceConfirm] = useState(false);
  const installButtonRef = useRef<HTMLButtonElement>(null);

  const updateState = updates?.update ?? null;
  const applyingPhase = updateState && ["recovering", "queued", "applying", "restarting"].includes(updateState.phase) ? updateState.phase : null;

  const check = useCallback(async () => {
    setChecking(true); setError("");
    try {
      const [status, comps, remote] = await Promise.all([
        loadRemoteSetup(device),
        loadRemoteComponents(device).catch(() => null),
        loadRemoteUpdates(device).catch((cause: unknown) => {
          setUpdatesError(cause instanceof Error ? cause.message : String(cause));
          return null;
        }),
      ]);
      setSetup(status);
      setComponents(comps);
      if (remote) { setUpdates(remote); setUpdatesError(""); } else { setUpdates(null); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
      setCheckedAt(Date.now());
    }
  }, [device]);
  useEffect(() => { void check(); }, [check]);

  // Poll while the supervisor works through an update transaction.
  useEffect(() => {
    if (!applyingPhase) return;
    const timer = setInterval(() => { void check(); }, 3000);
    return () => clearInterval(timer);
  }, [applyingPhase, check]);

  useEffect(() => {
    if (updates?.update?.phase === "succeeded") onServerUpdated();
  }, [updates?.update?.phase, onServerUpdated]);

  async function doApply(force: boolean) {
    setApplying(true); setError("");
    try {
      await applyRemoteServerUpdate(device, force);
      await check();
    } catch (cause) {
      if (cause instanceof BusyUpdateError) { setRestartConfirm(Math.max(1, updates?.running.length ?? 1)); return; }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setApplying(false); }
  }

  async function requestInstall() {
    if (!updates?.server.updateAvailable || applying) return;
    // Re-check running sessions at click time; the loaded snapshot may be stale.
    const fresh = await loadRemoteUpdates(device).catch(() => null);
    if (fresh) setUpdates(fresh);
    const running = fresh?.running ?? updates.running;
    if (running.length > 0) { setRestartConfirm(running.length); return; }
    await doApply(false);
  }

  // ── Pi Agent update ────────────────────────────────────────────────────────

  async function doUpdatePi(force = false) {
    setPiUpdating(true); setPiUpdateNote(""); setPiUpdateError("");
    try {
      await applyRemoteComponentUpdate(device, "pi", { force });
      setPiUpdateNote("Pi Agent 更新已排队，稍后将在后台完成。");
      void check();
    } catch (cause) {
      if (cause instanceof BusyUpdateError) { setPiForceConfirm(true); return; }
      setPiUpdateError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPiUpdating(false); }
  }

  // ── Extensions update ──────────────────────────────────────────────────────

  async function doUpdateExtensions(force = false) {
    setExtUpdating(true); setExtUpdateNote(""); setExtUpdateError("");
    try {
      await applyRemoteComponentUpdate(device, "extensions", { force });
      setExtUpdateNote("插件更新已排队，稍后将在后台完成。");
      void check();
    } catch (cause) {
      if (cause instanceof BusyUpdateError) { setExtForceConfirm(true); return; }
      setExtUpdateError(cause instanceof Error ? cause.message : String(cause));
    } finally { setExtUpdating(false); }
  }

  const piVersion = components?.pi?.current ?? setup?.pi?.version ?? null;
  const piAvailable = components?.pi?.available ?? Boolean(piVersion);
  const extCount = components?.extensions?.count ?? 0;

  const currentVersion = updates?.server.current ?? setup?.server?.version ?? null;
  const latestVersion = updates?.server.latest ?? null;
  const updateAvailable = Boolean(updates?.server.updateAvailable);
  const installSupported = updates?.installSupported === true;
  const description = updates
    ? `当前 ${versionLabel(currentVersion)} · GitHub stable 最新 ${versionLabel(latestVersion)}`
    : updatesError
      ? `当前 ${versionLabel(currentVersion)} · GitHub 更新检查失败`
      : `当前 ${versionLabel(currentVersion)} · 正在检查 GitHub 更新…`;

  const componentRows = components ? [
    { key: "pi", label: "Pi Agent 运行时", installed: piVersion },
    ...components.extensions.items.map((extension) => ({ key: `ext:${extension.name}`, label: extensionLabel(extension.name), installed: extension.version as string | null })),
  ] : [];

  return <div className="setup-content">
    <DesktopUpdateRow />
    {updates && updateAvailable && !installSupported
      ? <ReadOnlySetupRow icon={<PiHubServeIcon />} title="PiHub Server" description={`${description} · 服务未由更新 supervisor 托管，无法自动安装`} ok={false} label="手动更新" />
      : <SetupRow icon={<PiHubServeIcon />} title="PiHub Server" description={description} ok={Boolean(updates && !updateAvailable)} action={updates ? (updateAvailable ? `安装 ${versionLabel(latestVersion)}` : "已是最新") : updatesError ? "重新检查" : "正在检查…"} busy={checking || applying || Boolean(applyingPhase)} buttonRef={installButtonRef} onClick={() => (updates && updateAvailable ? void requestInstall() : void check())} />}
    {applyingPhase && <div className="update-phase applying" role="status" aria-live="polite"><LoaderCircle className="spin" size={17} /><div><strong>正在更新 PiHub Server</strong><span>服务端正在从 GitHub 下载签名发布包并执行候选健康检查，连接可能短暂中断。</span></div></div>}
    {updateState?.phase === "succeeded" && <div className="update-phase succeeded" role="status"><Check size={17} /><div><strong>更新完成</strong><span>PiHub Server 已更新到 {versionLabel(updateState.resultVersion ?? updateState.targetVersion)} 并重启。</span></div></div>}
    {updateState?.phase === "failed" && <div className="setup-error" role="alert">PiHub Server 更新失败{updateState.errorCode ? `（${updateState.errorCode}）` : ""}，服务已回滚到当前版本。</div>}
    {updatesError && !updates && <div className="setup-error" role="alert">{updatesError}</div>}
    <SetupRow
      icon={<PackageCheck size={17} />}
      title="Pi Agent"
      description={piAvailable ? `当前 ${versionLabel(piVersion)} · 独立进程模式` : "未检测到 Pi Agent"}
      ok={piAvailable}
      action={piAvailable ? "更新 Pi" : "未安装"}
      busy={piUpdating}
      disabled={!piAvailable}
      onClick={() => void doUpdatePi(false)}
    />
    {piUpdateNote && <div className="update-phase succeeded" role="status"><Check size={17} /><div><strong>Pi Agent</strong><span>{piUpdateNote}</span></div></div>}
    {piUpdateError && <div className="setup-error" role="alert">{piUpdateError}</div>}
    <SetupRow
      icon={<PackageCheck size={17} />}
      title={`插件 (${extCount})`}
      description={piAvailable ? `${extCount} 个插件由 Pi 管理 · pi update --extensions` : "需先安装 Pi Agent"}
      ok={piAvailable && extCount > 0}
      action="更新插件"
      busy={extUpdating}
      disabled={!piAvailable}
      onClick={() => void doUpdateExtensions(false)}
    />
    {extUpdateNote && <div className="update-phase succeeded" role="status"><Check size={17} /><div><strong>插件</strong><span>{extUpdateNote}</span></div></div>}
    {extUpdateError && <div className="setup-error" role="alert">{extUpdateError}</div>}
    {componentRows.length > 0 && <div className="extension-status-panel"><div className="extension-status-head"><strong>组件版本</strong><span>设备安装版本</span></div><div className="extension-status-list">{componentRows.map((row) => <div className="extension-status-item" key={row.key}><span>{row.label}</span><em className={row.installed ? "ok" : "off"}>{versionLabel(row.installed)}</em></div>)}</div></div>}
    {error && <div className="setup-error" role="alert">{error}</div>}
    <footer className="updates-footer"><span>{checkedAt ? `上次检查 ${new Date(checkedAt).toLocaleTimeString("zh-CN")}` : "尚未检查"}</span><button onClick={() => void check()} disabled={checking || applying}><RefreshCw className={checking ? "spin" : ""} size={13} />重新检查</button></footer>
    {restartConfirm > 0 && <ConfirmDialog title="有会话正在运行 — 强制更新" message={`当前 ${restartConfirm} 个会话仍在运行。强制更新会立即中断这些会话并重启 PiHub Server。`} confirmLabel="强制更新" danger returnFocus={installButtonRef.current} onConfirm={() => { setRestartConfirm(0); void doApply(true); }} onClose={() => setRestartConfirm(0)} />}
    {piForceConfirm && <ConfirmDialog title="有会话正在运行 — 强制更新 Pi Agent" message="当前有会话正在运行。强制更新 Pi Agent 会中断这些会话。" confirmLabel="强制更新 Pi" danger onConfirm={() => { setPiForceConfirm(false); void doUpdatePi(true); }} onClose={() => setPiForceConfirm(false)} />}
    {extForceConfirm && <ConfirmDialog title="有会话正在运行 — 强制更新插件" message="当前有会话正在运行。强制更新插件会中断这些会话。" confirmLabel="强制更新插件" danger onConfirm={() => { setExtForceConfirm(false); void doUpdateExtensions(true); }} onClose={() => setExtForceConfirm(false)} />}
  </div>;
}

function SetupRow({ icon, title, description, ok, action, busy, disabled = false, buttonRef, onClick }: { icon: React.ReactNode; title: string; description: string; ok?: boolean; action: string; busy: boolean; disabled?: boolean; buttonRef?: React.Ref<HTMLButtonElement>; onClick: () => void }) { return <div className="setup-row"><span className="setup-icon">{icon}</span><div><strong>{title}</strong><small>{description}</small></div>{ok ? <span className="setup-ok"><Check size={13} />已就绪</span> : <button ref={buttonRef} onClick={onClick} disabled={busy || disabled}>{busy && <LoaderCircle className="spin" size={13} />}<span>{action}</span></button>}</div>; }

function ReadOnlySetupRow({ icon, title, description, ok, label }: { icon: React.ReactNode; title: string; description: string; ok: boolean; label: string }) { return <div className="setup-row setup-row-readonly"><span className="setup-icon">{icon}</span><div><strong>{title}</strong><small>{description}</small></div><span className={ok ? "setup-ok" : "setup-readonly-warning"}>{ok ? <Check size={13} /> : <CircleAlert size={13} />}{label}</span></div>; }
