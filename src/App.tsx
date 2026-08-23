import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight, Check, Command, ExternalLink,
  Heart, Import, KeyRound, LoaderCircle, Moon, MoreHorizontal, Pencil, Plus, Radar, RefreshCw,
  Search, Server, Settings2, ShieldCheck, Sparkles, Sun, Trash2, Unlink, WifiOff, X,
} from "lucide-react";
import { PiHubDeviceIcon, PiHubTailnetIcon } from "./PiHubIcons";
import { ConfirmDialog, useDialogFocus } from "./dialogs";
import { bootstrapPairingCode, bootstrapTailnetPeer, credentialStatus, DEFAULT_BOOTSTRAP_EXTENSIONS, deviceId, forgetDeviceCredential, importLegacyDeviceMetadata, isValidPairingCode, listDevices, localReleaseDirectory, normalizePairingCode, normalizeUrl, onBootstrapLog, openDevice, openTailscaleApproval, pairDevice, probe, relayTokenConfigured, removeDevice, saveDevice, scanTailnet, setRelayToken, scrubBootstrapSecrets } from "./lib";
import type { Device, DeviceStatus, TailnetPeer, TailnetScan } from "./types";

const Workspace = lazy(() => import("./Workspace"));

const ACCENTS = ["#fa6f46", "#b885f4", "#64a9ff", "#55c7a5", "#f1bf54", "#ed7299"];

function App() {
  const workspaceId = new URLSearchParams(window.location.search).get("workspace");
  return workspaceId ? <Suspense fallback={<div className="workspace-loading"><LoaderCircle className="spin" /><span>正在连接设备…</span></div>}><Workspace deviceId={workspaceId} /></Suspense> : <FleetApp />;
}

function FleetApp() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [statuses, setStatuses] = useState<Record<string, DeviceStatus>>({});
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState<"add" | "discover" | "settings" | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<TailnetScan | null>(null);
  const [port, setPort] = useState(() => {
    const saved = Number(localStorage.getItem("pihub-port"));
    return Number.isInteger(saved) && saved > 0 && saved <= 65535 ? saved : 30141;
  });
  useEffect(() => { localStorage.setItem("pihub-port", String(port)); }, [port]);
  const [localReleaseDir, setLocalReleaseDir] = useState(() => localReleaseDirectory());
  useEffect(() => { localStorage.setItem("pihub-local-release-dir", localReleaseDir); }, [localReleaseDir]);
  const [scanMode, setScanMode] = useState<"discover" | "setup">("discover");
  const [fleetError, setFleetError] = useState("");
  const [fleetNotice, setFleetNotice] = useState("");
  const [legacyImportPending, setLegacyImportPending] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [removing, setRemoving] = useState<Device | null>(null);
  const [pairing, setPairing] = useState<Device | null>(null);
  const [unpairing, setUnpairing] = useState<Device | null>(null);
  const [paired, setPaired] = useState<Record<string, boolean>>({});
  const [dark, setDark] = useState(() => localStorage.getItem("pihub-theme") !== "light");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("pihub-theme", dark ? "dark" : "light");
  }, [dark]);

  const refreshStatus = useCallback(async (items: Device[]) => {
    if (!items.length) return;
    setStatuses((old) => {
      const next = { ...old };
      for (const device of items) next[device.id] = { state: "checking" };
      return next;
    });
    await Promise.all(items.map(async (device) => {
      const status = await probe(device.url).catch((error) => ({ state: "offline" as const, error: String(error) }));
      setStatuses((old) => ({ ...old, [device.id]: status }));
    }));
  }, []);

  const refreshCredentialStatus = useCallback(async (items: Device[]) => {
    await Promise.all(items.map(async (device) => {
      const result = await credentialStatus(device.url).catch(() => null);
      if (result) setPaired((old) => ({ ...old, [device.id]: result.paired }));
    }));
  }, []);

  useEffect(() => {
    listDevices().then((items) => {
      setDevices(items);
      void refreshStatus(items);
      void refreshCredentialStatus(items);
    }).catch((cause) => setFleetError(cause instanceof Error ? cause.message : String(cause)));
  }, [refreshCredentialStatus, refreshStatus]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchRef.current?.focus(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); setModal("add"); }
    };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, []);

  const filtered = useMemo(() => devices
    .filter((device) => `${device.name} ${device.host}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)), [devices, query]);

  const online = Object.values(statuses).filter((item) => item.state === "online").length;

  // Machine renames change the DNS name embedded in host/url; the CGNAT IP is
  // stable, so re-anchor saved tailscale devices to the peer's current identity.
  const reconcileDeviceIdentities = useCallback(async (peers: TailnetPeer[]) => {
    const updates: Device[] = [];
    for (const peer of peers) {
      const match = devices.find((device) => device.source === "tailscale"
        && (device.ip ? device.ip === peer.ip : device.host === peer.dnsName || device.url === peer.url));
      if (match && (match.url !== peer.url || match.name !== peer.name || match.ip !== peer.ip)) {
        updates.push({ ...match, name: peer.name, host: peer.dnsName || peer.ip, url: peer.url, ip: peer.ip });
      }
    }
    for (const update of updates) setDevices(await saveDevice(update));
  }, [devices]);

  async function startScan(probeServices = true) {
    setModal("discover"); setScanMode(probeServices ? "discover" : "setup"); setScanning(true); setScan(null);
    const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 30141;
    if (safePort !== port) setPort(safePort);
    const result = await scanTailnet(probeServices ? safePort : undefined, probeServices).catch((error) => ({ available: false, peers: [], message: String(error) }));
    setScan(result); setScanning(false);
    if (result.available && result.peers.length) void reconcileDeviceIdentities(result.peers);
  }

  async function addPeer(peer: TailnetPeer) {
    const item: Device = {
      id: deviceId(peer.url), name: peer.name, host: peer.dnsName || peer.ip, os: peer.os,
      url: peer.url, source: "tailscale", favorite: false, ip: peer.ip,
      accent: ACCENTS[devices.length % ACCENTS.length],
    };
    const next = await saveDevice(item); setDevices(next);
    setStatuses((old) => ({ ...old, [item.id]: { state: peer.requiresAuth ? "auth" : "online", latencyMs: peer.latencyMs, version: peer.version } }));
    void refreshCredentialStatus([item]);
  }

  async function toggleFavorite(device: Device) {
    const next = await saveDevice({ ...device, favorite: !device.favorite }); setDevices(next);
  }

  function deleteDevice(id: string) {
    setRemoving(devices.find((item) => item.id === id) ?? null);
  }

  async function confirmDeleteDevice() {
    if (!removing) return;
    const device = removing;
    setRemoving(null);
    try {
      await forgetDeviceCredential(device.url);
      setDevices(await removeDevice(device.id));
      setStatuses((old) => { const next = { ...old }; delete next[device.id]; return next; });
      setPaired((old) => { const next = { ...old }; delete next[device.id]; return next; });
    } catch (cause) {
      setFleetError(`无法移除设备：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function confirmUnpairDevice() {
    if (!unpairing) return;
    const device = unpairing;
    setUnpairing(null);
    try {
      await forgetDeviceCredential(device.url);
      setPaired((old) => ({ ...old, [device.id]: false }));
      await refreshStatus([device]);
    } catch (cause) {
      setFleetError(`无法解除配对：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function confirmLegacyImport() {
    setLegacyImportPending(false);
    setFleetError("");
    setFleetNotice("");
    try {
      const result = await importLegacyDeviceMetadata();
      setDevices(result.devices);
      await Promise.all([refreshStatus(result.devices), refreshCredentialStatus(result.devices)]);
      setFleetNotice(result.imported > 0
        ? `已导入 ${result.imported} 台设备；旧版数据和当前清单备份均已保留。设备密钥未迁移，请重新配对。`
        : `没有可导入的新设备；已跳过 ${result.skipped} 台重复设备，旧版数据未改动。`);
    } catch (cause) {
      setFleetError(`无法导入旧版设备：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return (
    <div className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="traffic-space" />
        <div className="brand"><PiMark size="small" /><span>PiHub</span></div>
        <div className="title-actions">
          <button className="icon-button" aria-label={dark ? "切换为浅色" : "切换为深色"} onClick={() => setDark(!dark)}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
          <button className="icon-button" aria-label="设置" onClick={() => setModal("settings")}><Settings2 size={17} /></button>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="eyebrow"><span className="eyebrow-dot" /> 你的私有计算集群</div>
          <h1>设备工作台</h1>
          <p>连接并管理 Windows、macOS 或 Linux 上的 PiHub Server。</p>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => void startScan()}><Radar size={18} />发现设备</button>
            <button className="secondary-button" onClick={() => void startScan(false)}><Sparkles size={17} />SSH 一键安装</button>
          </div>
        </section>

        <section className="fleet-section">
          <div className="section-head">
            <div>
              <h2>我的设备</h2>
              <div className="fleet-meta"><span className="online-pulse" />{online} 台在线 <span>·</span> {devices.length} 台已保存</div>
            </div>
            <div className="toolbar">
              <label className="search"><Search size={16} /><input ref={searchRef} aria-label="搜索设备" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索设备" /></label>
              <button className="icon-button bordered" onClick={() => void refreshStatus(devices)} aria-label="刷新"><RefreshCw size={16} /></button>
            </div>
          </div>

          {filtered.length ? (
            <div className="device-grid">
              {filtered.map((device) => <DeviceCard key={device.id} device={device} status={statuses[device.id]} paired={paired[device.id]} onOpen={() => void openDevice(device)} onRefresh={() => void refreshStatus([device])} onPair={() => setPairing(device)} onUnpair={() => setUnpairing(device)} onFavorite={() => void toggleFavorite(device)} onDelete={() => void deleteDevice(device.id)} onEdit={() => setEditing(device)} />)}
              <button className="add-card" onClick={() => setModal("add")}><span><Plus size={22} /></span><strong>添加另一台设备</strong><small>输入 Tailscale 地址或主机名</small></button>
            </div>
          ) : devices.length ? (
            <div className="empty"><Search size={28} /><h3>没有匹配的设备</h3><p>换个关键词试试，或检查设备名称。</p></div>
          ) : (
            <div className="fleet-empty-state">
              <div className="fleet-empty-icon"><Server size={32} /></div>
              <h3>欢迎使用 PiHub</h3>
              <p>连接你的远程开发环境，随时随地与 Claude 协作。</p>
              <div className="fleet-empty-actions">
                <button className="primary-button" onClick={() => setModal("discover")}><Radar size={16} />发现 Tailnet 设备</button>
                <button className="secondary-button" onClick={() => setModal("add")}><Plus size={16} />手动添加设备</button>
              </div>
              <div className="fleet-empty-hint">
                <small>💡 提示：已安装 Tailscale？点击「发现 Tailnet 设备」自动查找在线主机。</small>
              </div>
            </div>
          )}
        </section>
      </main>

      {fleetError && <div className="fleet-toast" role="alert"><span>{fleetError}</span><button onClick={() => setFleetError("")} aria-label="关闭"><X size={14} /></button></div>}
      {!fleetError && fleetNotice && <div className="fleet-toast" role="status"><span>{fleetNotice}</span><button onClick={() => setFleetNotice("")} aria-label="关闭"><X size={14} /></button></div>}

      <footer><div><span className="secure-dot"><PiHubTailnetIcon size={14} /></span>通过 Tailscale 私密连接</div><div>PiHub <span>0.0.1</span></div></footer>
      {modal === "add" && <AddModal onClose={() => setModal(null)} onSave={async (device) => { const next = await saveDevice(device); setDevices(next); setPaired((old) => ({ ...old, [device.id]: false })); setModal(null); void refreshStatus([device]); }} count={devices.length} />}
      {editing && <EditModal device={editing} onClose={() => setEditing(null)} onSave={async (previous, device) => {
        try {
          if (previous.id !== device.id) {
            if (previous.url !== device.url) await forgetDeviceCredential(previous.url);
            await removeDevice(previous.id);
            setStatuses((old) => { const next = { ...old }; delete next[previous.id]; return next; });
            setPaired((old) => { const next = { ...old }; delete next[previous.id]; return next; });
          }
          const next = await saveDevice(device);
          setDevices(next);
          setEditing(null);
          void refreshCredentialStatus([device]);
          void refreshStatus([device]);
        } catch (cause) {
          setFleetError(`无法保存设备：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }} />}
      {modal === "discover" && <DiscoverModal scan={scan} scanning={scanning} setupOnly={scanMode === "setup"} devices={devices} port={port} onPort={setPort} localReleaseDir={localReleaseDir} onRescan={() => void startScan(scanMode === "discover")} onAdd={(peer) => void addPeer(peer)} onClose={() => setModal(null)} />}
      {pairing && <PairingModal device={pairing} onClose={() => setPairing(null)} onPaired={async () => { setPaired((old) => ({ ...old, [pairing.id]: true })); await refreshStatus([pairing]); }} onOpen={() => { void openDevice(pairing); setPairing(null); }} />}
      {unpairing && <ConfirmDialog title={`解除“${unpairing.name}”的本机配对？`} message="系统凭据将从这台电脑移除，远端设备与数据不受影响。" confirmLabel="解除配对" danger onConfirm={() => void confirmUnpairDevice()} onClose={() => setUnpairing(null)} />}
      {removing && <ConfirmDialog title={`从 PiHub 移除“${removing.name || "该设备"}”？`} message="远端服务和数据不会被删除。" confirmLabel="移除" danger onConfirm={() => void confirmDeleteDevice()} onClose={() => setRemoving(null)} />}
      {modal === "settings" && <Modal title="连接设置" subtitle="这些约束会在客户端和服务端同时强制执行" onClose={() => setModal(null)}><div className="info-modal"><label className="settings-port">默认服务端口<input type="number" min="1" max="65535" value={port} onChange={(event) => setPort(Number(event.target.value))} /></label><label className="settings-port">本地发布包目录<input value={localReleaseDir} onChange={(event) => setLocalReleaseDir(event.target.value)} placeholder="留空则使用内置默认目录" /></label><InfoRow title="本地直传" text="填写 build-server-release.mjs 产出的发布包目录后，SSH 安装会直接上传本地包并校验 SHA-256，不再访问 GitHub；安装完成且设备未配对时会自动签发一次性配对码完成配对。" /><InfoRow title="会话隐私" text="会话正文只保留在当前进程内存中；关闭窗口后清除，需要时从远端设备重新读取。" /><InfoRow title="网络范围" text="接受 .ts.net、Tailscale CGNAT/IPv6，以及 *.nodes.ffuu.eu.org 中继节点；不提供普通 LAN 回退。" /><RelaySettings /><InfoRow title="服务入口" text="PiHub Server 仅监听 127.0.0.1，并由 Tailscale Serve 提供 HTTPS。" /><div className="settings-migration"><InfoRow title="旧版设备" text="仅导入旧版设备名称与地址；系统凭据不会读取或复制。" /><button className="secondary-button compact" onClick={() => { setModal(null); setLegacyImportPending(true); }}><Import size={15} />从旧版导入</button></div></div></Modal>}
      {legacyImportPending && <ConfirmDialog title="导入旧版设备？" message="PiHub Desktop 将只读旧版设备清单，并在写入前备份当前清单。旧版密钥不会迁移，导入的设备需要重新配对。" confirmLabel="导入设备" onConfirm={() => void confirmLegacyImport()} onClose={() => setLegacyImportPending(false)} />}
    </div>
  );
}

function DeviceCard({ device, status, paired, onOpen, onRefresh, onPair, onUnpair, onFavorite, onDelete, onEdit }: { device: Device; status?: DeviceStatus; paired?: boolean; onOpen: () => void; onRefresh: () => void; onPair: () => void; onUnpair: () => void; onFavorite: () => void; onDelete: () => void; onEdit: () => void }) {
  const [menu, setMenu] = useState(false);
  const state = status?.state ?? "checking";
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest(".card-actions")) setMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(false); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape); };
  }, [menu]);
  return (
    <article className="device-card" style={{ "--accent": device.accent } as React.CSSProperties}>
      <div className="device-icon"><PiHubDeviceIcon os={device.os} size={20} /><span className={`state-indicator ${state}`} /></div>
      <div className="card-body">
        <h3>{device.name}</h3>
        <div className="host"><span>{device.source === "tailscale" ? "TAILSCALE 网络" : "直连"}</span>{device.host}</div>
      </div>
      <div className="card-stats">
        <div><small>状态</small><strong className={state}>{state === "online" ? "在线" : state === "auth" ? "待配对" : state === "checking" ? "检查中" : "离线"}</strong></div>
        <div><small>延迟</small><strong>{status?.latencyMs !== undefined ? `${status.latencyMs} ms` : "—"}</strong></div>
        <div><small>版本</small><strong>{status?.version ? `v${status.version.replace(/^v/, "")}` : "—"}</strong></div>
      </div>
      <div className="card-actions">
        <button className="tiny-button" onClick={onRefresh} disabled={state === "checking"} aria-label={`刷新 ${device.name} 状态`}><RefreshCw size={15} className={state === "checking" ? "spin" : undefined} /></button>
        <button className={`tiny-button ${device.favorite ? "active" : ""}`} onClick={onFavorite} aria-label={device.favorite ? "取消收藏" : "收藏设备"}><Heart size={15} fill={device.favorite ? "currentColor" : "none"} /></button>
        <button className="tiny-button" onClick={() => setMenu(!menu)} aria-label="设备菜单" aria-expanded={menu}><MoreHorizontal size={17} /></button>
        {menu && <div className="card-menu">
          <button onClick={() => { setMenu(false); onEdit(); }}><Pencil size={14} />编辑设备</button>
          {paired && <button onClick={() => { setMenu(false); onUnpair(); }}><Unlink size={14} />解除本机配对</button>}
          <button className="danger" onClick={() => { setMenu(false); onDelete(); }}><Trash2 size={14} />移除设备</button>
        </div>}
      </div>
      <button className="connect-button" disabled={state === "offline" || state === "checking"} onClick={state === "auth" ? onPair : onOpen}>
        <span>{state === "offline" ? <WifiOff size={16} /> : state === "auth" ? <KeyRound size={16} /> : state === "checking" ? <LoaderCircle className="spin" size={16} /> : <Command size={16} />}{state === "offline" ? "设备不可达" : state === "auth" ? "配对设备" : state === "checking" ? "正在检查" : "打开工作台"}</span>
        {state === "auth" ? <ArrowRight size={15} /> : state === "online" ? <ExternalLink size={15} /> : null}
      </button>
      {(state === "offline" || state === "auth") && status?.error && <div className="card-error" role="status">{status.error}</div>}
    </article>
  );
}

function pairingErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/\b429\b|rate.?limit|too many|频繁|次数过多/i.test(message)) return "尝试次数过多，请稍后再试。";
  if (/\b400\b|\b401\b|\b404\b|invalid|expired|already used|无效|过期|已使用/i.test(message)) return "配对码无效、已过期或已被使用，请生成新码后重试。";
  if (/timeout|timed out|network|connect|连接|超时|离线/i.test(message)) return "无法连接设备，请确认设备在线后重试。";
  return "配对失败，请重新生成配对码后重试。";
}

function PairingModal({ device, onClose, onPaired, onOpen }: { device: Device; onClose: () => void; onPaired: () => Promise<void>; onOpen: () => void }) {
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"form" | "loading" | "success">("form");
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalized = normalizePairingCode(code);
    setCode(normalized);
    if (!isValidPairingCode(normalized)) {
      setError("请输入完整的 pihub- 配对码。");
      return;
    }
    setPhase("loading");
    setError("");
    try {
      await pairDevice(device.url, normalized);
      setCode("");
      await onPaired();
      setPhase("success");
    } catch (cause) {
      setError(pairingErrorMessage(cause));
      setPhase("form");
    }
  }

  return <Modal title={`配对 ${device.name}`} subtitle={device.host} onClose={phase === "loading" ? () => {} : onClose}>
    {phase === "success" ? <div className="pairing-success" role="status">
      <span className="pairing-success-icon"><ShieldCheck size={25} /></span>
      <h3>本机已安全配对</h3>
      <p>设备凭据已存入系统凭据库。</p>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>稍后打开</button><button type="button" className="primary-button" onClick={onOpen}><Command size={16} />打开工作台</button></div>
    </div> : <form onSubmit={(event) => void submit(event)} className="modal-form pairing-form">
      <label htmlFor={`pairing-code-${device.id}`}>一次性配对码
        <input id={`pairing-code-${device.id}`} autoFocus autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={code} onChange={(event) => { setCode(event.target.value); setError(""); }} onBlur={() => { if (code.trim()) setCode(normalizePairingCode(code)); }} placeholder="pihub-..." />
      </label>
      {error && <div className="form-error pairing-error" role="alert">{error}</div>}
      <div className="pairing-security"><KeyRound size={16} /><span>配对码仅使用一次，凭据由系统安全保存。</span></div>
      <div className="modal-actions"><button type="button" className="secondary-button" disabled={phase === "loading"} onClick={onClose}>取消</button><button className="primary-button" disabled={phase === "loading" || !code.trim()}>{phase === "loading" ? <><LoaderCircle className="spin" size={16} />正在配对</> : <><ShieldCheck size={16} />确认配对</>}</button></div>
    </form>}
  </Modal>;
}

function AddModal({ onClose, onSave, count }: { onClose: () => void; onSave: (device: Device) => void; count: number }) {
  const [name, setName] = useState(""); const [address, setAddress] = useState(""); const [error, setError] = useState("");
  function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const url = normalizeUrl(address); const host = new URL(url).host;
      onSave({ id: deviceId(url), name: name.trim() || host.split(".")[0], host, url, source: "manual", favorite: false, accent: ACCENTS[count % ACCENTS.length] });
    } catch { setError("请输入有效的主机名、IP 或 URL"); }
  }
  return <Modal title="添加 PiHub Server 设备" subtitle="使用 Tailnet 地址或中继节点名连接" onClose={onClose}>
    <form onSubmit={submit} className="modal-form">
      <label>设备名称 <span>可选</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：Studio Mac" /></label>
      <label>地址<input value={address} onChange={(e) => { setAddress(e.target.value); setError(""); }} placeholder="studio-mac.tailnet.ts.net:30141" /></label>
      {error && <div className="form-error">{error}</div>}
      <div className="hint"><Sparkles size={16} /><span>Tailscale 设备用 <b>HTTPS 30141</b>；中继节点填 <b>节点名.nodes.ffuu.eu.org</b>（如 dgn-01.nodes.ffuu.eu.org）。</span></div>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!address.trim()}>保存设备</button></div>
    </form>
  </Modal>;
}

function EditModal({ device, onClose, onSave }: { device: Device; onClose: () => void; onSave: (previous: Device, next: Device) => void }) {
  const [name, setName] = useState(device.name); const [address, setAddress] = useState(device.url); const [accent, setAccent] = useState(device.accent); const [error, setError] = useState("");
  function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const url = normalizeUrl(address); const host = new URL(url).host;
      onSave(device, { ...device, id: deviceId(url), name: name.trim() || host.split(".")[0], host, url, accent });
    } catch { setError("请输入有效的主机名、IP 或 URL"); }
  }
  return <Modal title="编辑设备" subtitle="修改名称、连接地址或卡片颜色" onClose={onClose}>
    <form onSubmit={submit} className="modal-form">
      <label>设备名称<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>地址<input value={address} onChange={(e) => { setAddress(e.target.value); setError(""); }} placeholder="studio-mac.tailnet.ts.net:30141" /></label>
      <label>卡片颜色<span>可选</span><div className="accent-picker">{ACCENTS.map((color) => <button type="button" key={color} className={accent === color ? "active" : ""} style={{ background: color }} onClick={() => setAccent(color)} aria-label={`颜色 ${color}`} />)}</div></label>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!address.trim()}>保存修改</button></div>
    </form>
  </Modal>;
}

function DiscoverModal({ scan, scanning, setupOnly, devices, port, onPort, localReleaseDir, onRescan, onAdd, onClose }: { scan: TailnetScan | null; scanning: boolean; setupOnly: boolean; devices: Device[]; port: number; onPort: (port: number) => void; localReleaseDir: string; onRescan: () => void; onAdd: (peer: TailnetPeer) => void; onClose: () => void }) {
  const [bootstrapping, setBootstrapping] = useState(""); const [bootstrapMessage, setBootstrapMessage] = useState(""); const [approvalUrl, setApprovalUrl] = useState(""); const [sshPeer, setSshPeer] = useState<TailnetPeer | null>(null); const [sshUser, setSshUser] = useState(""); const [rootConfirm, setRootConfirm] = useState<{ peer: TailnetPeer; username: string } | null>(null);
  const [serverOnly, setServerOnly] = useState(false);
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>(() => DEFAULT_BOOTSTRAP_EXTENSIONS.map((entry) => entry.name));
  const [logLines, setLogLines] = useState<Array<{ line: string; stream: string }>>([]);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let disposed = false; let unlisten: (() => void) | undefined;
    void onBootstrapLog((line, stream) => { if (!disposed && !line.trimStart().startsWith("PIHUB_PAIRING_CODE=")) setLogLines((current) => [...current.slice(-600), { line, stream }]); })
      .then((fn) => { if (disposed) fn(); else unlisten = fn; });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [logLines]);
  async function bootstrap(peer: TailnetPeer, username?: string) {
    const platform = peer.os?.toLowerCase();
    if ((platform === "windows" || platform === "linux") && !username) return;
    setSshPeer(null); setSshUser("");
    setBootstrapping(peer.id); setBootstrapMessage(""); setApprovalUrl(""); setLogLines([]);
    try {
      const chosen = serverOnly ? [] : selectedExtensions;
      const deviceUrl = peer.url || `https://${peer.dnsName || peer.ip}:${port}`;
      const localArchiveDir = localReleaseDir.trim() || undefined;
      // Auto-pair only when this machine has no credential for the target yet.
      const autoPair = !(await credentialStatus(deviceUrl).catch(() => ({ paired: false }))).paired;
      const result = await bootstrapTailnetPeer(peer.dnsName || peer.ip, peer.os, username, chosen.length > 0, chosen, { localArchiveDir, autoPair });
      // The pairing code never leaves this flow: it is claimed here and never rendered.
      const pairingCode = bootstrapPairingCode(result.output);
      let paired = false; let pairFailed = false;
      if (pairingCode) {
        try { await pairDevice(deviceUrl, pairingCode); paired = true; } catch { pairFailed = true; }
      }
      const output = scrubBootstrapSecrets(result.output);
      setApprovalUrl(result.approvalUrl || "");
      const pairingNote = paired ? "，已自动配对" : pairFailed ? "（自动配对失败，请稍后手动配对）" : "";
      setBootstrapMessage(result.requiresApproval ? `${peer.name}：服务已安装，等待 Tailscale Serve 管理员授权。授权后重新扫描即可连接。` : output.includes("PIHUB_BOOTSTRAP_OK") ? `${peer.name}：${result.installed ? "PiHub Server 已安装" : "现有 PiHub Server 已验证"}${chosen.length ? "，插件已按选择配置" : "，未安装插件"}${pairingNote}，并已启用 Tailscale Serve。` : `${output}${pairingNote}`);
    } catch (cause) { const text = cause instanceof Error ? cause.message : String(cause); const tail = scrubBootstrapSecrets(text).split("\n").map((line) => line.trim()).filter(Boolean).pop() || "未知错误"; setBootstrapMessage(`${peer.name}：配置失败 — ${tail.slice(0, 140)}`); setLogLines((current) => [...current, { line: `✕ ${tail}`, stream: "stderr" }]); } finally { setBootstrapping(""); }
  }
  return <Modal wide title={setupOnly ? "SSH 一键安装" : "发现 Tailnet 设备"} subtitle={scanning ? "正在查找在线 Tailnet 设备…" : scan?.tailnet ? `已连接到 ${scan.tailnet}` : "通过本机 Tailscale 自动发现"} onClose={onClose}>
    <div className="scan-toolbar">{!setupOnly && <label>PiHub HTTPS 端口<input type="number" min="1" max="65535" value={port} onChange={(e) => onPort(Number(e.target.value))} /></label>}<button className="secondary-button compact" onClick={onRescan} disabled={scanning}><RefreshCw size={15} />重新扫描</button></div>
    {setupOnly && <section className="bootstrap-options" aria-label="远程安装内容"><div className="bootstrap-options-head"><div><strong>远程安装内容</strong><span>配置本地发布包目录后经 SSH 直传安装并校验 SHA-256；插件来自同一发布 bundle。</span></div><label className="checkbox-row"><input type="checkbox" checked={serverOnly} onChange={(event) => setServerOnly(event.target.checked)} />仅安装 Server</label></div>{!serverOnly && <div className="extension-checkbox-grid">{DEFAULT_BOOTSTRAP_EXTENSIONS.map((extension) => <label className="extension-checkbox" key={extension.name}><input type="checkbox" checked={selectedExtensions.includes(extension.name)} onChange={(event) => setSelectedExtensions((current) => event.target.checked ? [...current, extension.name] : current.filter((name) => name !== extension.name))} /><span><strong>{extension.label}</strong><small>{extension.description} · {extension.version}</small></span></label>)}</div>}</section>}
    {scanning ? <div className="scan-loading"><div className="radar"><Radar size={30} /><i /></div><h3>正在扫描你的 Tailnet</h3><p>{setupOnly ? "读取在线节点，不探测远端服务端口" : `检查在线设备的 HTTPS ${port} 端口`}</p></div> : !scan?.available ? <div className="scan-loading"><WifiOff size={30} /><h3>没有连接到 Tailscale</h3><p>{scan?.message || "请先安装并登录 Tailscale，然后重试。"}</p></div> : (
      <div className="peer-list">
        {scan.peers.length ? scan.peers.map((peer) => {
          const saved = devices.some((d) => d.url === peer.url);
          return <div className={`peer ${peer.piWeb ? "found" : ""}`} key={peer.id}>
            <div className="peer-icon"><PiHubDeviceIcon os={peer.os} size={22} /></div>
            <div className="peer-info"><strong>{peer.name}{peer.isSelf && <em>本机</em>}</strong><span>{peer.dnsName || peer.ip}</span></div>
            <div className="peer-result">{!setupOnly && peer.piWeb ? <><span className="found-label"><Check size={12} /> {peer.requiresAuth ? "PIHUB · 需登录" : "PIHUB"}</span>{saved ? <button className="saved" disabled>已添加</button> : <button className="mini-add" onClick={() => onAdd(peer)}>添加</button>}</> : <><span className="muted">{setupOnly ? "可配置" : "未部署服务"}</span><button className="mini-add setup-peer" disabled={Boolean(bootstrapping)} onClick={() => ["windows", "linux"].includes(peer.os?.toLowerCase() || "") ? setSshPeer(peer) : void bootstrap(peer)}>{bootstrapping === peer.id ? <><LoaderCircle className="spin" size={12} />配置中…</> : peer.os?.toLowerCase() === "windows" ? "OpenSSH 配置" : "Tailscale SSH 配置"}</button></>}</div>
          </div>;
        }) : <div className="scan-loading"><Server size={30} /><h3>Tailnet 中没有在线设备</h3></div>}{bootstrapMessage && <div className="bootstrap-message" role="status"><span>{bootstrapMessage}</span>{approvalUrl && <button onClick={() => void openTailscaleApproval(approvalUrl)}>打开 Tailscale 授权</button>}</div>}{sshPeer && <form className="windows-ssh-form" onSubmit={(event) => { event.preventDefault(); const name = sshUser.trim(); if (!name) return; if (sshPeer.os?.toLowerCase() === "linux" && name.toLowerCase() === "root") { setRootConfirm({ peer: sshPeer, username: name }); return; } void bootstrap(sshPeer, name); }}><div><strong>配置 {sshPeer.name}</strong><span>{sshPeer.os?.toLowerCase() === "windows" ? "使用系统 OpenSSH key/agent，不会保存密码。" : "建议使用普通用户（例如 pi 或 ubuntu）；以 root 安装会跳过用户权限隔离，需二次确认。"}</span></div><input value={sshUser} onChange={(event) => setSshUser(event.target.value)} placeholder={sshPeer.os?.toLowerCase() === "windows" ? "Windows 用户名" : "Linux 用户名（例如 pi 或 ubuntu）"} autoFocus /><button type="button" onClick={() => setSshPeer(null)}>取消</button><button type="submit" disabled={!sshUser.trim()}>继续</button></form>}{rootConfirm && <ConfirmDialog title={`确认以 root 安装到 ${rootConfirm.peer.name}？`} message="PiHub Server 将以 root 运行：文件、会话和 Provider 凭据都在 root 家目录，用户权限隔离失效。仅当这台机器确实只有 root 可用时才继续。" confirmLabel="以 root 安装" danger onConfirm={() => { const target = rootConfirm; setRootConfirm(null); void bootstrap(target.peer, target.username); }} onClose={() => setRootConfirm(null)} />}
      </div>
    )}
    {logLines.length > 0 && <pre className="bootstrap-log" ref={logRef}>{logLines.map((entry, index) => <span key={index} className={entry.stream === "stderr" ? "err" : undefined}>{entry.line}{"\n"}</span>)}</pre>}
  </Modal>;
}

function Modal({ title, subtitle, onClose, wide, children }: { title: string; subtitle: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div ref={dialogRef} className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div><div className="modal-body">{children}</div></div></div>;
}

function RelaySettings() {
  const [token, setToken] = useState("");
  const [configured, setConfigured] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void relayTokenConfigured().then(setConfigured).catch(() => undefined); }, []);
  async function save() {
    setError(""); setSaved(false);
    try {
      await setRelayToken(token.trim());
      setToken(""); setConfigured(true); setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <div className="settings-migration">
    <InfoRow title="中继（Relay）" text={`经 relay.ffuu.eu.org 的 NATS/WSS 中继连接节点，不依赖 Tailscale。${configured ? "传输 token 已配置。" : "尚未配置传输 token。"}`} />
    <div className="relay-token-row">
      <input type="password" value={token} aria-label="Relay token" placeholder="粘贴 relay 传输 token" onChange={(event) => { setToken(event.target.value); setSaved(false); setError(""); }} />
      <button type="button" className="secondary-button compact" disabled={!token.trim()} onClick={() => void save()}>保存</button>
    </div>
    {saved && <div className="hint"><Check size={14} /><span>Relay token 已存入系统钥匙串。</span></div>}
    {error && <div className="form-error">{error}</div>}
  </div>;
}

function InfoRow({ title, text }: { title: string; text: string }) { return <div className="info-row"><strong>{title}</strong><span>{text}</span></div>; }

function PiMark({ size }: { size?: "small" }) {
  return <div className={`pi-mark ${size === "small" ? "small" : ""}`}><span>π</span></div>;
}

export default App;
