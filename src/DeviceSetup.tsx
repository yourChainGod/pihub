import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, CircleArrowUp, LoaderCircle, PackageCheck, RefreshCw, ShieldCheck, X } from "lucide-react";
import { PiHubProviderIcon, PiHubServeIcon, PiHubSshIcon, PiHubTailnetIcon } from "./PiHubIcons";
import { ConfirmDialog, useDialogFocus } from "./dialogs";
import { desktopUpdateStatus } from "./desktopUpdater";
import { bootstrapTailnetPeer, checkLocalServerUpdate, DEFAULT_BOOTSTRAP_EXTENSIONS, loadRemoteRunning, loadRemoteSetup, localReleaseDirectory, onBootstrapLog, openTailscaleApproval, runRemoteSetup, scrubBootstrapSecrets } from "./lib";
import type { LocalServerUpdate } from "./lib";
import type { Device, RemoteSetupStatus } from "./types";

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
  const [result, setResult] = useState<LocalServerUpdate | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installedNote, setInstalledNote] = useState("");
  const [logLines, setLogLines] = useState<Array<{ line: string; stream: string }>>([]);
  const [userPrompt, setUserPrompt] = useState(false);
  const [sshUser, setSshUser] = useState("");
  const [rootConfirm, setRootConfirm] = useState<string | null>(null);
  const [restartConfirm, setRestartConfirm] = useState(0);
  const logRef = useRef<HTMLPreElement>(null);
  const installButtonRef = useRef<HTMLButtonElement>(null);

  const releaseDir = localReleaseDirectory().trim();
  const platformOs = setup?.platform?.os ?? "";
  const windows = platformOs === "win32";
  const currentVersion = setup?.server?.version ?? null;

  // Compare every component the archive bundles (server, pi runtime, default
  // extensions) against what the server reports as installed. `undefined`
  // means the server is too old to report the field and the row is skipped.
  const installedPackages = setup?.defaultExtensions?.packages ?? [];
  const componentRows = result ? [
    { key: "pi", label: "Pi Agent 运行时", installed: setup?.pi?.version, bundled: result.pi.version },
    ...result.extensions.map((extension) => {
      const entry = installedPackages.find((item) => item.name === extension.name);
      const installed = entry
        ? (entry.installedVersion !== undefined ? entry.installedVersion : entry.installed ? entry.version : null)
        : null;
      return { key: `ext:${extension.name}`, label: extensionLabel(extension.name), installed, bundled: extension.version };
    }),
  ] : [];
  const componentMismatch = componentRows.some((row) => row.installed !== undefined && row.installed !== row.bundled);
  const updateAvailable = Boolean(result && (result.updateAvailable || componentMismatch));

  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | undefined;
    void onBootstrapLog((line, stream) => { if (!disposed && !line.trimStart().startsWith("PIHUB_PAIRING_CODE=")) setLogLines((current) => [...current.slice(-600), { line, stream }]); })
      .then((fn) => { if (disposed) fn(); else unlisten = fn; });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [logLines]);

  const check = useCallback(async () => {
    setChecking(true); setError("");
    try {
      const status = await loadRemoteSetup(device);
      setSetup(status);
      const os = status.platform?.os ?? "";
      // Windows targets and missing release directories are not errors; the row
      // below explains the state instead of running a local scan.
      if (os === "win32" || !releaseDir) { setResult(null); return; }
      setResult(await checkLocalServerUpdate(releaseDir, os, status.server?.version ?? null));
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
      setCheckedAt(Date.now());
    }
  }, [device, releaseDir]);
  useEffect(() => { void check(); }, [check]);

  async function startInstall(username?: string) {
    const target = result;
    if (!target || installing) return;
    setUserPrompt(false); setSshUser("");
    setInstalling(true); setError(""); setInstalledNote(""); setLogLines([]);
    try {
      // Updates re-provision the bundled extensions so their facade links point
      // at the new version directory; otherwise the components tab reports 0/7.
      const extensionNames = DEFAULT_BOOTSTRAP_EXTENSIONS.map((entry) => entry.name);
      const outcome = await bootstrapTailnetPeer(device.ip || device.host, platformOs, username, true, extensionNames, { localArchiveDir: releaseDir, autoPair: false });
      const output = scrubBootstrapSecrets(outcome.output);
      setInstalledNote(output.includes("PIHUB_BOOTSTRAP_OK") ? `已直传安装 ${versionLabel(target.latest)}，PiHub Server 已更新并重启。` : output);
      onServerUpdated();
      await check();
    } catch (cause) {
      const text = scrubBootstrapSecrets(cause instanceof Error ? cause.message : String(cause));
      const tail = text.split("\n").map((line) => line.trim()).filter(Boolean).pop() || "未知错误";
      setError(`直传安装失败 — ${tail.slice(0, 200)}`);
    } finally { setInstalling(false); }
  }

  function proceedInstall() {
    if (platformOs === "linux") { setUserPrompt(true); return; }
    void startInstall();
  }

  async function requestInstall() {
    if (!updateAvailable || installing) return;
    const running = await loadRemoteRunning(device).catch(() => [] as string[]);
    if (running.length > 0) { setRestartConfirm(running.length); return; }
    proceedInstall();
  }

  const description = windows
    ? `当前 ${versionLabel(currentVersion)} · Windows 目标暂不支持直传更新`
    : !releaseDir
      ? `当前 ${versionLabel(currentVersion)} · 未配置本地发布包目录`
      : result
        ? `当前 ${versionLabel(currentVersion)} · 本地包 ${versionLabel(result.latest)}`
        : error
          ? `当前 ${versionLabel(currentVersion)} · 本地包检查失败`
          : `当前 ${versionLabel(currentVersion)} · 正在检查本地发布包…`;
  return <div className="setup-content">
    <DesktopUpdateRow />
    {windows
      ? <ReadOnlySetupRow icon={<PiHubServeIcon />} title="PiHub Server" description={description} ok={false} label="暂不支持" />
      : !releaseDir
        ? <ReadOnlySetupRow icon={<PiHubServeIcon />} title="PiHub Server" description={description} ok={false} label="未配置目录" />
        : <SetupRow icon={<PiHubServeIcon />} title="PiHub Server" description={description} ok={Boolean(result && !updateAvailable)} action={result ? (result.updateAvailable ? `直传安装 ${versionLabel(result.latest)}` : componentMismatch ? "直传同步组件" : "已是最新") : error ? "重新检查" : "正在检查…"} busy={checking || installing} buttonRef={installButtonRef} onClick={() => (updateAvailable ? void requestInstall() : void check())} />}
    {componentRows.length > 0 && <div className="extension-status-panel"><div className="extension-status-head"><strong>组件版本</strong><span>{componentMismatch ? "有组件与本地包不一致" : "与本地包一致"}</span></div><div className="extension-status-list">{componentRows.map((row) => {
      const state = row.installed === undefined ? "unknown" : row.installed === row.bundled ? "current" : "outdated";
      return <div className="extension-status-item" key={row.key}><span>{row.label}</span><em className={state === "current" ? "ok" : "off"}>{state === "unknown" ? `包内 ${versionLabel(row.bundled)}` : state === "current" ? versionLabel(row.installed) : `${versionLabel(row.installed)} → ${versionLabel(row.bundled)}`}</em></div>;
    })}</div></div>}
    {!windows && !releaseDir && <div className="setup-plan"><strong>未配置本地发布包目录</strong><span>在「连接设置」中填写 build-server-release.mjs 的产出目录后，即可在此检测并直传更新，全程不访问 GitHub。</span></div>}
    {installedNote && <div className="update-phase succeeded" role="status"><Check size={17} /><div><strong>更新完成</strong><span>{installedNote}</span></div></div>}
    {installing && <div className="update-phase applying" role="status" aria-live="polite"><LoaderCircle className="spin" size={17} /><div><strong>正在直传安装</strong><span>正在通过 Tailscale SSH 上传本地发布包并重启 PiHub Server，连接可能短暂中断。</span></div></div>}
    {error && <div className="setup-error" role="alert">{error}</div>}
    {logLines.length > 0 && <pre className="bootstrap-log" ref={logRef}>{logLines.map((entry, index) => <span key={index} className={entry.stream === "stderr" ? "err" : undefined}>{entry.line}{"\n"}</span>)}</pre>}
    <footer className="updates-footer"><span>{checkedAt ? `上次检查 ${new Date(checkedAt).toLocaleTimeString("zh-CN")}` : "尚未检查"}</span><button onClick={() => void check()} disabled={checking || installing}><RefreshCw className={checking ? "spin" : ""} size={13} />重新检查</button></footer>
    {userPrompt && <form className="windows-ssh-form" onSubmit={(event) => { event.preventDefault(); const name = sshUser.trim(); if (!name) return; if (name.toLowerCase() === "root") { setRootConfirm(name); return; } void startInstall(name); }}><div><strong>直传更新 {device.name}</strong><span>建议使用普通用户（例如 pi 或 ubuntu）；以 root 安装会跳过用户权限隔离，需二次确认。</span></div><input value={sshUser} onChange={(event) => setSshUser(event.target.value)} placeholder="Linux 用户名（例如 pi 或 ubuntu）" autoFocus /><button type="button" onClick={() => { setUserPrompt(false); setSshUser(""); }}>取消</button><button type="submit" disabled={!sshUser.trim()}>继续</button></form>}
    {rootConfirm && <ConfirmDialog title={`确认以 root 更新 ${device.name}？`} message="PiHub Server 将以 root 运行：文件、会话和 Provider 凭据都在 root 家目录，用户权限隔离失效。仅当这台机器确实只有 root 可用时才继续。" confirmLabel="以 root 安装" danger onConfirm={() => { const name = rootConfirm; setRootConfirm(null); void startInstall(name); }} onClose={() => setRootConfirm(null)} />}
    {restartConfirm > 0 && <ConfirmDialog title="有会话正在运行 — 强制更新" message={`当前 ${restartConfirm} 个会话仍在运行。强制更新会立即中断这些会话并重启 PiHub Server。`} confirmLabel="强制更新" danger returnFocus={installButtonRef.current} onConfirm={() => { setRestartConfirm(0); proceedInstall(); }} onClose={() => setRestartConfirm(0)} />}
  </div>;
}

function SetupRow({ icon, title, description, ok, action, busy, disabled = false, buttonRef, onClick }: { icon: React.ReactNode; title: string; description: string; ok?: boolean; action: string; busy: boolean; disabled?: boolean; buttonRef?: React.Ref<HTMLButtonElement>; onClick: () => void }) { return <div className="setup-row"><span className="setup-icon">{icon}</span><div><strong>{title}</strong><small>{description}</small></div>{ok ? <span className="setup-ok"><Check size={13} />已就绪</span> : <button ref={buttonRef} onClick={onClick} disabled={busy || disabled}>{busy && <LoaderCircle className="spin" size={13} />}<span>{action}</span></button>}</div>; }

function ReadOnlySetupRow({ icon, title, description, ok, label }: { icon: React.ReactNode; title: string; description: string; ok: boolean; label: string }) { return <div className="setup-row setup-row-readonly"><span className="setup-icon">{icon}</span><div><strong>{title}</strong><small>{description}</small></div><span className={ok ? "setup-ok" : "setup-readonly-warning"}>{ok ? <Check size={13} /> : <CircleAlert size={13} />}{label}</span></div>; }
