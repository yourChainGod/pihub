import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  LoaderCircle,
  Package,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  loadRemotePlugins,
  loadRemoteProjectTrust,
  loadRemoteSkills,
  setRemotePluginEnabled,
  setRemoteSkillEnabled,
  trustRemoteProject,
} from "./lib";
import type {
  Device,
  RemotePluginPackageInfo,
  RemotePluginResourceCounts,
  RemotePluginsResponse,
  RemoteProjectTrustStatus,
  RemoteResourceDiagnostic,
  RemoteResourceScope,
  RemoteSession,
  RemoteSkillInfo,
  RemoteSkillsResponse,
} from "./types";

type ResourceView = "skills" | "plugins";
type ResourceNotice = { kind: "error" | "managed"; message: string };

export default function ResourceManager({ device, session }: { device: Device | null; session?: RemoteSession }) {
  const [view, setView] = useState<ResourceView>("skills");
  const [trust, setTrust] = useState<RemoteProjectTrustStatus | null>(null);
  const [skills, setSkills] = useState<RemoteSkillsResponse | null>(null);
  const [plugins, setPlugins] = useState<RemotePluginsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [notice, setNotice] = useState<ResourceNotice | null>(null);
  const [trustConfirmOpen, setTrustConfirmOpen] = useState(false);
  const [trustAcknowledged, setTrustAcknowledged] = useState(false);
  const loadGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!device || !session) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setNotice(null);
    try {
      const nextTrust = await loadRemoteProjectTrust(device, session.cwd);
      if (generation !== loadGeneration.current) return;
      setTrust(nextTrust);
      const [nextSkills, nextPlugins] = await Promise.all([
        loadRemoteSkills(device, session.cwd),
        loadRemotePlugins(device, session.cwd),
      ]);
      if (generation !== loadGeneration.current) return;
      setSkills(nextSkills);
      setPlugins(nextPlugins);
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      setNotice(resourceNotice(cause));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [device, session]);

  useEffect(() => {
    setTrust(null);
    setSkills(null);
    setPlugins(null);
    setTrustConfirmOpen(false);
    setTrustAcknowledged(false);
    void refresh();
    return () => { loadGeneration.current += 1; };
  }, [refresh]);

  async function confirmTrust() {
    if (!device || !session || !trustAcknowledged) return;
    setBusyKey("trust");
    setNotice(null);
    try {
      const next = await trustRemoteProject(device, session.cwd);
      setTrust(next);
      setTrustConfirmOpen(false);
      setTrustAcknowledged(false);
      await refresh();
    } catch (cause) {
      setNotice(resourceNotice(cause));
    } finally {
      setBusyKey("");
    }
  }

  async function toggleSkill(skill: RemoteSkillInfo, enabled: boolean) {
    if (!device || !session) return;
    const scope = skillScope(skill);
    if (scope === "project" && !trust?.trusted) {
      setNotice({ kind: "error", message: "请先明确确认信任当前项目，再启用项目级 Skill。" });
      return;
    }
    const key = `skill:${skill.filePath}`;
    setBusyKey(key);
    setNotice(null);
    try {
      await setRemoteSkillEnabled(device, skill, enabled);
      setSkills((current) => current ? {
        ...current,
        skills: current.skills.map((item) => item.filePath === skill.filePath
          ? { ...item, disableModelInvocation: !enabled }
          : item),
      } : current);
    } catch (cause) {
      setNotice(resourceNotice(cause));
    } finally {
      setBusyKey("");
    }
  }

  async function togglePlugin(plugin: RemotePluginPackageInfo, enabled: boolean) {
    if (!device || !session) return;
    if (plugin.scope === "project" && !trust?.trusted) {
      setNotice({ kind: "error", message: "请先明确确认信任当前项目，再启用项目级 Plugin。" });
      return;
    }
    const key = `plugin:${plugin.scope}:${plugin.id}`;
    setBusyKey(key);
    setNotice(null);
    try {
      setPlugins(await setRemotePluginEnabled(device, session.cwd, plugin, enabled));
    } catch (cause) {
      setNotice(resourceNotice(cause));
    } finally {
      setBusyKey("");
    }
  }

  function handleViewKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: ResourceView = event.key === "Home" || event.key === "ArrowLeft" ? "skills" : "plugins";
    setView(next);
    requestAnimationFrame(() => document.getElementById(`resource-tab-${next}`)?.focus());
  }

  if (!session) return <div className="tool-placeholder"><div><Package size={27} /></div><h3>项目资源</h3><p>选择会话后查看该工作区的 Skills 与 Plugins。</p></div>;

  const trustPending = Boolean(trust?.requiresTrust && !trust.trusted);
  const hasContent = Boolean(skills || plugins);
  return <section className="resource-manager" aria-label="项目资源管理">
    <header className="resource-toolbar">
      <div className="resource-view-tabs" role="tablist" aria-label="资源类型" onKeyDown={handleViewKey}>
        <button id="resource-tab-skills" role="tab" aria-selected={view === "skills"} aria-controls="resource-view-panel" tabIndex={view === "skills" ? 0 : -1} className={view === "skills" ? "active" : ""} onClick={() => setView("skills")}><Sparkles size={12} />Skills <span>{skills?.skills.length ?? 0}</span></button>
        <button id="resource-tab-plugins" role="tab" aria-selected={view === "plugins"} aria-controls="resource-view-panel" tabIndex={view === "plugins" ? 0 : -1} className={view === "plugins" ? "active" : ""} onClick={() => setView("plugins")}><Package size={12} />Plugins <span>{plugins?.packages.length ?? 0}</span></button>
      </div>
      <button className="resource-refresh" onClick={() => void refresh()} aria-label="刷新项目资源" title="刷新项目资源" disabled={loading || Boolean(busyKey)}>{loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}</button>
    </header>

    {trust && <div className={`resource-trust ${trustPending ? "pending" : "trusted"}`}>
      {trustPending ? <ShieldAlert size={16} /> : <ShieldCheck size={16} />}
      <div><strong>{trustPending ? "项目资源已隔离" : trust.requiresTrust ? "项目资源已信任" : "无需额外信任"}</strong><span>{trustPending ? "项目级代码与配置尚未加载。" : trust.requiresTrust ? "Server 已允许加载此项目的本地资源。" : "当前项目没有需要额外授权的资源。"}</span></div>
      {trustPending && <button onClick={() => { setTrustConfirmOpen(true); setTrustAcknowledged(false); }}>审查并信任</button>}
    </div>}

    {trustConfirmOpen && trustPending && <div className="resource-trust-confirm" role="alertdialog" aria-labelledby="resource-trust-title" onKeyDown={(event) => { if (event.key === "Escape" && busyKey !== "trust") { event.preventDefault(); setTrustConfirmOpen(false); setTrustAcknowledged(false); } }}>
      <div className="resource-confirm-head"><ShieldAlert size={16} /><div><strong id="resource-trust-title">确认信任当前项目</strong><span>{session.cwd}</span></div><button onClick={() => { setTrustConfirmOpen(false); setTrustAcknowledged(false); }} aria-label="取消信任确认" disabled={busyKey === "trust"}><X size={13} /></button></div>
      <p>项目级扩展可执行本地代码，Skills 与设置也会影响 Agent。信任决定会保存在远端设备；运行中的会话必须先结束。</p>
      <label><input type="checkbox" checked={trustAcknowledged} onChange={(event) => setTrustAcknowledged(event.target.checked)} autoFocus />我已核对项目来源，并允许 PiHub 加载其项目级资源</label>
      <div className="resource-confirm-actions"><button onClick={() => { setTrustConfirmOpen(false); setTrustAcknowledged(false); }} disabled={busyKey === "trust"}>取消</button><button className="confirm" disabled={!trustAcknowledged || busyKey === "trust"} onClick={() => void confirmTrust()}>{busyKey === "trust" && <LoaderCircle className="spin" size={12} />}确认信任项目</button></div>
    </div>}

    {notice && <div className={`resource-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}><AlertTriangle size={14} /><span>{notice.message}</span>{notice.kind === "error" && !trustConfirmOpen && <button onClick={() => void refresh()}>重试</button>}</div>}

    {loading && !hasContent ? <div className="resource-loading" role="status"><LoaderCircle className="spin" size={17} /><span>正在读取远端资源…</span></div> : <div className="resource-scroll" id="resource-view-panel" role="tabpanel" aria-labelledby={`resource-tab-${view}`}>
      {view === "skills"
        ? <SkillsView value={skills} trusted={Boolean(trust?.trusted)} busyKey={busyKey} onToggle={toggleSkill} />
        : <PluginsView value={plugins} trusted={Boolean(trust?.trusted)} busyKey={busyKey} onToggle={togglePlugin} />}
    </div>}
  </section>;
}

function SkillsView({ value, trusted, busyKey, onToggle }: {
  value: RemoteSkillsResponse | null;
  trusted: boolean;
  busyKey: string;
  onToggle: (skill: RemoteSkillInfo, enabled: boolean) => void;
}) {
  if (!value?.skills.length) return <ResourceEmpty icon={<Sparkles size={22} />} title="没有可用的 Skills" detail={trusted ? "此工作区尚未配置 Skill。" : "项目资源保持隔离；当前也没有全局 Skill。"} diagnostics={value?.diagnostics} />;
  return <><div className="resource-list-head"><span>模型可调用</span><small>{value.projectResourcesLoaded ? "含项目资源" : "仅全局资源"}</small></div><div className="resource-list">{value.skills.map((skill) => {
    const scope = skillScope(skill);
    const enabled = !skill.disableModelInvocation;
    const key = `skill:${skill.filePath}`;
    const locked = scope === "project" && !trusted;
    return <div className="resource-row" key={skill.filePath}>
      <div className="resource-row-main"><div className="resource-row-title"><strong>{skill.name}</strong><ScopeLabel scope={scope} /></div><p>{skill.description}</p><small>{skill.install?.package || skill.sourceInfo.source || "本地 Skill"}</small></div>
      <label className="resource-switch" title={locked ? "信任项目后可启用" : enabled ? "停用模型自动调用" : "允许模型自动调用"}><span>{busyKey === key ? "保存中" : enabled ? "启用" : "停用"}</span><input type="checkbox" role="switch" aria-label={`${enabled ? "停用" : "启用"} Skill：${skill.name}`} checked={enabled} disabled={Boolean(busyKey) || locked} onChange={(event) => onToggle(skill, event.target.checked)} /></label>
    </div>;
  })}</div><ResourceDiagnostics diagnostics={value.diagnostics} /></>;
}

function PluginsView({ value, trusted, busyKey, onToggle }: {
  value: RemotePluginsResponse | null;
  trusted: boolean;
  busyKey: string;
  onToggle: (plugin: RemotePluginPackageInfo, enabled: boolean) => void;
}) {
  if (!value?.packages.length) return <ResourceEmpty icon={<Package size={22} />} title="没有已配置的 Plugins" detail={trusted ? "此工作区尚未配置 Plugin。" : "项目资源保持隔离；当前也没有全局 Plugin。"} diagnostics={value?.diagnostics} />;
  return <><div className="resource-list-head"><span>已配置 Plugins</span><small>{formatPluginCounts(value.totals)}</small></div><div className="resource-list">{value.packages.map((plugin) => {
    const enabled = !plugin.disabled;
    const key = `plugin:${plugin.scope}:${plugin.id}`;
    const locked = plugin.scope === "project" && !trusted;
    return <div className="resource-row" key={`${plugin.scope}:${plugin.id}`}>
      <div className="resource-row-main"><div className="resource-row-title"><strong>{plugin.label}</strong><ScopeLabel scope={plugin.scope} /></div><p>{formatPluginCounts(plugin.counts)} · {pluginStatus(plugin.status)}</p><small>{plugin.version ? `v${plugin.version}` : plugin.scope === "project" ? "项目配置" : "全局配置"}</small></div>
      <label className="resource-switch" title={locked ? "信任项目后可启用" : enabled ? "停用 Plugin" : "启用 Plugin"}><span>{busyKey === key ? "保存中" : enabled ? "启用" : "停用"}</span><input type="checkbox" role="switch" aria-label={`${enabled ? "停用" : "启用"} Plugin：${plugin.label}`} checked={enabled} disabled={Boolean(busyKey) || locked} onChange={(event) => onToggle(plugin, event.target.checked)} /></label>
    </div>;
  })}</div><ResourceDiagnostics diagnostics={value.diagnostics} /></>;
}

function ResourceEmpty({ icon, title, detail, diagnostics }: { icon: React.ReactNode; title: string; detail: string; diagnostics?: RemoteResourceDiagnostic[] }) {
  return <><div className="resource-empty">{icon}<strong>{title}</strong><span>{detail}</span></div><ResourceDiagnostics diagnostics={diagnostics ?? []} /></>;
}

function ResourceDiagnostics({ diagnostics }: { diagnostics: RemoteResourceDiagnostic[] }) {
  if (!diagnostics.length) return null;
  return <details className="resource-diagnostics"><summary><AlertTriangle size={12} />{diagnostics.length} 条资源诊断</summary><div>{diagnostics.slice(0, 8).map((item, index) => <p key={`${item.code ?? item.type}:${index}`}>{item.message}</p>)}</div></details>;
}

function ScopeLabel({ scope }: { scope: RemoteResourceScope }) {
  return <span className={`resource-scope ${scope}`}>{scope === "project" ? "项目" : "全局"}</span>;
}

function skillScope(skill: RemoteSkillInfo): RemoteResourceScope {
  if (skill.install?.scope === "project" || skill.sourceInfo.scope === "project" || skill.sourceInfo.scope === "local") return "project";
  return "global";
}

function formatPluginCounts(counts: RemotePluginResourceCounts): string {
  const values = [
    [counts.extensions, "扩展"],
    [counts.skills, "Skills"],
    [counts.prompts, "提示词"],
    [counts.themes, "主题"],
  ].filter(([count]) => Number(count) > 0).map(([count, label]) => `${count} ${label}`);
  return values.join(" · ") || "未发现资源";
}

function pluginStatus(status: RemotePluginPackageInfo["status"]): string {
  return ({ loaded: "已加载", installed: "已安装", missing: "文件缺失", disabled: "已停用" } as const)[status];
}

function resourceNotice(cause: unknown): ResourceNotice {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/signed_catalog_required|signed(?: immutable)? catalog|managed[_ -]?resources|managed release|remote package changes|dynamic (?:package|resource).*disabled|HTTP 410/i.test(message)) {
    return { kind: "managed", message: "签名资源目录上线前，远程安装、更新与移除不可用。" };
  }
  if (/insufficient device capability|insufficient capability|HTTP 403/i.test(message)) {
    return { kind: "error", message: "当前设备凭据缺少资源权限，请由设备管理员重新授权后重试。" };
  }
  if (/access denied/i.test(message)) return { kind: "error", message: "当前设备无权访问这个工作区路径。" };
  if (/active session|session to finish|busy/i.test(message)) return { kind: "error", message: "当前项目仍有运行中的会话，请停止后再次确认信任。" };
  if (/authentication required|HTTP 401/i.test(message)) return { kind: "error", message: "设备鉴权已失效，请重新配对后重试。" };
  return { kind: "error", message: message || "资源操作失败，请重试。" };
}
