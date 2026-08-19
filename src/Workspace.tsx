import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, Circle, CircleHelp, Copy, Download, FileCode2, FileDown, FolderInput, FolderPlus,
  Files, Folder, FolderGit2, GitBranch, HardDrive, ImagePlus, LoaderCircle, MessageSquareText,
  MoreHorizontal, Moon, Package, PanelLeftClose, PanelRightClose, Pencil, Plus, RefreshCw, Scissors, Search,
  Send, Settings2, ShieldAlert, Sparkles, Square, Sun, TerminalSquare, Trash2, Upload, Volume2, VolumeX, Wifi, Wrench, X,
} from "lucide-react";
import { autoNameRemoteSession, browseRemoteDirectories, compactRemoteSession, createRemoteFolderSession, createRemoteSession, createRemoteWorktree, deleteRemoteNewApiProvider, deleteRemoteSession, deleteRemoteWorktree, downloadRemoteFile, exportRemoteSession, forkRemoteSession, isTauriEnvironment, listDevices, loadRemoteAbsoluteFile, loadRemoteAgentState, loadRemoteDirectory, loadRemoteFile, loadRemoteFiles, loadRemoteGit, loadRemoteGitDiff, loadRemoteModels, loadRemoteModelsConfig, loadRemoteNewApi, loadRemoteRunning, loadRemoteSession, loadRemoteSessions, loadRemoteThinking, loadRemoteWorktrees, navigateRemoteTree, notifyDone, refreshRemoteNewApiProvider, remoteAgentEventMatchesDevice, remoteAgentStreamKey, remoteFileAction, renameRemoteSession, saveRemoteModelsConfig, saveRemoteNewApiProvider, sendRemoteAgentCommand, sendRemotePrompt, startRemoteAgentStream, steerRemotePrompt, stopRemoteAgent, stopRemoteAgentStream, uploadRemoteCheck, uploadRemoteFiles } from "./lib";
import type { AttachedImage, Device, RemoteAgentEventPayload, RemoteAgentState, RemoteContextUsage, RemoteDirectoryBrowse, RemoteDirectoryListing, RemoteFilePreview, RemoteGitDiff, RemoteGitStatus, RemoteModelsResponse, RemoteNewApiConfig, RemoteSession, RemoteUiRequest, RemoteWorktree, RemoteWorktrees, SessionDetail, SessionMessage, SessionTokenStats, SessionTreeNode } from "./types";
import { isDesktopWindowFullscreen, listenDesktopEvent, onDesktopWindowResized, startDesktopWindowDragging } from "./desktopTransport";
import { cacheKey, deleteCachedSession, peekSession, readCachedSession, writeCachedSession } from "./sessionCache";
import ConversationMessages, { Markdown } from "./MessageView";
import ChatMinimap from "./ChatMinimap";
import { ConfirmDialog, NamePromptDialog, useDialogFocus } from "./dialogs";
import RemoteTerminal from "./RemoteTerminal";
import DeviceSetup from "./DeviceSetup";
import ResourceManager from "./ResourceManager";

type CoreToolTab = "files" | "git" | "terminal";
type ToolTab = CoreToolTab | "resources";
const TOOL_TABS: ToolTab[] = ["files", "git", "terminal", "resources"];

export default function Workspace({ deviceId }: { deviceId: string }) {
  const [device, setDevice] = useState<Device | null>(null);
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [namePrompt, setNamePrompt] = useState<{ title: string; initial: string; onSubmit: (name: string) => void } | null>(null);
  const imeComposingRef = useRef(false);
  const imeEndedAtRef = useRef(0);
  const [confirmAction, setConfirmAction] = useState<{ title: string; message?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void } | null>(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth > 760);
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth > 960);
  const [leftWidth, setLeftWidth] = useState(() => Number(localStorage.getItem("pihub-left-w")) || 250);
  const [rightWidth, setRightWidth] = useState(() => Number(localStorage.getItem("pihub-right-w")) || 300);
  useEffect(() => { localStorage.setItem("pihub-left-w", String(leftWidth)); }, [leftWidth]);
  useEffect(() => { localStorage.setItem("pihub-right-w", String(rightWidth)); }, [rightWidth]);

  function startColumnDrag(side: "left" | "right") {
    return (event: React.MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = side === "left" ? leftWidth : rightWidth;
      document.body.style.userSelect = "none";
      const onMove = (move: MouseEvent) => {
        const delta = move.clientX - startX;
        const next = Math.min(560, Math.max(180, side === "left" ? startWidth + delta : startWidth - delta));
        if (side === "left") setLeftWidth(next); else setRightWidth(next);
      };
      const onUp = () => {
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };
  }
  const [toolTab, setToolTab] = useState<ToolTab>("files");
  const [creatingSession, setCreatingSession] = useState(false);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [folderPicker, setFolderPicker] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("pihub-theme") !== "light");
  const [setupOpen, setSetupOpen] = useState(false);
  const [models, setModels] = useState<RemoteModelsResponse | null>(null);
  const [modelMenu, setModelMenu] = useState<"model" | "thinking" | "tools" | null>(null);
  const [modelsConfigOpen, setModelsConfigOpen] = useState(false);
  const [worktrees, setWorktrees] = useState<RemoteWorktrees | null>(null);
  const [worktreeMenu, setWorktreeMenu] = useState(false);
  const [worktreePrompt, setWorktreePrompt] = useState(false);
  const [worktreeRemoving, setWorktreeRemoving] = useState<RemoteWorktree | null>(null);
  const [worktreeBusy, setWorktreeBusy] = useState("");
  const [worktreeError, setWorktreeError] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [agentState, setAgentState] = useState<RemoteAgentState["state"] | null>(null);
  const agentStateRef = useRef<RemoteAgentState["state"] | null>(null);
  agentStateRef.current = agentState;
  const [statsOpen, setStatsOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  function openRowMenu(id: string, x: number, y: number) {
    const menuHeight = 168;
    const top = y + 6 + menuHeight > window.innerHeight ? Math.max(8, y - menuHeight) : y + 6;
    setRowMenu({ id, x: Math.max(8, Math.min(x, window.innerWidth - 170)), y: top });
  }
  const [compactBusy, setCompactBusy] = useState(false);
  const [compactResult, setCompactResult] = useState<{ before: number; after: number } | null>(null);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [forkingId, setForkingId] = useState("");
  const [notice, setNotice] = useState("");
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem("pihub-sound") === "1");
  const filePickRef = useRef<HTMLInputElement>(null);
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description?: string; source?: string }> | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [toolPreset, setToolPreset] = useState<string>("default");
  const [askQueue, setAskQueue] = useState<Array<{ sessionId: string; request: RemoteUiRequest }>>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerSelectRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  // Per-session scroll memory: recorded on scroll, restored once on switch.
  const scrollPositionsRef = useRef(new Map<string, number>());
  const pendingRestoreRef = useRef<{ session: string; top: number | null } | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const detailRef = useRef<SessionDetail | null>(null);
  const draftsRef = useRef(new Map<string, string>());
  const draftRef = useRef(draft);
  const draftOwnerRef = useRef<string | null>(null);
  const streamSessionsRef = useRef(new Set<string>());
  const streamGenerationsRef = useRef(new Map<string, number>());
  const hydratedSessionsRef = useRef(new Set<string>());
  const selected = sessions.find((session) => session.id === selectedId);
  const isRunning = selectedId ? running.has(selectedId) : false;

  function updateDraft(next: string): void {
    draftRef.current = next;
    setDraft(next);
    const owner = draftOwnerRef.current;
    if (!owner) return;
    if (next) draftsRef.current.set(owner, next);
    else draftsRef.current.delete(owner);
  }

  // Sessions created via ensure_session have no .jsonl until the first prompt,
  // and the server deliberately hides such idle runtimes from /api/sessions.
  // Keep them listed locally so the sidebar row and tab appear immediately.
  const pendingSessionsRef = useRef(new Map<string, RemoteSession>());
  const mergePendingSessions = useCallback((list: RemoteSession[]) => {
    const pending = pendingSessionsRef.current;
    for (const id of [...pending.keys()]) if (list.some((session) => session.id === id)) pending.delete(id);
    return [...list, ...pending.values()];
  }, []);

  const refreshSessions = useCallback(async (target: Device) => {
    try {
      const data = await loadRemoteSessions(target);
      setSessions(mergePendingSessions(data.sessions));
      setRunning(new Set(data.runningSessionIds));
      setSelectedId((current) => current ?? data.sessions[0]?.id ?? null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setLoading(false); }
  }, [mergePendingSessions]);

  const refreshSessionsQuiet = useCallback(async (target: Device) => {
    try {
      const data = await loadRemoteSessions(target);
      setSessions(mergePendingSessions(data.sessions));
      setRunning(new Set(data.runningSessionIds));
    } catch { /* keep last reliable state */ }
  }, [mergePendingSessions]);

  const storeDetail = useCallback((target: Device, sessionId: string, next: SessionDetail) => {
    writeCachedSession(cacheKey(target.id, sessionId), next);
    if (selectedIdRef.current === sessionId) {
      const scroll = messageScrollRef.current;
      const follow = !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
      detailRef.current = next; setDetail(next);
      if (follow) requestAnimationFrame(() => { const current = messageScrollRef.current; if (current) current.scrollTop = current.scrollHeight; });
    }
  }, []);

  const refreshDetail = useCallback(async (target: Device, sessionId: string, quiet = false, limit = 40): Promise<SessionDetail | null> => {
    if (!quiet) setDetailLoading(true);
    try {
      const fetched = await loadRemoteSession(target, sessionId, limit);
      // The Rust client maps a non-JSON 200 body (e.g. server mid-restart) to
      // null; without this guard the merge below throws an opaque TypeError.
      if (!fetched || typeof fetched !== "object" || !Array.isArray(fetched.context?.messages)) throw new Error("远端返回了空响应（服务可能在重启中），请稍后重试");
      const cached = peekSession(cacheKey(target.id, sessionId));
      // Keep local optimistic/streaming messages while a background history page arrives.
      const local = cached?.context.messages ?? [];
      const remoteKeys = new Set(fetched.context.messages.map((message) => `${message.role}:${message.timestamp ?? ""}:${JSON.stringify(message.content).slice(0, 80)}`));
      const pending = local.filter((message) => (message.pihubOptimistic || message.pihubStreaming) && !remoteKeys.has(`${message.role}:${message.timestamp ?? ""}:${JSON.stringify(message.content).slice(0, 80)}`));
      const next = pending.length ? { ...fetched, context: { ...fetched.context, messages: [...fetched.context.messages, ...pending] } } : fetched;
      storeDetail(target, sessionId, next); setError(""); return next;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return null; }
    finally { if (!quiet) setDetailLoading(false); }
  }, [storeDetail]);

  useEffect(() => {
    listDevices().then((items) => {
      const found = items.find((item) => item.id === deviceId) ?? null;
      setDevice(found);
      if (found) void refreshSessions(found); else { setError("找不到该设备"); setLoading(false); }
    });
  }, [deviceId, refreshSessions]);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { deviceRef.current = device; }, [device]);
  useEffect(() => { detailRef.current = detail; }, [detail]);

  useEffect(() => {
    const nextOwner = device && selectedId ? cacheKey(device.id, selectedId) : null;
    const previousOwner = draftOwnerRef.current;
    if (previousOwner && previousOwner !== nextOwner) {
      if (draftRef.current) draftsRef.current.set(previousOwner, draftRef.current);
      else draftsRef.current.delete(previousOwner);
    }
    if (previousOwner === nextOwner) return;
    draftOwnerRef.current = nextOwner;
    const nextDraft = nextOwner ? draftsRef.current.get(nextOwner) ?? "" : "";
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    if (composerRef.current) composerRef.current.style.height = "auto";
  }, [device, selectedId]);
  useEffect(() => {
    if (!device) return;
    const streamSessions = streamSessionsRef.current;
    const streamGenerations = streamGenerationsRef.current;
    return () => {
      for (const key of [...streamSessions]) {
        const parsed = JSON.parse(key) as [string, string, string];
        if (parsed[0] !== device.id) continue;
        streamSessions.delete(key);
        streamGenerations.delete(key);
        void stopRemoteAgentStream(device, parsed[2]);
      }
    };
  }, [device]);

  useEffect(() => {
    if (!device || !selectedId) { setDetail(null); return; }
    pendingRestoreRef.current = { session: selectedId, top: scrollPositionsRef.current.get(selectedId) ?? null };
    let alive = true;
    const key = cacheKey(device.id, selectedId);
    const immediate = peekSession(key);
    if (immediate) {
      detailRef.current = immediate; setDetail(immediate); setDetailLoading(false);
      if (!hydratedSessionsRef.current.has(key)) {
        hydratedSessionsRef.current.add(key);
        void refreshDetail(device, selectedId, true, 120).then((next) => {
          if (next?.context.truncated && (next.context.totalMessages ?? 0) > 120) void refreshDetail(device, selectedId, true, 500);
        });
      }
      return;
    }
    setDetail(null); setDetailLoading(true);
    void readCachedSession(key).then((cached) => {
      if (!alive || selectedIdRef.current !== selectedId) return;
      if (cached) {
        detailRef.current = cached; setDetail(cached); setDetailLoading(false);
        hydratedSessionsRef.current.add(key);
        void refreshDetail(device, selectedId, true, 120).then((next) => {
          if (next?.context.truncated && (next.context.totalMessages ?? 0) > 120) void refreshDetail(device, selectedId, true, 500);
        });
      } else {
        hydratedSessionsRef.current.add(key);
        void refreshDetail(device, selectedId).then((next) => {
          if (next?.context.truncated && (next.context.totalMessages ?? 0) > 40) void refreshDetail(device, selectedId, true, 120).then((more) => {
            if (more?.context.truncated && (more.context.totalMessages ?? 0) > 120) void refreshDetail(device, selectedId, true, 500);
          });
        });
      }
    });
    return () => { alive = false; };
  }, [device, selectedId, refreshDetail]);

  // Restore the remembered scroll position once the switched session renders;
  // no record means first open → jump to the latest messages.
  useEffect(() => {
    const pending = pendingRestoreRef.current;
    if (!pending || !detail || pending.session !== selectedId) return;
    pendingRestoreRef.current = null;
    requestAnimationFrame(() => {
      const el = messageScrollRef.current;
      if (el) el.scrollTop = pending.top ?? el.scrollHeight;
    });
  }, [detail, selectedId]);

  const shortcutActionsRef = useRef<{ create: () => void; close: (id: string) => void }>({ create: () => {}, close: () => {} });
  shortcutActionsRef.current = { create: () => void createSession(), close: (id: string) => closeTab(id) };

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k") { event.preventDefault(); searchRef.current?.focus(); }
      if (key === "n") {
        event.preventDefault();
        if (event.shiftKey) setFolderPicker(true);
        else shortcutActionsRef.current.create();
      }
      if (key === "enter" && selectedIdRef.current) { event.preventDefault(); composerRef.current?.focus(); }
      if (key === "w" && selectedIdRef.current) { event.preventDefault(); shortcutActionsRef.current.close(selectedIdRef.current); }
    };
    window.addEventListener("keydown", shortcut); return () => window.removeEventListener("keydown", shortcut);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setOpenTabs((current) => current.includes(selectedId) ? current : [...current, selectedId]);
  }, [selectedId]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("pihub-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    if (!device || !selected?.cwd) return;
    let alive = true;
    void loadRemoteModels(device, selected.cwd).then((value) => alive && setModels(value)).catch((cause) => alive && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { alive = false; };
  }, [device, selected?.cwd]);

  const refreshWorktrees = useCallback(async (target: Device, cwd: string) => {
    try {
      const next = await loadRemoteWorktrees(target, cwd);
      setWorktrees(next); setWorktreeError("");
      return next;
    } catch (cause) {
      setWorktrees(null);
      setWorktreeError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, []);

  useEffect(() => {
    setWorktreeMenu(false); setWorktreePrompt(false); setWorktreeRemoving(null); setWorktreeError("");
    if (!device || !selected?.cwd) { setWorktrees(null); return; }
    let alive = true;
    void loadRemoteWorktrees(device, selected.cwd)
      .then((next) => { if (alive) setWorktrees(next); })
      .catch((cause) => { if (alive) { setWorktrees(null); setWorktreeError(cause instanceof Error ? cause.message : String(cause)); } });
    return () => { alive = false; };
  }, [device, selected?.cwd]);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const update = () => { void isDesktopWindowFullscreen().then((value) => { if (!disposed) setFullscreen(value); }).catch(() => undefined); };
    update();
    void onDesktopWindowResized(update).then((dispose) => { if (disposed) dispose(); else unlisten = dispose; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const toolsSyncedRef = useRef(new Set<string>());

  const refreshAgentState = useCallback(async (target: Device, sessionId: string) => {
    try {
      const result = await loadRemoteAgentState(target, sessionId);
      if (selectedIdRef.current === sessionId) setAgentState(result.running ? result.state ?? null : null);
      // Once a wrapper is live, sync the active tool preset from get_tools.
      if (result.running && !toolsSyncedRef.current.has(sessionId)) {
        toolsSyncedRef.current.add(sessionId);
        sendRemoteAgentCommand(target, sessionId, { type: "get_tools" })
          .then((envelope) => {
            const tools = (envelope as { data?: Array<{ name: string; active: boolean }> })?.data;
            if (Array.isArray(tools) && selectedIdRef.current === sessionId) setToolPreset(presetFromTools(tools));
          })
          .catch(() => toolsSyncedRef.current.delete(sessionId));
      }
    } catch { /* state endpoint is best-effort */ }
  }, []);

  useEffect(() => {
    if (!device) return;
    const timer = window.setInterval(async () => {
      try {
        const ids = await loadRemoteRunning(device); setRunning(new Set(ids));
        for (const id of ids) {
          const streamKey = remoteAgentStreamKey(device, id);
          if (streamSessionsRef.current.has(streamKey)) continue;
          streamSessionsRef.current.add(streamKey);
          void startRemoteAgentStream(device, id)
            .then((generation) => streamGenerationsRef.current.set(streamKey, Math.max(generation, streamGenerationsRef.current.get(streamKey) ?? 0)))
            .catch(() => streamSessionsRef.current.delete(streamKey));
        }
        // Only poll agent state when it can change: the selected session is
        // running, or we hold live state that needs a final idle transition.
        const selected = selectedIdRef.current;
        if (selected && (ids.includes(selected) || agentStateRef.current)) void refreshAgentState(device, selected);
      } catch { /* keep last reliable state */ }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [device, refreshAgentState]);

  useEffect(() => {
    setAgentState(null); setStatsOpen(false); setSessionMenu(false); setCompactResult(null); setImages([]);
    if (device && selectedId) void refreshAgentState(device, selectedId);
  }, [device, selectedId, refreshAgentState]);

  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;
  const sessionsRef = useRef<RemoteSession[]>([]);
  sessionsRef.current = sessions;

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let disposed = false;
    let dispose: (() => void) | undefined;
    void listenDesktopEvent<RemoteAgentEventPayload>("pihub-agent-event", (payload) => {
      const target = deviceRef.current;
      if (!target || !remoteAgentEventMatchesDevice(payload, target)) return;
      const streamKey = remoteAgentStreamKey(target, payload.sessionId);
      const knownGeneration = streamGenerationsRef.current.get(streamKey) ?? 0;
      if (payload.generation < knownGeneration) return;
      streamGenerationsRef.current.set(streamKey, payload.generation);
      applyAgentEvent(target, payload.sessionId, payload.event, storeDetail, setRunning, streamSessionsRef.current, {
        onSettled: (sessionId) => {
          if (soundRef.current) playDoneSound();
          if (!document.hasFocus()) {
            const name = sessionsRef.current.find((session) => session.id === sessionId)?.name || "会话";
            void notifyDone(`${name} · 运行完成`, "Pi 任务已结束，点击查看结果");
          }
          if (selectedIdRef.current !== sessionId) setDoneIds((current) => new Set(current).add(sessionId));
          if (selectedIdRef.current === sessionId) void refreshAgentState(target, sessionId);
          void refreshSessionsQuiet(target);
        },
        onUiRequest: (sessionId, request) => {
          if (request.method === "notify") {
            setNotice(request.message || "扩展通知");
            return;
          }
          if (["select", "confirm", "input", "editor"].includes(request.method)) {
            setAskQueue((queue) => [...queue, { sessionId, request }]);
          }
        },
      });
    }).then((unlisten) => { if (disposed) unlisten(); else dispose = unlisten; });
    return () => { disposed = true; dispose?.(); };
  }, [storeDetail, refreshAgentState, refreshSessionsQuiet]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest(".popover-root")) return;
      setModelMenu(null); setSessionMenu(false); setStatsOpen(false); setRowMenu(null); setWorktreeMenu(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setModelMenu(null); setSessionMenu(false); setStatsOpen(false); setRowMenu(null); setWorktreeMenu(false); }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown, true); document.removeEventListener("keydown", onKeyDown); };
  }, []);

  const projects = useMemo(() => {
    const groups = new Map<string, { name: string; root: string; sessions: RemoteSession[] }>();
    for (const session of sessions) {
      const root = session.projectRoot || session.cwd;
      const key = session.projectKey || root;
      const name = root.split(/[\\/]/).filter(Boolean).at(-1) || root;
      const group = groups.get(key) ?? { name, root, sessions: [] };
      group.sessions.push(session); groups.set(key, group);
    }
    return [...groups.values()]
      .map((group) => ({ ...group, sessions: group.sessions.sort((a, b) => Number(a.messageCount === 0) - Number(b.messageCount === 0) || b.modified.localeCompare(a.modified)) }))
      .sort((a, b) => (b.sessions[0]?.modified ?? "").localeCompare(a.sessions[0]?.modified ?? ""));
  }, [sessions]);

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [showJump, setShowJump] = useState(false);
  useEffect(() => {
    if (!selectedId) return;
    setDoneIds((current) => {
      if (!current.has(selectedId)) return current;
      const next = new Set(current); next.delete(selectedId); return next;
    });
  }, [selectedId]);

  const filteredProjects = useMemo(() => projects.map((project) => ({
    ...project,
    sessions: project.sessions.filter((session) => `${session.name || ""} ${session.firstMessage}`.toLowerCase().includes(query.toLowerCase())),
  })).filter((project) => project.name.toLowerCase().includes(query.toLowerCase()) || project.sessions.length), [projects, query]);

  const stats = useMemo<SessionTokenStats | null>(() => computeSessionStats(detail?.context.messages ?? []), [detail]);
  const contextUsage: RemoteContextUsage | null = agentState?.contextUsage ?? null;
  const isCompacting = Boolean(agentState?.isCompacting) || compactBusy;
  const branches = useMemo(() => collectBranches(detail?.tree ?? [], detail?.leafId ?? null), [detail]);

  /* Slash command palette: local builtins + server commands (lazy-loaded). */
  const slashQuery = draft.startsWith("/") && !/\s/.test(draft.slice(1)) ? draft.slice(1).toLowerCase() : null;
  const slashItems = useMemo(() => {
    if (slashQuery === null) return [];
    return [...BUILTIN_SLASH_COMMANDS, ...(slashCommands ?? [])]
      .filter((item) => item.name.toLowerCase().includes(slashQuery) || (item.description ?? "").toLowerCase().includes(slashQuery))
      .slice(0, 8);
  }, [slashQuery, slashCommands]);
  const slashOpen = slashQuery !== null && !slashDismissed && slashItems.length > 0;

  useEffect(() => {
    if (slashQuery === null || slashCommands !== null || !device || !selectedId) return;
    sendRemoteAgentCommand(device, selectedId, { type: "get_commands" })
      .then((envelope) => {
        const commands = (envelope as { data?: { commands?: Array<{ name: string; description?: string; source?: string }> } })?.data?.commands;
        if (Array.isArray(commands)) setSlashCommands(commands);
      })
      .catch(() => setSlashCommands([]));
  }, [slashQuery, slashCommands, device, selectedId]);

  useEffect(() => { setSlashCommands(null); setToolPreset("default"); }, [selectedId]);

  function applySlash(item: { name: string }) {
    updateDraft(`/${item.name} `);
    setSlashDismissed(false);
    composerRef.current?.focus();
  }

  async function runSlashCommand(text: string): Promise<boolean> {
    if (!device || !selectedId) return false;
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return false;
    const name = match[1]; const args = (match[2] ?? "").trim();
    switch (name) {
      case "compact":
        await compactSession(args || undefined);
        return true;
      case "reload":
        setNotice("正在重载会话资源…");
        try {
          await sendRemoteAgentCommand(device, selectedId, { type: "reload" });
          await refreshDetail(device, selectedId, true);
          if (selected?.cwd) await loadRemoteModels(device, selected.cwd).then(setModels).catch(() => undefined);
          setNotice("会话资源已重载");
        } catch (cause) { setNotice(""); setError(cause instanceof Error ? cause.message : String(cause)); }
        return true;
      case "name":
        if (!args) { setError("用法：/name <会话名称>"); return true; }
        try { await renameRemoteSession(device, selectedId, args); await refreshSessionsQuiet(device); setNotice(`已重命名为“${args}”`); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        return true;
      case "copy": {
        const messages = detailRef.current?.context.messages ?? [];
        const last = [...messages].reverse().find((message) => message.role === "assistant");
        const blocks = last && Array.isArray(last.content) ? last.content as Array<{ type?: string; text?: string }> : [];
        const textOut = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();
        if (!textOut) { setError("没有可复制的助手回复"); return true; }
        await navigator.clipboard.writeText(textOut);
        setNotice("已复制上一条助手回复");
        return true;
      }
      default:
        return false; // extension/prompt/skill commands run server-side as prompt text
    }
  }

  async function respondAsk(response: { value: string } | { confirmed: boolean } | { cancelled: true }) {
    const current = askQueue[0];
    setAskQueue((queue) => queue.slice(1));
    if (!current || !device) return;
    try {
      await sendRemoteAgentCommand(device, current.sessionId, { type: "extension_ui_response", id: current.request.id, ...response });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function changeToolPreset(preset: string) {
    if (!device || !selectedId) return;
    setModelMenu(null); setToolPreset(preset);
    const tools = TOOL_PRESETS.find((item) => item.id === preset)?.tools ?? [];
    try { await sendRemoteAgentCommand(device, selectedId, { type: "set_tools", toolNames: tools }); setNotice(`工具预设已切换为「${TOOL_PRESETS.find((item) => item.id === preset)?.label}」`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function submit() {
    if (!device || !selectedId || sending) return;
    const message = draft.trim();
    if (!message && !images.length) return;
    const attachments = images;
    updateDraft(""); setImages([]);
    if (composerRef.current) composerRef.current.style.height = "auto";
    setSending(true);
    if (message.startsWith("/") && !attachments.length && await runSlashCommand(message)) { setSending(false); return; }
    const optimisticContent: unknown[] = [
      ...attachments.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })),
      ...(message ? [{ type: "text", text: message }] : []),
    ];
    const optimistic: SessionMessage = { role: "user", content: optimisticContent.length === 1 && message ? message : optimisticContent, timestamp: Date.now(), pihubOptimistic: true };
    const current = detailRef.current;
    if (current) storeDetail(device, selectedId, { ...current, context: { ...current.context, messages: [...current.context.messages, optimistic] } });
    setRunning((value) => new Set(value).add(selectedId));
    try {
      const streamKey = remoteAgentStreamKey(device, selectedId);
      if (!streamSessionsRef.current.has(streamKey)) {
        streamSessionsRef.current.add(streamKey);
        // Streaming is a Tauri-only enhancement; a failed stream start must
        // not block sending (the polling loop keeps running state fresh).
        try {
          const generation = await startRemoteAgentStream(device, selectedId);
          streamGenerationsRef.current.set(streamKey, Math.max(generation, streamGenerationsRef.current.get(streamKey) ?? 0));
        }
        catch { streamSessionsRef.current.delete(streamKey); }
      }
      if (isRunning) await steerRemotePrompt(device, selectedId, message, attachments);
      else await sendRemotePrompt(device, selectedId, message, attachments);
    } catch (cause) {
      const streamKey = remoteAgentStreamKey(device, selectedId);
      streamSessionsRef.current.delete(streamKey);
      streamGenerationsRef.current.delete(streamKey);
      void stopRemoteAgentStream(device, selectedId);
      if (current) storeDetail(device, selectedId, current);
      setRunning((value) => { const next = new Set(value); next.delete(selectedId); return next; });
      updateDraft(message); setImages(attachments); setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { setSending(false); }
  }

  async function pickImages(files: FileList | null) {
    if (!files) return;
    const next: AttachedImage[] = [];
    for (const file of Array.from(files).slice(0, 6)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > 10 * 1024 * 1024) { setError(`图片 ${file.name} 超过 10MB 限制`); continue; }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      }).catch(() => "");
      if (data) next.push({ data, mimeType: file.type, name: file.name });
    }
    if (next.length) setImages((current) => [...current, ...next].slice(0, 6));
  }

  async function compactSession(instructions?: string) {
    if (!device || !selectedId || compactBusy) return;
    setCompactBusy(true); setError(""); setCompactResult(null);
    try {
      const before = agentState?.contextUsage?.tokens ?? null;
      await compactRemoteSession(device, selectedId, instructions);
      const state = await loadRemoteAgentState(device, selectedId).catch(() => null);
      const after = state?.state?.contextUsage?.tokens ?? null;
      if (state && selectedIdRef.current === selectedId) setAgentState(state.running ? state.state ?? null : null);
      if (before !== null && after !== null) setCompactResult({ before, after });
      await refreshDetail(device, selectedId, true);
      setNotice("上下文压缩完成");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCompactBusy(false); }
  }

  async function forkFromEntry(entryId: string) {
    if (!device || !selectedId || forkingId) return;
    setForkingId(entryId); setError("");
    try {
      const result = await forkRemoteSession(device, selectedId, entryId);
      if (result.newSessionId) {
        const streamKey = remoteAgentStreamKey(device, selectedId);
        streamSessionsRef.current.delete(streamKey);
        streamGenerationsRef.current.delete(streamKey);
        void stopRemoteAgentStream(device, selectedId);
        await refreshSessions(device);
        setSelectedId(result.newSessionId);
        setNotice("已从该消息分叉出新会话");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setForkingId(""); }
  }

  async function navigateBranch(targetId: string) {
    if (!device || !selectedId) return;
    setError("");
    try {
      await navigateRemoteTree(device, selectedId, targetId);
      hydratedSessionsRef.current.add(cacheKey(device.id, selectedId));
      await refreshDetail(device, selectedId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function renameSession(id: string) {
    if (!device) return;
    const target = sessions.find((session) => session.id === id);
    setNamePrompt({
      title: "重命名会话",
      initial: target?.name || target?.firstMessage || "",
      onSubmit: (name) => {
        setNamePrompt(null);
        void (async () => {
          try { await renameRemoteSession(device, id, name); await refreshSessionsQuiet(device); }
          catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        })();
      },
    });
  }

  function deleteSession(id: string) {
    if (!device) return;
    const target = sessions.find((session) => session.id === id);
    setConfirmAction({
      title: `删除会话“${target?.name || target?.firstMessage || "未命名会话"}”？`,
      message: "远端会话文件将被删除，子会话会重新挂载到父会话。",
      confirmLabel: "删除", danger: true,
      onConfirm: () => {
        setConfirmAction(null);
        void (async () => {
          try {
            await deleteRemoteSession(device, id);
            const streamKey = remoteAgentStreamKey(device, id);
            streamSessionsRef.current.delete(streamKey);
            streamGenerationsRef.current.delete(streamKey);
            void stopRemoteAgentStream(device, id);
            pendingSessionsRef.current.delete(id);
            draftsRef.current.delete(cacheKey(device.id, id));
            await deleteCachedSession(cacheKey(device.id, id));
            closeTab(id);
            await refreshSessionsQuiet(device);
          } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        })();
      },
    });
  }

  async function duplicateSession(id: string) {
    if (!device) return;
    setRowMenu(null); setError("");
    try {
      const detail = await loadRemoteSession(device, id, 1);
      const lastEntry = detail.context.entryIds.at(-1);
      if (!lastEntry) { setError("空会话无法复制"); return; }
      const result = await forkRemoteSession(device, id, lastEntry);
      if (result.newSessionId) {
        await refreshSessionsQuiet(device);
        setSelectedId(result.newSessionId);
        setNotice("已复制会话");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function autoNameSession() {
    if (!device || !selectedId) return;
    setSessionMenu(false); setError(""); setNotice("正在生成会话标题…");
    try {
      const result = await autoNameRemoteSession(device, selectedId);
      await refreshSessionsQuiet(device);
      setNotice(`已命名为“${result.title}”`);
    } catch (cause) { setNotice(""); setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function exportSession() {
    if (!device || !selectedId) return;
    setSessionMenu(false); setError("");
    try {
      const path = await exportRemoteSession(device, selectedId, selected?.name || "session");
      setNotice(path ? `已导出到 ${path}` : "已在浏览器中打开导出页面");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function loadOlderMessages() {
    if (!device || !selectedId || !detail || loadingOlder) return;
    const shown = detail.context.messages.length;
    const total = detail.context.totalMessages ?? shown;
    setLoadingOlder(true);
    try { await refreshDetail(device, selectedId, true, Math.min(total, Math.max(shown * 2, 80))); }
    finally { setLoadingOlder(false); }
  }

  async function changeModel(provider: string, modelId: string) {
    if (!device || !selectedId || !detail) return;
    setModelMenu(null);
    try {
      await sendRemoteAgentCommand(device, selectedId, { type: "set_model", provider, modelId });
      storeDetail(device, selectedId, { ...detail, context: { ...detail.context, model: { provider, modelId } } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function changeThinking(level: string) {
    if (!device || !selectedId || !detail) return;
    setModelMenu(null);
    try {
      await sendRemoteAgentCommand(device, selectedId, { type: "set_thinking_level", level });
      storeDetail(device, selectedId, { ...detail, context: { ...detail.context, thinkingLevel: level } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function createSessionAt(cwd: string) {
    if (!device) return;
    const result = await createRemoteSession(device, cwd);
    pendingSessionsRef.current.set(result.sessionId, { id: result.sessionId, cwd, created: new Date().toISOString(), modified: new Date().toISOString(), messageCount: 0, firstMessage: "", transient: true });
    await refreshSessions(device);
    setSelectedId(result.sessionId);
  }

  async function createSession() {
    const cwd = selected?.cwd ?? sessions[0]?.cwd;
    if (!device || !cwd || creatingSession) {
      if (!cwd) setError("请先选择一个现有项目，再在该项目中新建会话");
      return;
    }
    setCreatingSession(true);
    try { await createSessionAt(cwd); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCreatingSession(false); }
  }

  async function openWorktree(target: RemoteWorktree) {
    if (!device || worktreeBusy) return;
    setWorktreeMenu(false); setWorktreeBusy(target.path); setWorktreeError("");
    try {
      await createSessionAt(target.path);
      setNotice(`已在 ${target.branch || target.path} 中开始新会话`);
      setError("");
    } catch (cause) {
      const message = workspaceOperationError(cause);
      setWorktreeError(message); setError(message);
    } finally { setWorktreeBusy(""); }
  }

  async function addWorktree(branch: string) {
    if (!device || !selected?.cwd || worktreeBusy) return;
    setWorktreePrompt(false); setWorktreeBusy("create"); setWorktreeError("");
    try {
      const created = await createRemoteWorktree(device, selected.cwd, branch);
      await refreshWorktrees(device, selected.cwd);
      await createSessionAt(created.path);
      setNotice(`已创建并打开 worktree：${created.branch}`);
      setError("");
    } catch (cause) {
      const message = workspaceOperationError(cause);
      setWorktreeError(message); setError(message);
    } finally { setWorktreeBusy(""); }
  }

  async function removeWorktree(target: RemoteWorktree, force = false) {
    if (!device || !selected?.cwd || worktreeBusy) return;
    setWorktreeRemoving(null); setWorktreeBusy(`delete:${target.path}`); setWorktreeError("");
    try {
      await deleteRemoteWorktree(device, selected.cwd, target.path, force);
      await refreshWorktrees(device, selected.cwd);
      setNotice(`已移除 worktree：${target.branch || target.path}`);
      setError("");
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause);
      if (!force && /uncommitted changes|is dirty|modified or untracked/i.test(raw)) {
        setConfirmAction({
          title: `强制移除 worktree“${target.branch || target.path}”？`,
          message: "该 checkout 包含未提交或未跟踪的文件。强制移除会永久丢弃这些改动，但不会删除 Git 分支。",
          confirmLabel: "强制移除", danger: true,
          onConfirm: () => { setConfirmAction(null); void removeWorktree(target, true); },
        });
      } else {
        const message = workspaceOperationError(cause);
        setWorktreeError(message); setError(message);
      }
    } finally { setWorktreeBusy(""); }
  }

  function closeTab(id: string) {
    setOpenTabs((current) => {
      const index = current.indexOf(id); const next = current.filter((item) => item !== id);
      if (selectedId === id) setSelectedId(next[Math.min(index, next.length - 1)] ?? null);
      return next;
    });
  }

  function handleToolTabKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = TOOL_TABS.indexOf(toolTab);
    const next = event.key === "Home" ? TOOL_TABS[0]
      : event.key === "End" ? TOOL_TABS.at(-1)!
        : TOOL_TABS[(index + (event.key === "ArrowRight" ? 1 : -1) + TOOL_TABS.length) % TOOL_TABS.length];
    setToolTab(next);
    requestAnimationFrame(() => document.getElementById(`tool-tab-${next}`)?.focus());
  }

  if (loading) return <div className="workspace-loading"><LoaderCircle className="spin" /><span>正在连接设备…</span></div>;

  return <div className={`workspace-shell ${leftOpen ? "" : "left-closed"} ${rightOpen ? "" : "right-closed"} ${fullscreen ? "native-fullscreen" : ""}`} style={{ "--left-w": `${leftWidth}px`, "--right-w": `${rightWidth}px` } as React.CSSProperties}>
    <header className="workspace-titlebar" data-tauri-drag-region onMouseDown={(event) => { if (event.button === 0 && !(event.target as HTMLElement).closest("button") && isTauriEnvironment()) void startDesktopWindowDragging(); }}>
      <div className="titlebar-left-actions"><span className="mac-traffic-gap" /></div>
      <div className="workspace-device"><span className="device-live" /><strong>{device?.name || "未知设备"}</strong><span>{device?.host}</span></div>
      <div className="workspace-window-actions">
        <button onClick={() => setDark(!dark)} title={dark ? "切换为浅色" : "切换为深色"} aria-label={dark ? "切换为浅色" : "切换为深色"}>{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
        <button title="设备设置" aria-label="设备设置" onClick={() => setSetupOpen(true)}><Settings2 size={16} /></button>
      </div>
    </header>

    <aside className="workspace-sidebar" aria-label="项目与会话" aria-hidden={!leftOpen} inert={!leftOpen ? true : undefined}>
      <div className="sidebar-top">
        <div className="workspace-logo"><span>π</span><b>PiHub</b></div>
        <div className="sidebar-create-actions"><button className="new-chat" title="在当前项目中新建会话" aria-label="在当前项目中新建会话" onClick={() => void createSession()} disabled={creatingSession}>{creatingSession ? <LoaderCircle className="spin" size={14} /> : <Plus size={16} />}</button><button className="new-chat" title="选择文件夹并开始会话" aria-label="选择文件夹并开始会话" onClick={() => setFolderPicker(true)}><FolderPlus size={15} /></button><button className="new-chat" title="收起会话侧栏" aria-label="收起会话侧栏" onClick={() => setLeftOpen(false)}><PanelLeftClose size={15} /></button></div>
      </div>
      <label className="workspace-search"><Search size={14} /><input ref={searchRef} aria-label="搜索项目与会话" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目与会话" /></label>
      <div className="project-tree">
        {filteredProjects.map((project) => <section className="project-group" key={project.root}>
          <button className="project-heading" onClick={() => setCollapsedGroups((current) => ({ ...current, [project.root]: !current[project.root] }))} aria-expanded={!collapsedGroups[project.root]}>
            {collapsedGroups[project.root] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<FolderGit2 size={14} /><strong>{project.name}</strong><span>{project.sessions.length}</span>
          </button>
          {!collapsedGroups[project.root] && project.sessions.map((session) => <div key={session.id} className={`session-row popover-root ${selectedId === session.id ? "selected" : ""}`} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); openRowMenu(session.id, event.clientX, event.clientY); }}>
            <button type="button" className="session-row-main" onClick={() => setSelectedId(session.id)} aria-current={selectedId === session.id ? "page" : undefined}>
              <span className={`session-activity ${running.has(session.id) ? "running" : ""}`} />
              <span className="session-copy"><strong>{session.name || session.firstMessage || "未命名会话"}</strong><small>{relativeTime(session.modified)} · {session.messageCount} 条消息</small></span>
              {doneIds.has(session.id) && <span className="done-dot" title="有已完成的运行" />}
            </button>
            <button className="row-menu-button" aria-label="会话菜单" onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); if (rowMenu?.id === session.id) setRowMenu(null); else openRowMenu(session.id, rect.right - 160, rect.bottom); }}><MoreHorizontal size={14} /></button>
          </div>)}
        </section>)}
        {!filteredProjects.length && <div className="project-empty"><MessageSquareText size={22} /><strong>{query ? "没有匹配结果" : "还没有会话"}</strong><span>{query ? "换个关键词试试" : "选择一个文件夹开始第一次会话"}</span>{!query && <button onClick={() => setFolderPicker(true)}><FolderPlus size={13} />新建项目</button>}</div>}
      </div>
      <div className="sidebar-footer"><HardDrive size={14} /><span>通过 Tailscale 连接</span><Wifi size={13} /></div>
    </aside>

    {rowMenu && <div className="session-menu row-menu popover-root" style={{ left: rowMenu.x, top: rowMenu.y }} onClick={(event) => event.stopPropagation()}>
      <button onClick={() => { setRowMenu(null); setSelectedId(rowMenu.id); }}><MessageSquareText size={13} />打开会话</button>
      <button onClick={() => { setRowMenu(null); void renameSession(rowMenu.id); }}><Pencil size={13} />重命名</button>
      <button onClick={() => void duplicateSession(rowMenu.id)}><Copy size={13} />复制会话</button>
      <button className="danger" onClick={() => { setRowMenu(null); void deleteSession(rowMenu.id); }}><Trash2 size={13} />删除</button>
    </div>}

    <main className="conversation-pane">
      <nav className="session-tabs" aria-label="打开的会话">{openTabs.map((id) => { const item = sessions.find((session) => session.id === id); if (!item) return null; const label = item.name || item.firstMessage || "新会话"; return <div key={id} className={`session-tab ${selectedId === id ? "active" : ""}`}><button type="button" className="session-tab-select" aria-current={selectedId === id ? "page" : undefined} onClick={() => setSelectedId(id)} title={label}><span className={`session-activity ${running.has(id) ? "running" : ""}`} /><span>{label}</span>{doneIds.has(id) && <span className="done-dot" />}</button><button type="button" className="session-tab-close" aria-label={`关闭标签：${label}`} onClick={() => closeTab(id)}><X size={11} /></button></div>; })}</nav>
      <div className="conversation-toolbar">
        <div><MessageSquareText size={16} /><h1>{selected?.name || selected?.firstMessage || "选择一个会话"}</h1>{worktrees?.isGit && selected && <WorktreeControl state={worktrees} cwd={selected.cwd} open={worktreeMenu} busy={worktreeBusy} error={worktreeError} onToggle={() => setWorktreeMenu(!worktreeMenu)} onOpen={(target) => void openWorktree(target)} onCreate={() => { setWorktreeMenu(false); setWorktreePrompt(true); }} onRemove={(target) => { setWorktreeMenu(false); setWorktreeRemoving(target); }} />}{!worktrees?.isGit && selected?.worktreeBranch && <span className="branch-chip"><GitBranch size={11} />{selected.worktreeBranch}</span>}</div>
        <div>
          <span className={`run-chip ${isCompacting ? "compacting" : isRunning ? "active" : ""}`}><Circle size={8} fill="currentColor" />{isCompacting ? "压缩中" : isRunning ? "运行中" : "空闲"}</span>
          {branches.length > 1 && <BranchSwitch branches={branches} onNavigate={(id) => void navigateBranch(id)} />}
          {(stats || contextUsage) && <SessionStats stats={stats} contextUsage={contextUsage} detail={detail} selected={selected} open={statsOpen} onToggle={() => setStatsOpen(!statsOpen)} />}
          <button onClick={() => device && void refreshSessions(device)} title="刷新会话列表" aria-label="刷新会话列表"><RefreshCw size={15} /></button>
          <span className="popover-root session-menu-anchor">
            <button title="会话操作" aria-label="会话操作" aria-expanded={sessionMenu} onClick={() => setSessionMenu(!sessionMenu)}><MoreHorizontal size={16} /></button>
            {sessionMenu && <div className="session-menu">
              <button onClick={() => { setSessionMenu(false); if (selectedId) void renameSession(selectedId); }}><Pencil size={13} />重命名会话</button>
              <button onClick={() => void autoNameSession()}><Sparkles size={13} />AI 自动命名</button>
              <button onClick={() => void exportSession()}><FileDown size={13} />导出 HTML</button>
              <button className="danger" onClick={() => { setSessionMenu(false); if (selectedId) void deleteSession(selectedId); }}><Trash2 size={13} />删除会话</button>
            </div>}
          </span>
        </div>
      </div>

      {error && <div className="workspace-error" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="关闭错误提示"><X size={14} /></button></div>}
      {notice && <div className="workspace-notice" role="status"><Check size={13} /><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭"><X size={13} /></button></div>}
      <div className="message-area">
        <div className="message-scroll" ref={messageScrollRef} onScroll={(event) => { const el = event.currentTarget; if (selectedIdRef.current) scrollPositionsRef.current.set(selectedIdRef.current, el.scrollTop); setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 320); }}>
          {detail?.context.truncated && <button className="load-older" onClick={() => void loadOlderMessages()} disabled={loadingOlder}>{loadingOlder ? <LoaderCircle className="spin" size={13} /> : <ChevronDown size={13} />}加载更早消息（当前 {detail.context.messages.length}/{detail.context.totalMessages}）</button>}
          {detailLoading && !detail ? <div className="conversation-empty"><LoaderCircle className="spin" />加载最近消息…</div> : detail?.context.messages.length ? <ConversationMessages messages={detail.context.messages} entryIds={detail.context.entryIds} onFork={(entryId) => void forkFromEntry(entryId)} forkingId={forkingId || undefined} onLoadThinking={device && selectedId ? (entryId, blockIndex) => loadRemoteThinking(device, selectedId, entryId, blockIndex) : undefined} /> : <div className="conversation-empty"><Bot size={34} /><h3>准备开始</h3><p>从左侧选择会话，或创建一个新的工作会话。</p></div>}
        </div>
        {detail && <ChatMinimap messages={detail.context.messages} scrollRef={messageScrollRef} />}
      </div>
      {showJump && <button className="jump-bottom" onClick={() => { const el = messageScrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }}><ArrowDown size={13} />回到底部</button>}

      <div className="composer-wrap">
        {askQueue.length > 0 && <AskCard entry={askQueue[0]} sessionName={askQueue[0].sessionId !== selectedId ? sessions.find((session) => session.id === askQueue[0].sessionId)?.name : undefined} onRespond={(response) => void respondAsk(response)} />}
        {compactResult && <div className="compact-result"><Scissors size={12} /><span>上下文已压缩：{formatCompact(compactResult.before)} → {formatCompact(compactResult.after)} tokens（节省 {formatCompact(Math.max(0, compactResult.before - compactResult.after))}）</span><button onClick={() => setCompactResult(null)} aria-label="关闭"><X size={12} /></button></div>}
        {images.length > 0 && <div className="image-attachments">{images.map((image, index) => <span key={index} className="image-attachment"><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} /><button onClick={() => setImages((current) => current.filter((_, i) => i !== index))} aria-label="移除图片"><X size={11} /></button></span>)}</div>}
        <div className="composer">
          <textarea ref={composerRef} aria-label="消息输入" value={draft} onFocus={() => setModelMenu(null)} onCompositionStart={() => { imeComposingRef.current = true; }} onCompositionEnd={() => { imeComposingRef.current = false; imeEndedAtRef.current = Date.now(); }} onChange={(event) => { updateDraft(event.target.value); setSlashDismissed(false); setSlashIndex(0); event.currentTarget.style.height = "auto"; event.currentTarget.style.height = `${Math.min(128, event.currentTarget.scrollHeight)}px`; }} onKeyDown={(event) => {
            if (slashOpen) {
              if (event.key === "ArrowDown") { event.preventDefault(); setSlashIndex((slashIndex + 1) % slashItems.length); return; }
              if (event.key === "ArrowUp") { event.preventDefault(); setSlashIndex((slashIndex - 1 + slashItems.length) % slashItems.length); return; }
              if (event.key === "Tab") { event.preventDefault(); applySlash(slashItems[slashIndex]); return; }
              if (event.key === "Escape") { event.preventDefault(); setSlashDismissed(true); return; }
            }
            // WKWebView fires the IME-confirming Enter with isComposing=false —
            // also suppress Enter shortly after compositionend.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !imeComposingRef.current && Date.now() - imeEndedAtRef.current > 120) {
              event.preventDefault();
              if (slashOpen && slashItems[slashIndex] && draft !== `/${slashItems[slashIndex].name}`) { applySlash(slashItems[slashIndex]); return; }
              void submit();
            }
          }} placeholder={selectedId ? (isRunning ? "插话：打断当前生成并立即插入…" : detailLoading ? "会话加载中，也可以先输入消息…" : "继续这个会话…") : "请先选择会话"} disabled={!selectedId} />
          {slashOpen && <div className="composer-menu slash-menu">{slashItems.map((item, index) => <button key={`${item.source ?? "builtin"}-${item.name}`} className={index === slashIndex ? "active" : ""} onMouseDown={(event) => { event.preventDefault(); applySlash(item); }}><span>/{item.name}</span><small>{item.description || item.source || ""}</small></button>)}</div>}
          <div className="composer-toolbar"><div className="composer-selects popover-root" ref={composerSelectRef}><button className="model-pill" aria-label="选择模型" aria-expanded={modelMenu === "model"} onClick={() => setModelMenu(modelMenu === "model" ? null : "model")}><Bot size={14} />{detail?.context.model?.modelId || "默认模型"}<ChevronDown size={11} /></button><button className="thinking-pill" aria-label="选择思考强度" aria-expanded={modelMenu === "thinking"} onClick={() => setModelMenu(modelMenu === "thinking" ? null : "thinking")}>{thinkingLabel(detail?.context.thinkingLevel)}<ChevronDown size={11} /></button><button className="thinking-pill" title="工具预设" aria-label="选择工具预设" aria-expanded={modelMenu === "tools"} onClick={() => setModelMenu(modelMenu === "tools" ? null : "tools")}><Wrench size={11} />{TOOL_PRESETS.find((item) => item.id === toolPreset)?.label ?? "默认"}<ChevronDown size={11} /></button>{modelMenu === "tools" && <div className="composer-menu thinking-menu tools-menu">{TOOL_PRESETS.map((preset) => <button key={preset.id} className={toolPreset === preset.id ? "active" : ""} onClick={() => void changeToolPreset(preset.id)}>{preset.label}<small>{preset.tools.length ? preset.tools.join(" ") : "停用全部工具"}</small></button>)}</div>}{modelMenu === "model" && <div className="composer-menu model-menu">{models?.modelList.map((item) => <button key={`${item.provider}/${item.id}`} className={detail?.context.model?.provider === item.provider && detail.context.model.modelId === item.id ? "active" : ""} onClick={() => void changeModel(item.provider, item.id)}><span>{item.name || item.id}</span><small>{item.provider}/{item.id}</small></button>)}<button className="manage-models" onClick={() => { setModelMenu(null); setModelsConfigOpen(true); }}><Settings2 size={13} />管理模型配置…</button></div>}{modelMenu === "thinking" && <div className="composer-menu thinking-menu">{thinkingOptions(models, detail).map((level) => <button key={level} className={detail?.context.thinkingLevel === level ? "active" : ""} onClick={() => void changeThinking(level)}>{thinkingLabel(level)}</button>)}</div>}</div><div className="composer-actions"><input ref={filePickRef} type="file" accept="image/*" multiple hidden onChange={(event) => { void pickImages(event.target.files); event.currentTarget.value = ""; }} /><button className="composer-tool" title="添加图片" aria-label="添加图片" onClick={() => filePickRef.current?.click()} disabled={!selectedId}><ImagePlus size={14} /></button><button className="composer-tool" title={isCompacting ? "正在压缩上下文…" : "压缩上下文（Compact）"} aria-label="压缩上下文" onClick={() => void compactSession()} disabled={!selectedId || isCompacting}>{compactBusy ? <LoaderCircle className="spin" size={14} /> : <Scissors size={14} />}</button><button className="composer-tool" title={soundOn ? "关闭完成提示音" : "开启完成提示音"} aria-label="提示音开关" onClick={() => { const next = !soundOn; setSoundOn(next); localStorage.setItem("pihub-sound", next ? "1" : "0"); }}>{soundOn ? <Volume2 size={14} /> : <VolumeX size={14} />}</button></div>{isRunning ? <button className="stop-button" aria-label="停止运行" onClick={async () => { if (!device || !selectedId) return; try { await stopRemoteAgent(device, selectedId); setRunning((current) => { const next = new Set(current); next.delete(selectedId); return next; }); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}><Square size={12} fill="currentColor" /></button> : null}<button className="send-button" aria-label={isRunning ? "插话" : "发送消息"} title={isRunning ? "插话：打断当前生成" : "发送"} onClick={() => void submit()} disabled={(!draft.trim() && !images.length) || sending || !selectedId}>{sending ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}</button></div>
        </div>
        <small>Enter 发送 · Shift + Enter 换行 · 数据保留在远程设备</small>
      </div>
    </main>

    <aside className="tool-pane" aria-label="工作区工具" aria-hidden={!rightOpen} inert={!rightOpen ? true : undefined}>
      <div className="tool-tabs">
        <div className="tool-tablist" role="tablist" aria-label="工作区工具" onKeyDown={handleToolTabKey}>
          <button id="tool-tab-files" role="tab" aria-label="文件" title="文件" aria-controls="workspace-tool-panel" aria-selected={toolTab === "files"} tabIndex={toolTab === "files" ? 0 : -1} className={toolTab === "files" ? "active" : ""} onClick={() => setToolTab("files")}><Files size={15} /><span className="tool-tab-label">文件</span></button>
          <button id="tool-tab-git" role="tab" aria-label="Git" title="Git" aria-controls="workspace-tool-panel" aria-selected={toolTab === "git"} tabIndex={toolTab === "git" ? 0 : -1} className={toolTab === "git" ? "active" : ""} onClick={() => setToolTab("git")}><GitBranch size={15} /><span className="tool-tab-label">Git</span></button>
          <button id="tool-tab-terminal" role="tab" aria-label="终端" title="终端" aria-controls="workspace-tool-panel" aria-selected={toolTab === "terminal"} tabIndex={toolTab === "terminal" ? 0 : -1} className={toolTab === "terminal" ? "active" : ""} onClick={() => setToolTab("terminal")}><TerminalSquare size={15} /><span className="tool-tab-label">终端</span></button>
          <button id="tool-tab-resources" role="tab" aria-label="资源" title="资源" aria-controls="workspace-tool-panel" aria-selected={toolTab === "resources"} tabIndex={toolTab === "resources" ? 0 : -1} className={toolTab === "resources" ? "active" : ""} onClick={() => setToolTab("resources")}><Package size={15} /><span className="tool-tab-label">资源</span></button>
        </div>
        <span className="tool-tabs-spacer" /><button className="new-chat tool-collapse" onClick={() => setRightOpen(false)} title="收起工具面板" aria-label="收起工具面板"><PanelRightClose size={14} /></button>
      </div>
      {rightOpen && <div className="tool-panel-content" id="workspace-tool-panel" role="tabpanel" aria-labelledby={`tool-tab-${toolTab}`}>{toolTab === "resources" ? <ResourceManager session={selected} device={device} /> : <ToolPanel tab={toolTab} session={selected} device={device} />}</div>}
    </aside>
    {!leftOpen && <button className="edge-toggle left" onClick={() => setLeftOpen(true)} title="展开会话侧栏" aria-label="展开会话侧栏"><ChevronRight size={13} /></button>}
    {!rightOpen && <button className="edge-toggle right" onClick={() => setRightOpen(true)} title="展开工具面板" aria-label="展开工具面板"><ChevronLeft size={13} /></button>}
    {leftOpen && <div className="col-resize left" onMouseDown={startColumnDrag("left")} title="拖动调整侧栏宽度" />}
    {rightOpen && <div className="col-resize right" onMouseDown={startColumnDrag("right")} title="拖动调整面板宽度" />}
    {folderPicker && device && <FolderSessionModal device={device} initialPath={selected?.cwd} onClose={() => setFolderPicker(false)} onCreated={async (sessionId, cwd) => { pendingSessionsRef.current.set(sessionId, { id: sessionId, cwd, created: new Date().toISOString(), modified: new Date().toISOString(), messageCount: 0, firstMessage: "", transient: true }); setFolderPicker(false); await refreshSessions(device); setSelectedId(sessionId); }} />}
    {setupOpen && device && <DeviceSetup device={device} cwd={selected?.cwd} onClose={() => setSetupOpen(false)} />}
    {modelsConfigOpen && device && <ModelsConfigModal device={device} cwd={selected?.cwd || ""} onClose={() => setModelsConfigOpen(false)} onSaved={() => selected?.cwd && loadRemoteModels(device, selected.cwd).then(setModels)} />}
    {worktreePrompt && <NamePromptDialog title="新建 Git worktree" initial="" submitLabel="创建并打开" onSubmit={(branch) => void addWorktree(branch)} onClose={() => setWorktreePrompt(false)} />}
    {worktreeRemoving && <ConfirmDialog title={`移除 worktree“${worktreeRemoving.branch || worktreeRemoving.path}”？`} message="将删除这个 checkout 目录；Git 分支和历史会话会保留。未提交改动存在时，服务端会拒绝并要求再次确认。" confirmLabel="移除 worktree" danger onConfirm={() => void removeWorktree(worktreeRemoving)} onClose={() => setWorktreeRemoving(null)} />}
    {namePrompt && <NamePromptDialog title={namePrompt.title} initial={namePrompt.initial} onSubmit={namePrompt.onSubmit} onClose={() => setNamePrompt(null)} />}
    {confirmAction && <ConfirmDialog title={confirmAction.title} message={confirmAction.message} confirmLabel={confirmAction.confirmLabel} danger={confirmAction.danger} onConfirm={confirmAction.onConfirm} onClose={() => setConfirmAction(null)} />}
  </div>;
}

function applyAgentEvent(
  device: Device,
  sessionId: string,
  event: Record<string, unknown>,
  store: (device: Device, sessionId: string, detail: SessionDetail) => void,
  setRunning: React.Dispatch<React.SetStateAction<Set<string>>>,
  streamSessions: Set<string>,
  extras: { onSettled?: (sessionId: string) => void; onUiRequest?: (sessionId: string, request: RemoteUiRequest) => void } = {},
) {
  const current = peekSession(cacheKey(device.id, sessionId));
  const type = String(event.type || "");
  if (type === "extension_ui_request") {
    extras.onUiRequest?.(sessionId, event as unknown as RemoteUiRequest);
    return;
  }
  if (type === "connected" || type === "agent_start") {
    if (event.isStreaming === true || type === "agent_start") setRunning((value) => new Set(value).add(sessionId));
    return;
  }
  if (type === "stream_error") {
    streamSessions.delete(remoteAgentStreamKey(device, sessionId));
    return;
  }
  if (type === "prompt_error") {
    const message = String(event.errorMessage || event.error || "远端会话返回错误");
    if (current) store(device, sessionId, { ...current, context: { ...current.context, messages: [...current.context.messages, { role: "custom", customType: "stream_error", content: message, timestamp: Date.now() }] } });
    setRunning((value) => { const next = new Set(value); next.delete(sessionId); return next; });
    return;
  }
  if (type === "prompt_done" || type === "agent_settled") {
    setRunning((value) => { const next = new Set(value); next.delete(sessionId); return next; });
    streamSessions.delete(remoteAgentStreamKey(device, sessionId));
    void stopRemoteAgentStream(device, sessionId);
    extras.onSettled?.(sessionId);
    return;
  }
  if (!current) return;
  const messages = [...current.context.messages];
  if (type === "message_start") {
    const message = event.message as SessionMessage | undefined;
    if (message?.role === "assistant") {
      const index = messages.findIndex((item) => item.pihubStreaming === true);
      const streaming = { ...normalizeStreamedMessage(message), pihubStreaming: true };
      if (index >= 0) messages[index] = streaming; else messages.push(streaming);
    }
  } else if (type === "message_update") {
    const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (delta) applyStreamingDelta(messages, delta);
  } else if (type === "message_end") {
    const raw = event.message as SessionMessage | undefined;
    if (!raw) return;
    const message = normalizeStreamedMessage(raw);
    if (message.role === "user") {
      const optimistic = messages.findIndex((item) => item.pihubOptimistic === true);
      if (optimistic >= 0) messages[optimistic] = message; else messages.push(message);
    } else if (message.role === "assistant") {
      const streaming = messages.findIndex((item) => item.pihubStreaming === true);
      if (streaming >= 0) messages[streaming] = message; else messages.push(message);
    } else messages.push(message);
  } else return;
  store(device, sessionId, { ...current, context: { ...current.context, messages, totalMessages: Math.max(current.context.totalMessages ?? 0, messages.length) } });
}

function normalizeStreamedMessage(message: SessionMessage): SessionMessage {
  // SSE payloads carry pi's raw block fields (id/name/arguments); the renderer
  // expects the normalized shape (toolCallId/toolName/input), same as the
  // server's normalizeToolCalls() does for file loads and the web client.
  if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
  const content = (message.content as Record<string, unknown>[]).map((block) => {
    if (!block || typeof block !== "object" || block.type !== "toolCall") return block;
    return {
      type: "toolCall",
      toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
      toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
      input: block.input && typeof block.input === "object" && !Array.isArray(block.input)
        ? block.input
        : (block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments) ? block.arguments : {}),
    };
  });
  return { ...message, content };
}

function applyStreamingDelta(messages: SessionMessage[], delta: Record<string, unknown>) {
  let index = messages.findIndex((item) => item.pihubStreaming === true);
  if (index < 0) {
    messages.push({ role: "assistant", content: [], timestamp: Date.now(), pihubStreaming: true });
    index = messages.length - 1;
  }
  const message = messages[index];
  const content = Array.isArray(message.content) ? [...message.content] as Record<string, unknown>[] : [];
  const contentIndex = Number(delta.contentIndex);
  if (!Number.isInteger(contentIndex) || contentIndex < 0) return;
  const current = content[contentIndex];
  if (delta.type === "text_start") content[contentIndex] = current?.type === "text" ? current : { type: "text", text: "" };
  else if (delta.type === "text_delta" && current?.type === "text") content[contentIndex] = { ...current, text: String(current.text || "") + String(delta.delta || "") };
  else if (delta.type === "text_end") content[contentIndex] = { type: "text", text: String(delta.content || "") };
  else if (delta.type === "thinking_start") content[contentIndex] = current?.type === "thinking" ? current : { type: "thinking", thinking: "" };
  else if (delta.type === "thinking_delta" && current?.type === "thinking") content[contentIndex] = { ...current, thinking: String(current.thinking || "") + String(delta.delta || "") };
  else if (delta.type === "thinking_end") content[contentIndex] = { type: "thinking", thinking: String(delta.content || "") };
  else if (delta.type === "toolcall_start") content[contentIndex] = { type: "toolCall", toolCallId: String(delta.id || ""), toolName: String(delta.toolName || "工具"), rawInput: "", input: {} };
  else if (delta.type === "toolcall_delta" && current?.type === "toolCall") content[contentIndex] = { ...current, rawInput: String(current.rawInput || "") + String(delta.delta || "") };
  else if (delta.type === "toolcall_end" && delta.toolCall && typeof delta.toolCall === "object") {
    const tool = delta.toolCall as Record<string, unknown>;
    content[contentIndex] = { type: "toolCall", toolCallId: String(tool.id || ""), toolName: String(tool.name || "工具"), input: tool.arguments ?? {} };
  } else return;
  messages[index] = { ...message, content };
}

function thinkingOptions(models: RemoteModelsResponse | null, detail: SessionDetail | null): string[] {
  const model = detail?.context.model;
  if (!model) return ["off", "low", "medium", "high"];
  return models?.thinkingLevels[`${model.provider}:${model.modelId}`] ?? ["off", "low", "medium", "high"];
}

function ModelsConfigModal({ device, cwd, onClose, onSaved }: { device: Device; cwd: string; onClose: () => void; onSaved: () => void }) {
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  const [text, setText] = useState("");
  const [tab, setTab] = useState<"newapi" | "advanced">("newapi");
  const [newApi, setNewApi] = useState<RemoteNewApiConfig | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [affinity, setAffinity] = useState(true);
  const [busy, setBusy] = useState(true);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void Promise.all([loadRemoteModelsConfig(device), loadRemoteNewApi(device)]).then(([modelsConfig, newApiConfig]) => {
      setText(JSON.stringify(modelsConfig, null, 2)); setNewApi(newApiConfig); setAffinity(newApiConfig.settings.sendSessionAffinityHeaders);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
  }, [device]);
  async function saveAdvanced() {
    setBusy(true); setError("");
    try {
      const config = JSON.parse(text) as Record<string, unknown>;
      await saveRemoteModelsConfig(device, config); onSaved(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  }
  function beginEdit(provider?: RemoteNewApiConfig["providers"][number]) {
    setEditing(provider?.name ?? ""); setName(provider?.name ?? ""); setBaseUrl(provider?.baseUrl ?? ""); setApiKey(""); setError("");
  }
  async function saveProvider() {
    setBusy(true); setError("");
    try {
      const next = await saveRemoteNewApiProvider(device, { name, baseUrl, ...(apiKey.trim() ? { apiKey } : {}), sendSessionAffinityHeaders: affinity });
      setNewApi(next); setEditing(null); setApiKey(""); onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  async function refreshProvider(providerName: string) {
    setBusy(true); setError("");
    try { const next = await refreshRemoteNewApiProvider(device, providerName, cwd); setNewApi(next); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  function removeProvider(providerName: string) {
    setRemoveTarget(providerName);
  }
  async function confirmRemoveProvider() {
    if (!removeTarget) return;
    const providerName = removeTarget;
    setRemoveTarget(null);
    setBusy(true); setError("");
    try { setNewApi(await deleteRemoteNewApiProvider(device, providerName)); onSaved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop models-config-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialogRef} className="models-config-modal" role="dialog" aria-modal="true" aria-label="模型配置"><header><div><h2>模型配置</h2><p>{device.name} · API Key 仅保存在远端 Pi 凭据库</p></div><button onClick={onClose} aria-label="关闭模型配置"><X size={16} /></button></header><nav className="models-config-tabs" role="tablist" aria-label="模型配置视图"><button role="tab" aria-selected={tab === "newapi"} className={tab === "newapi" ? "active" : ""} onClick={() => setTab("newapi")}>NewAPI 网关</button><button role="tab" aria-selected={tab === "advanced"} className={tab === "advanced" ? "active" : ""} onClick={() => setTab("advanced")}>高级 JSON</button></nav>{busy && !newApi ? <div className="models-config-loading" role="status"><LoaderCircle className="spin" />读取配置…</div> : tab === "advanced" ? <textarea aria-label="高级模型 JSON 配置" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} /> : <div className="newapi-config"><div className="newapi-head"><label><input type="checkbox" checked={affinity} onChange={(event) => setAffinity(event.target.checked)} />启用会话亲和，提高网关缓存命中率</label><button onClick={() => beginEdit()}>添加网关</button></div>{editing !== null && <div className="newapi-form"><label>Provider ID<input value={name} onChange={(event) => setName(event.target.value)} disabled={editing !== ""} placeholder="newapi" /></label><label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com" /></label><label>API Key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={editing ? "留空则保持原凭据" : "输入远端网关 API Key"} /></label><div><button onClick={() => setEditing(null)}>取消</button><button className="primary-newapi" disabled={busy || !name.trim() || !baseUrl.trim()} onClick={() => void saveProvider()}>保存网关</button></div></div>}<div className="newapi-list">{newApi?.providers.map((provider) => <article key={provider.name}><div><strong>{provider.name}</strong><span>{provider.baseUrl}</span><small>{provider.authenticated ? "凭据已配置" : "缺少 API Key"} · {provider.overrideCount} 个模型覆盖</small></div><button onClick={() => beginEdit(provider)}>编辑</button><button disabled={busy || !provider.authenticated || !cwd} onClick={() => void refreshProvider(provider.name)}>刷新模型</button><button className="danger" onClick={() => void removeProvider(provider.name)}>删除</button></article>)}{!newApi?.providers.length && editing === null && <div className="newapi-empty">还没有 NewAPI 网关。添加后可直接保存凭据并发现模型，不需要进入终端。</div>}</div></div>}{error && <div className="models-config-error" role="alert">{error}</div>}<footer><span>{tab === "newapi" ? "PiHub Server 内置模型发现、厂商路由、价格与推理能力适配" : "直接编辑 ~/.pi/agent/models.json"}</span><button onClick={onClose}>关闭</button>{tab === "advanced" && <button className="save-models" onClick={() => void saveAdvanced()} disabled={busy}>保存 JSON</button>}</footer>{removeTarget && <ConfirmDialog title={`删除 NewAPI Provider “${removeTarget}”？`} message="其远端凭据会一并删除。" confirmLabel="删除" danger onConfirm={() => void confirmRemoveProvider()} onClose={() => setRemoveTarget(null)} />}</section></div>;
}

function FolderSessionModal({ device, initialPath, onClose, onCreated }: { device: Device; initialPath?: string; onClose: () => void; onCreated: (id: string, cwd: string) => void }) {
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  const [browse, setBrowse] = useState<RemoteDirectoryBrowse | null>(null); const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const navigate = useCallback(async (path?: string) => { setBusy(true); setError(""); try { setBrowse(await browseRemoteDirectories(device, path)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }, [device]);
  useEffect(() => { void navigate(initialPath); }, [initialPath, navigate]);
  async function create() { if (!browse?.path || !name.trim()) return; setBusy(true); setError(""); try { const result = await createRemoteFolderSession(device, browse.path, name); onCreated(result.sessionId, result.cwd); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); } }
  async function startHere() { if (!browse?.path) return; setBusy(true); setError(""); try { onCreated((await createRemoteSession(device, browse.path)).sessionId, browse.path); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); } }
  return <div className="modal-backdrop folder-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialogRef} className="folder-modal" role="dialog" aria-modal="true" aria-label="选择项目文件夹"><header><div><h2>选择项目文件夹</h2><p>在选中的文件夹开始新会话，或先新建一个文件夹。</p></div><button onClick={onClose} aria-label="关闭文件夹选择"><X size={16} /></button></header><div className="folder-path"><button aria-label="返回上级文件夹" onClick={() => void navigate(browse?.parentPath ?? undefined)} disabled={!browse?.parentPath}><ChevronLeft size={15} /></button><code>{browse?.path || "正在读取…"}</code></div><div className="folder-list">{busy && !browse ? <LoaderCircle className="spin" /> : browse?.directories.map((entry) => <button key={entry.path} onClick={() => void navigate(entry.path)}><FolderGit2 size={15} /><span>{entry.name}</span><ChevronRightIcon /></button>)}</div><label>新文件夹名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="留空则直接使用当前文件夹" autoFocus /></label>{error && <div className="folder-error" role="alert">{error}</div>}<footer><button onClick={onClose}>取消</button><button disabled={busy || !browse?.path} onClick={() => void startHere()}><MessageSquareText size={14} />在此文件夹开始</button><button className="folder-create" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? <LoaderCircle className="spin" size={14} /> : <FolderPlus size={14} />}新建并开始</button></footer></section></div>;
}

function ChevronRightIcon() { return <span className="folder-chevron">›</span>; }

function ToolPanel({ tab, session, device }: { tab: CoreToolTab; session?: RemoteSession; device: Device | null }) {
  const [files, setFiles] = useState<string[]>([]); const [git, setGit] = useState<RemoteGitStatus | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [gitDiff, setGitDiff] = useState<{ filePath: string; data: RemoteGitDiff } | null>(null); const [gitDiffBusy, setGitDiffBusy] = useState("");
  const [preview, setPreview] = useState<{ path: string; data: RemoteFilePreview } | null>(null); const [previewBusy, setPreviewBusy] = useState(""); const [savedContent, setSavedContent] = useState(""); const [savedFlash, setSavedFlash] = useState(false);
  const [fileDialog, setFileDialog] = useState<"file" | "folder" | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [renderMd, setRenderMd] = useState(true);
  const [entryMenu, setEntryMenu] = useState<{ x: number; y: number; entry: { name: string; isDir: boolean } } | null>(null);
  const [entryRename, setEntryRename] = useState<string | null>(null);
  const [entryMove, setEntryMove] = useState<string | null>(null);
  const [entryDelete, setEntryDelete] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const entryMenuRef = useRef<HTMLDivElement>(null);
  const entryMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [uploading, setUploading] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploadConflict, setUploadConflict] = useState<{ files: File[]; names: string[] } | null>(null);
  async function performUpload(files: File[], conflict: "error" | "overwrite") {
    if (!device || !session) return;
    setUploading(`正在上传 ${files.length} 个文件…`); setError("");
    try {
      const result = await uploadRemoteFiles(device, directory?.path ?? session.cwd, files, conflict);
      const failed = result.errors ?? [];
      if (failed.length) setError(failed.map((item) => `${item.name}：${item.error}`).join("；"));
      flashMessage(`已上传 ${result.uploaded?.length ?? 0} 个文件${failed.length ? `，${failed.length} 个失败` : ""}`);
      await enterDirectory(directory?.path ?? session.cwd);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setUploading(""); }
  }
  async function startUpload(list: FileList | File[]) {
    if (!device || !session) return;
    const files = Array.from(list).filter((file) => file.size > 0 || file.name);
    if (!files.length) return;
    const oversize = files.find((file) => file.size > 25 * 1024 * 1024);
    if (oversize) { setError(`「${oversize.name}」超过 25MB 单文件上限`); return; }
    if (files.reduce((total, file) => total + file.size, 0) > 100 * 1024 * 1024) { setError("上传总大小超过 100MB 上限"); return; }
    setError("");
    try {
      const check = await uploadRemoteCheck(device, directory?.path ?? session.cwd, files.map((file) => file.name));
      if (check.conflicts.length) { setUploadConflict({ files, names: check.conflicts }); return; }
      await performUpload(files, "error");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  useEffect(() => {
    if (!entryMenu) return;
    const close = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest(".file-context-menu")) setEntryMenu(null); };
    document.addEventListener("pointerdown", close, true);
    const frame = requestAnimationFrame(() => entryMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    return () => { cancelAnimationFrame(frame); document.removeEventListener("pointerdown", close, true); };
  }, [entryMenu]);
  function openEntryMenu(trigger: HTMLButtonElement, x: number, y: number, entry: { name: string; isDir: boolean }) {
    entryMenuTriggerRef.current = trigger;
    setEntryMenu({ x, y, entry });
  }
  function handleEntryMenuKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault(); setEntryMenu(null); entryMenuTriggerRef.current?.focus(); return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !items.length) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items[next].focus();
  }
  function flashMessage(text: string) { setFlash(text); window.setTimeout(() => setFlash(""), 2600); }
  async function refreshDirectory() { if (!device || !session || !directory) return; setDirectory(await loadRemoteDirectory(device, directory.path, session.id)); }
  async function downloadEntry(name: string) {
    if (!device || !session || !directory) return;
    try { const path = await downloadRemoteFile(device, absoluteRemotePath(directory.path, name), session.id); flashMessage(`已下载：${path.split(/[\\/]/).pop()}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function submitEntryRename(name: string) {
    const from = entryRename;
    setEntryRename(null);
    if (!device || !session || !directory || !from || name === from) return;
    setBusy(true); setError("");
    try { await remoteFileAction(device, "rename", absoluteRemotePath(directory.path, from), { destination: name }); await refreshDirectory(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function submitEntryMove(destination: string) {
    const from = entryMove;
    setEntryMove(null);
    if (!device || !session || !directory || !from) return;
    const source = absoluteRemotePath(directory.path, from);
    if (source === destination) return;
    setBusy(true); setError("");
    try { await remoteFileAction(device, "move", source, { destination }); await refreshDirectory(); flashMessage(`已移动：${from}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function confirmEntryDelete() {
    const name = entryDelete;
    setEntryDelete(null);
    if (!device || !session || !directory || !name) return;
    setBusy(true); setError("");
    try { await remoteFileAction(device, "delete", absoluteRemotePath(directory.path, name)); await refreshDirectory(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const [directory, setDirectory] = useState<RemoteDirectoryListing | null>(null);
  useEffect(() => {
    if (!device || !session || tab === "terminal") return;
    let alive = true; setBusy(true); setError("");
    const task = tab === "files" ? loadRemoteDirectory(device, session.cwd, session.id).then((listing) => { if (alive) { setDirectory(listing); setFiles(listing.entries.map((entry) => entry.name)); } }) : loadRemoteGit(device, session.cwd).then((value) => alive && setGit(value));
    task.catch((cause) => alive && setError(cause instanceof Error ? cause.message : String(cause))).finally(() => alive && setBusy(false));
    return () => { alive = false; };
  }, [device, session, tab]);
  useEffect(() => { setPreview(null); setPreviewBusy(""); setGitDiff(null); setGitDiffBusy(""); }, [session?.id, tab]);

  async function openGitDiff(filePath: string) {
    if (!device || !session) return;
    setGitDiffBusy(filePath); setError("");
    try { setGitDiff({ filePath, data: await loadRemoteGitDiff(device, session.cwd, filePath) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setGitDiffBusy(""); }
  }

  async function openFile(path: string) {
    if (!device || !session) return;
    setPreviewBusy(path); setError("");
    try { const data = await loadRemoteFile(device, session.cwd, path, session.id); setPreview({ path, data }); setSavedContent(data.content); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPreviewBusy(""); }
  }
  async function savePreview() {
    if (!device || !session || !preview) return;
    setPreviewBusy(preview.path); setError("");
    try { await remoteFileAction(device, "write", absoluteRemotePath(session.cwd, preview.path), { content: preview.data.content }); setSavedContent(preview.data.content); setSavedFlash(true); window.setTimeout(() => setSavedFlash(false), 1400); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPreviewBusy(""); }
  }
  function deletePreview() {
    if (!device || !session || !preview) return;
    setDeleteOpen(true);
  }
  async function confirmDeletePreview() {
    if (!device || !session || !preview) return;
    setDeleteOpen(false);
    setPreviewBusy(preview.path); setError("");
    try { await remoteFileAction(device, "delete", absoluteRemotePath(session.cwd, preview.path)); setFiles(await loadRemoteFiles(device, session.cwd)); setPreview(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPreviewBusy(""); }
  }
  function renamePreview() {
    if (!device || !session || !preview) return;
    setRenameOpen(true);
  }
  async function submitRenamePreview(name: string) {
    if (!device || !session || !preview) return;
    setRenameOpen(false);
    const current = preview.path.split(/[\\/]/).at(-1) || preview.path;
    if (name === current) return;
    setPreviewBusy(preview.path); setError("");
    try { await remoteFileAction(device, "rename", absoluteRemotePath(session.cwd, preview.path), { destination: name }); setFiles(await loadRemoteFiles(device, session.cwd)); setPreview(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPreviewBusy(""); }
  }
  async function createEntry(name: string) {
    if (!device || !session) return;
    setBusy(true); setError("");
    try { const base = directory?.path || session.cwd; await remoteFileAction(device, fileDialog === "folder" ? "mkdir" : "touch", base, { name }); setDirectory(await loadRemoteDirectory(device, base, session.id)); setFileDialog(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function enterDirectory(path: string) { if (!device || !session) return; setBusy(true); try { const listing = await loadRemoteDirectory(device, path, session.id); setDirectory(listing); setFiles(listing.entries.map((entry) => entry.name)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }
  async function openDirectoryFile(name: string) { if (!device || !session || !directory) return; const path = absoluteRemotePath(directory.path, name); setPreviewBusy(path); try { const data = await loadRemoteAbsoluteFile(device, path, session.id); setPreview({ path, data }); setSavedContent(data.content); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setPreviewBusy(""); } }
  if (!session) return <div className="tool-placeholder"><div><FileCode2 size={27} /></div><h3>工作区工具</h3><p>选择会话后显示文件与 Git 状态。</p></div>;
  if (busy) return <div className="tool-placeholder"><LoaderCircle className="spin" /><p>正在读取远程工作区…</p></div>;
  if (error) return <div className="tool-placeholder"><div><X size={24} /></div><h3>无法加载</h3><p>{error}</p></div>;
  if (tab === "files" && preview) { const dirty = preview.data.content !== savedContent; const isMarkdown = preview.data.language === "markdown"; const leave = () => { if (!dirty) setPreview(null); else setLeaveOpen(true); }; return <><div className="file-preview"><div className="file-preview-head"><button onClick={leave} title="返回文件列表"><ChevronLeft size={15} /></button><div><strong>{preview.path.split(/[\\/]/).at(-1)}{dirty && <i className="dirty-dot" title="尚未保存" />}</strong><small>{preview.data.language} · {formatBytes(preview.data.size)}</small></div><span className="file-actions">{savedFlash && <em>已保存</em>}{isMarkdown && <button onClick={() => setRenderMd(!renderMd)} title={renderMd ? "查看源码" : "渲染预览"}>{renderMd ? "源码" : "预览"}</button>}<button onClick={() => void renamePreview()} title="重命名"><Pencil size={12} /></button>{(!isMarkdown || !renderMd) && <button onClick={() => void savePreview()} title="保存" disabled={!dirty || Boolean(previewBusy)}>{previewBusy ? "保存中…" : "保存"}</button>}<button className="danger" onClick={() => void deletePreview()} title="删除">删除</button></span></div>{isMarkdown && renderMd ? <div className="file-render"><Markdown text={preview.data.content} /></div> : <textarea className="file-editor" value={preview.data.content} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (dirty) void savePreview(); } }} onChange={(event) => setPreview({ ...preview, data: { ...preview.data, content: event.target.value } })} spellCheck={false} />}</div>{renameOpen && <NamePromptDialog title="重命名文件" initial={preview.path.split(/[\\/]/).at(-1) || preview.path} onSubmit={(name) => void submitRenamePreview(name)} onClose={() => setRenameOpen(false)} />}{deleteOpen && <ConfirmDialog title={`删除 ${preview.path}？`} message="此操作不可撤销。" confirmLabel="删除" danger onConfirm={() => void confirmDeletePreview()} onClose={() => setDeleteOpen(false)} />}{leaveOpen && <ConfirmDialog title="文件尚未保存" message="确定返回文件列表？未保存的修改会丢失。" confirmLabel="放弃修改" danger onConfirm={() => { setLeaveOpen(false); setPreview(null); }} onClose={() => setLeaveOpen(false)} />}</>; }
  if (tab === "files") {
    const sortedEntries = directory ? [...directory.entries].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)) : [];
    const crumbs = directory ? pathBreadcrumbs(session.cwd, directory.path) : [];
    return <><div className={`native-file-list ${dragOver ? "drag-over" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }} onDrop={(event) => { event.preventDefault(); setDragOver(false); void startUpload(event.dataTransfer.files); }}><div className="tool-section-head"><span>{directory?.path === session.cwd ? "项目文件" : directory?.path.split(/[\\/]/).at(-1)}</span><div>{uploading && <em className="file-flash">{uploading}</em>}{flash && <em className="file-flash">{flash}</em>}<button aria-label="刷新文件" title="刷新" onClick={() => void enterDirectory(directory?.path ?? session.cwd)}><RefreshCw size={12} /></button><button aria-label="新建文件" title="新建文件" onClick={() => setFileDialog("file")}><Plus size={12} /></button><button aria-label="新建文件夹" title="新建文件夹" onClick={() => setFileDialog("folder")}><FolderPlus size={12} /></button><button aria-label="上传文件到当前目录" title="上传文件到当前目录" onClick={() => uploadInputRef.current?.click()} disabled={Boolean(uploading)}><Upload size={12} /></button><input ref={uploadInputRef} type="file" multiple hidden onChange={(event) => { const picked = Array.from(event.target.files ?? []); event.target.value = ""; if (picked.length) void startUpload(picked); }} /><small>{directory?.entries.length ?? files.length}</small></div></div>{crumbs.length > 1 && <div className="breadcrumbs">{crumbs.map((crumb, index) => <button key={crumb.path} disabled={index === crumbs.length - 1} onClick={() => void enterDirectory(crumb.path)}>{index > 0 && <span className="crumb-sep">›</span>}{crumb.name}</button>)}</div>}{fileDialog && <InlineNameDialog label={fileDialog === "folder" ? "新文件夹" : "新文件"} onCancel={() => setFileDialog(null)} onCreate={(name) => void createEntry(name)} />}{sortedEntries.length === 0 && directory && <div className="file-empty"><Folder size={22} /><span>这个文件夹是空的</span></div>}{directory ? sortedEntries.map((entry) => <button key={entry.name} aria-haspopup="menu" aria-expanded={entryMenu?.entry.name === entry.name} onClick={() => entry.isDir ? void enterDirectory(absoluteRemotePath(directory.path, entry.name)) : void openDirectoryFile(entry.name)} onContextMenu={(event) => { event.preventDefault(); openEntryMenu(event.currentTarget, event.clientX, event.clientY, entry); }} onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openEntryMenu(event.currentTarget, rect.left + 12, rect.bottom, entry); } }} title={`${entry.name}（右键或 Shift+F10 管理）`} disabled={previewBusy.endsWith(`/${entry.name}`)}>{entry.isDir ? <Folder size={13} /> : <FileCode2 size={13} />}<span>{entry.name}</span>{entry.isDir && <span className="entry-kind">目录</span>}</button>) : files.slice(0, 180).map((file) => <button key={file} onClick={() => void openFile(file)}><FileCode2 size={13} /><span>{file}</span></button>)}</div>{entryMenu && <div ref={entryMenuRef} className="file-context-menu" role="menu" aria-label={`${entryMenu.entry.name} 文件操作`} onKeyDown={handleEntryMenuKey} style={{ left: Math.max(8, Math.min(entryMenu.x, window.innerWidth - 170)), top: Math.max(8, Math.min(entryMenu.y, window.innerHeight - 220)) }}><button role="menuitem" onClick={() => { const item = entryMenu.entry; setEntryMenu(null); if (item.isDir) void enterDirectory(absoluteRemotePath(directory!.path, item.name)); else void openDirectoryFile(item.name); }}><Folder size={13} />打开</button>{!entryMenu.entry.isDir && <button role="menuitem" onClick={() => { const name = entryMenu.entry.name; setEntryMenu(null); void downloadEntry(name); }}><Download size={13} />下载</button>}<button role="menuitem" onClick={() => { setEntryRename(entryMenu.entry.name); setEntryMenu(null); }}><Pencil size={13} />重命名</button><button role="menuitem" onClick={() => { setEntryMove(entryMenu.entry.name); setEntryMenu(null); }}><FolderInput size={13} />移动到…</button><button role="menuitem" className="danger" onClick={() => { setEntryDelete(entryMenu.entry.name); setEntryMenu(null); }}><Trash2 size={13} />删除</button></div>}{entryRename && <NamePromptDialog title="重命名" initial={entryRename} onSubmit={(name) => void submitEntryRename(name)} onClose={() => setEntryRename(null)} />}{entryMove && directory && <NamePromptDialog title={`移动 ${entryMove} 到完整路径`} initial={absoluteRemotePath(directory.path, entryMove)} submitLabel="移动" onSubmit={(destination) => void submitEntryMove(destination)} onClose={() => setEntryMove(null)} />}{entryDelete && <ConfirmDialog title={`删除 ${entryDelete}？`} message="此操作不可撤销。" confirmLabel="删除" danger onConfirm={() => void confirmEntryDelete()} onClose={() => setEntryDelete(null)} />}{uploadConflict && <ConfirmDialog title={`${uploadConflict.names.length} 个同名文件已存在`} message={`${uploadConflict.names.slice(0, 5).join("、")}${uploadConflict.names.length > 5 ? " 等" : ""}。覆盖同名文件？`} confirmLabel="覆盖上传" danger onConfirm={() => { const pending = uploadConflict; setUploadConflict(null); void performUpload(pending.files, "overwrite"); }} onClose={() => setUploadConflict(null)} />}</>;
  }
  if (tab === "git" && gitDiff) return <GitDiffView value={gitDiff} onClose={() => setGitDiff(null)} />;
  if (tab === "git") return <div className="native-git-list">{git?.isGitRepository === false ? <div className="tool-placeholder compact"><div><GitBranch size={24} /></div><h3>不是 Git 仓库</h3><p>{session.cwd}</p></div> : git?.isBareRepository ? <div className="tool-placeholder compact"><div><GitBranch size={24} /></div><h3>裸仓库没有工作区 diff</h3><p>{git.repositoryRoot}</p></div> : <><div className="git-summary"><div><strong>{git?.files.length ?? 0}</strong><span>个变更</span></div><div className="git-lines"><b>+{git?.additions ?? 0}</b><em>-{git?.deletions ?? 0}</em></div></div>{git?.files.length === 0 && <div className="git-clean"><Check size={18} /><span>工作区没有改动</span></div>}{git?.files.map((file) => <button key={file.filePath} onClick={() => void openGitDiff(file.filePath)} disabled={gitDiffBusy === file.filePath} aria-label={`查看 ${file.filePath.split(/[\\/]/).at(-1)} 的 Git diff`}><span className={`git-badge ${file.status}`}>{gitDiffBusy === file.filePath ? <LoaderCircle className="spin" size={11} /> : gitStatusLetter(file.status)}</span><span>{file.filePath.split(/[\\/]/).at(-1)}</span><small>{file.filePath}</small></button>)}</>}</div>;
  return device ? <RemoteTerminal device={device} session={session} /> : null;
}

function GitDiffView({ value, onClose }: { value: { filePath: string; data: RemoteGitDiff }; onClose: () => void }) {
  const name = value.filePath.split(/[\\/]/).at(-1) || value.filePath;
  const lines = (value.data.patch ?? "").split("\n");
  return <div className="git-diff-view">
    <div className="git-diff-head">
      <button onClick={onClose} aria-label="返回 Git 变更列表" title="返回 Git 变更列表"><ChevronLeft size={15} /></button>
      <div><strong>{name}</strong><small>{value.filePath}</small></div>
      {value.data.status && <span className={`git-badge ${value.data.status}`}>{gitStatusLetter(value.data.status)}</span>}
    </div>
    {!value.data.supported ? <div className="git-diff-empty"><FileCode2 size={24} /><strong>无法预览这个文件</strong><span>二进制文件或超出预览限制的改动不会在应用内显示。</span></div> : !value.data.patch ? <div className="git-diff-empty"><Check size={24} /><strong>没有可显示的 diff</strong><span>文件状态可能已经变化，请返回后刷新。</span></div> : <pre className="git-diff" aria-label={`${name} 的 Git diff`}>{lines.map((line, index) => <span className={gitDiffLineClass(line)} key={index}>{line || " "}{"\n"}</span>)}</pre>}
  </div>;
}

function gitDiffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "deleted";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "meta";
  return "context";
}

function InlineNameDialog({ label, onCancel, onCreate }: { label: string; onCancel: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return <form className="inline-name-dialog" onSubmit={(event) => { event.preventDefault(); if (name.trim()) onCreate(name.trim()); }}><input value={name} onChange={(event) => setName(event.target.value)} placeholder={label} autoFocus /><button type="submit">创建</button><button type="button" onClick={onCancel}><X size={12} /></button></form>;
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "刚刚"; if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`; return `${Math.floor(seconds / 86400)} 天前`;
}

function thinkingLabel(value?: string) { return ({ off: "不思考", minimal: "极简", low: "轻度", medium: "中度", high: "深度", xhigh: "极深", max: "最大" } as Record<string, string>)[value || ""] || "自动思考"; }
function gitStatusLetter(value: string) { return ({ modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U" } as Record<string, string>)[value] || "•"; }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function absoluteRemotePath(cwd: string, relative: string) { if (/^(?:\/|[A-Za-z]:[\\/])/.test(relative)) return relative.replaceAll("\\", "/"); return `${cwd.replace(/[\\/]$/, "")}/${relative}`.replaceAll("\\", "/"); }
function pathBreadcrumbs(root: string, current: string): Array<{ name: string; path: string }> {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const base = normalize(root); const here = normalize(current);
  const rootName = base.split("/").filter(Boolean).at(-1) || base || "/";
  if (!here.startsWith(base)) return [{ name: rootName, path: base }];
  const crumbs = [{ name: rootName, path: base }];
  let acc = base;
  for (const segment of here.slice(base.length).split("/").filter(Boolean)) { acc += `/${segment}`; crumbs.push({ name: segment, path: acc }); }
  return crumbs;
}

/* ---------- Session stats (pi-web top-bar equivalent) ---------- */

function computeSessionStats(messages: SessionMessage[]): SessionTokenStats | null {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0, userMessages = 0, assistantMessages = 0, toolCalls = 0, toolResults = 0;
  for (const message of messages) {
    if (message.role === "user") userMessages += 1;
    if (message.role === "toolResult") toolResults += 1;
    if (message.role !== "assistant") continue;
    assistantMessages += 1;
    const content = Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [];
    toolCalls += content.filter((block) => block?.type === "toolCall").length;
    const usage = message.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | undefined;
    if (!usage) continue;
    tokens.input += usage.input ?? 0;
    tokens.output += usage.output ?? 0;
    tokens.cacheRead += usage.cacheRead ?? 0;
    tokens.cacheWrite += usage.cacheWrite ?? 0;
    cost += usage.cost?.total ?? 0;
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  if (tokens.total === 0 && messages.length === 0) return null;
  return { userMessages, assistantMessages, toolCalls, toolResults, tokens, cost };
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时 ${minutes % 60} 分钟` : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

function SessionStats({ stats, contextUsage, detail, selected, open, onToggle }: {
  stats: SessionTokenStats | null;
  contextUsage: RemoteContextUsage | null;
  detail: SessionDetail | null;
  selected?: RemoteSession;
  open: boolean;
  onToggle: () => void;
}) {
  const [copied, setCopied] = useState("");
  if (!stats && !contextUsage) return null;
  const tokens = stats?.tokens;
  const cost = stats?.cost ?? 0;
  const costText = cost > 0 ? (cost >= 0.01 ? `$${cost.toFixed(2)}` : "<$0.01") : null;
  const percent = contextUsage?.percent ?? null;
  const ctxClass = percent !== null && percent > 90 ? "ctx-danger" : percent !== null && percent > 70 ? "ctx-warn" : "";
  const cacheHit = tokens && tokens.input + tokens.cacheRead > 0 ? (tokens.cacheRead / (tokens.input + tokens.cacheRead)) * 100 : null;
  const copyValue = (label: string, value: string) => { void navigator.clipboard.writeText(value).then(() => { setCopied(label); window.setTimeout(() => setCopied(""), 1400); }); };
  return <span className="popover-root stats-anchor">
    <button className={`stats-chip ${ctxClass}`} onClick={onToggle} title="会话统计与上下文用量">
      {tokens && <span>↑{formatCompact(tokens.input)} ↓{formatCompact(tokens.output)}</span>}
      {costText && <span>{costText}</span>}
      {contextUsage && <span className="ctx">{percent !== null ? `${percent.toFixed(0)}%` : "—"} / {formatCompact(contextUsage.contextWindow)}</span>}
    </button>
    {open && <div className="stats-popover">
      <h4>会话信息</h4>
      <dl>
        {selected?.name && <div><dt>名称</dt><dd>{selected.name}</dd></div>}
        {detail?.filePath && <div><dt>文件</dt><dd className="copyable" onClick={() => copyValue("file", detail.filePath || "")}>{copied === "file" ? "已复制" : detail.filePath}</dd></div>}
        {selected && <div><dt>会话 ID</dt><dd className="copyable" onClick={() => copyValue("id", selected.id)}>{copied === "id" ? "已复制" : selected.id}</dd></div>}
        {detail ? <div><dt>活跃时长</dt><dd>{formatDuration(detail.totalActiveMs)}</dd></div> : null}
        {stats && <div><dt>消息</dt><dd>用户 {stats.userMessages} 条 · 助手 {stats.assistantMessages} 条 · 工具调用 {stats.toolCalls} 次</dd></div>}
        {tokens && <div><dt>Tokens</dt><dd>输入 {tokens.input.toLocaleString()} · 输出 {tokens.output.toLocaleString()} · 缓存读取 {tokens.cacheRead.toLocaleString()} · 缓存写入 {tokens.cacheWrite.toLocaleString()}</dd></div>}
        {cost > 0 && <div><dt>成本</dt><dd>${cost.toFixed(4)}</dd></div>}
        {contextUsage && <div><dt>上下文</dt><dd className={ctxClass}>{percent !== null ? `已用 ${percent.toFixed(1)}%` : "用量未知"}（窗口共 {contextUsage.contextWindow.toLocaleString()} tokens）</dd></div>}
        {cacheHit !== null && <div><dt>缓存命中率</dt><dd>{cacheHit.toFixed(1)}%</dd></div>}
      </dl>
    </div>}
  </span>;
}

/* ---------- In-session branch switching ---------- */

interface BranchItem { id: string; label: string; active: boolean }

function WorktreeControl({ state, cwd, open, busy, error, onToggle, onOpen, onCreate, onRemove }: {
  state: RemoteWorktrees;
  cwd: string;
  open: boolean;
  busy: string;
  error: string;
  onToggle: () => void;
  onOpen: (target: RemoteWorktree) => void;
  onCreate: () => void;
  onRemove: (target: RemoteWorktree) => void;
}) {
  const current = state.worktrees.find((target) => sameOrDescendantPath(target.path, cwd))
    ?? state.worktrees.find((target) => target.path === state.currentWorktreePath)
    ?? null;
  const label = current?.branch || (current?.isMain ? "main checkout" : "Worktrees");
  return <span className="popover-root worktree-anchor">
    <button className="branch-chip-button worktree-chip-button" onClick={onToggle} title="Git worktree" aria-label={`Git worktree：${label}`} aria-expanded={open} aria-controls="worktree-menu">
      <GitBranch size={11} /><span>{label}</span>{busy ? <LoaderCircle className="spin" size={11} /> : <ChevronDown size={11} />}
    </button>
    {open && <div className="session-menu worktree-menu" id="worktree-menu">
      <div className="worktree-menu-head"><strong>Git worktrees</strong><span>{state.worktrees.length} 个 checkout</span></div>
      {!state.isTopLevel && <div className="worktree-note">当前会话位于仓库子目录；切换后会从 worktree 根目录开始新会话。</div>}
      {error && <div className="worktree-error" role="alert">{error}</div>}
      <div className="worktree-list">
        {state.worktrees.map((target) => {
          const active = current?.path === target.path;
          const working = busy === target.path || busy === `delete:${target.path}`;
          const name = target.branch || target.path.split(/[\\/]/).filter(Boolean).at(-1) || target.path;
          return <div className={active ? "active" : ""} key={target.path}>
            <button className="worktree-open" disabled={active || Boolean(busy)} onClick={() => onOpen(target)} title={target.path}>
              {working ? <LoaderCircle className="spin" size={12} /> : <GitBranch size={12} />}
              <span><strong>{name}</strong><small>{target.path}</small></span>
              {active && <em>当前</em>}
            </button>
            {!target.isMain && <button className="worktree-remove" disabled={Boolean(busy)} aria-label={`移除 worktree：${name}`} title="移除 worktree" onClick={() => onRemove(target)}><Trash2 size={12} /></button>}
          </div>;
        })}
      </div>
      <button className="worktree-create" disabled={Boolean(busy)} onClick={onCreate}><Plus size={12} />新建 worktree…</button>
    </div>}
  </span>;
}

function collectBranches(tree: SessionTreeNode[], leafId: string | null): BranchItem[] {
  const leaves: BranchItem[] = [];
  const walk = (node: SessionTreeNode) => {
    if (!node.children.length) {
      const active = node.entry.id === leafId || Boolean(leafId && node.compressedEntryIds?.includes(leafId));
      leaves.push({ id: node.entry.id, label: node.label || node.branchPreview?.text || node.entry.type, active });
      return;
    }
    for (const child of node.children) walk(child);
  };
  for (const node of tree) walk(node);
  return leaves.length > 1 ? leaves : [];
}

function BranchSwitch({ branches, onNavigate }: { branches: BranchItem[]; onNavigate: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const current = branches.findIndex((branch) => branch.active);
  return <span className="popover-root branch-anchor">
    <button className="branch-chip-button" onClick={() => setOpen(!open)} title="会话内分支">
      <GitBranch size={11} />{current >= 0 ? `分支 ${current + 1}/${branches.length}` : `${branches.length} 个分支`}<ChevronDown size={11} />
    </button>
    {open && <div className="session-menu branch-menu">
      {branches.map((branch, index) => <button key={branch.id} className={branch.active ? "active" : ""} disabled={branch.active} onClick={() => { setOpen(false); onNavigate(branch.id); }}>
        <GitBranch size={12} /><span>#{index + 1} {branch.label.slice(0, 42)}</span>{branch.active && <Check size={12} />}
      </button>)}
    </div>}
  </span>;
}

function sameOrDescendantPath(parent: string, candidate: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const base = normalize(parent);
  const current = normalize(candidate);
  const insensitive = /^[A-Za-z]:\//.test(base) || /^[A-Za-z]:\//.test(current);
  const left = insensitive ? base.toLowerCase() : base;
  const right = insensitive ? current.toLowerCase() : current;
  return right === left || right.startsWith(`${left}/`);
}

function workspaceOperationError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/trust this project|project_trust_required/i.test(message)) return "请先在远端信任这个项目，再管理 worktree。";
  if (/insufficient device capability/i.test(message)) return "当前设备凭据缺少工作区管理权限，请由设备管理员重新授权。";
  if (/access denied/i.test(message)) return "当前设备无权访问这个工作区路径。";
  if (/invalid branch name/i.test(message)) return "分支名无效，请使用 Git 支持的分支名称。";
  return message;
}

/* ---------- Completion sound ---------- */

let audioContext: AudioContext | null = null;
function playDoneSound() {
  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === "suspended") void audioContext.resume();
    const start = audioContext.currentTime;
    for (const [index, frequency] of [880, 1174.66].entries()) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + index * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.12, start + index * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.12 + 0.28);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start + index * 0.12);
      oscillator.stop(start + index * 0.12 + 0.3);
    }
  } catch { /* audio unavailable */ }
}

/* ---------- Slash commands + tool presets ---------- */

const BUILTIN_SLASH_COMMANDS: Array<{ name: string; description: string; source?: string }> = [
  { name: "compact", description: "压缩上下文（可附带说明）", source: "builtin" },
  { name: "reload", description: "重载会话资源与扩展", source: "builtin" },
  { name: "name", description: "重命名会话：/name <名称>", source: "builtin" },
  { name: "copy", description: "复制上一条助手回复", source: "builtin" },
];

// Mirrors server/lib/tool-presets.ts.
const TOOL_PRESETS: Array<{ id: string; label: string; tools: string[] }> = [
  { id: "none", label: "无工具", tools: [] },
  { id: "read-only", label: "只读", tools: ["read", "grep", "find", "ls"] },
  { id: "default", label: "默认", tools: ["read", "bash", "edit", "write"] },
  { id: "full", label: "全部工具", tools: ["bash", "read", "edit", "write", "grep", "find", "ls"] },
];

function presetFromTools(tools: Array<{ name: string; active: boolean }>): string {
  const builtinNames = new Set(TOOL_PRESETS.find((item) => item.id === "full")!.tools);
  const active = tools.filter((tool) => tool.active).map((tool) => tool.name).filter((name) => builtinNames.has(name)).sort().join(",");
  if (tools.filter((tool) => tool.active).length === 0) return "none";
  for (const preset of TOOL_PRESETS) {
    if (preset.id !== "none" && [...preset.tools].sort().join(",") === active) return preset.id;
  }
  return "default";
}

/* ---------- Extension ask dialog (select / confirm / input / editor) ---------- */

const ASK_METHOD_LABEL: Record<string, string> = { confirm: "确认", select: "选择", input: "输入", editor: "编辑" };

function parsePermissionTitle(title: string): { tool?: string; rule?: string; command?: string; full?: string } | null {
  if (!/permission required/i.test(title)) return null;
  const matches = [...title.matchAll(/(full command|tool|rule|command)\s*:/gi)];
  if (!matches.length) return null;
  const fields: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1].toLowerCase();
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : title.length;
    fields[key] = title.slice(start, end).trim();
  }
  return { tool: fields.tool, rule: fields.rule, command: fields.command, full: fields["full command"] };
}

function AskCard({ entry, sessionName, onRespond }: {
  entry: { sessionId: string; request: RemoteUiRequest };
  sessionName?: string;
  onRespond: (response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { request } = entry;
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setIndex(0);
  }, [request.id, request.method, request.prefill]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onRespond({ cancelled: true }); return; }
      if (request.method === "select" && request.options?.length) {
        if (event.key === "ArrowDown") { event.preventDefault(); setIndex((i) => Math.min(i + 1, request.options!.length - 1)); }
        if (event.key === "ArrowUp") { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
        if (event.key === "Enter") { event.preventDefault(); onRespond({ value: request.options![index] }); }
        return;
      }
      if (request.method === "confirm" && event.key === "Enter") { event.preventDefault(); onRespond({ confirmed: true }); return; }
      if (request.method === "input" && event.key === "Enter") { event.preventDefault(); onRespond({ value }); return; }
      if (request.method === "editor" && event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onRespond({ value }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, index, value, onRespond]);

  const perm = parsePermissionTitle(request.title || "");
  return <div className="ask-inline" role="alert">
    <div className="ask-inline-head">
      {perm ? <ShieldAlert size={15} /> : <CircleHelp size={15} />}
      <strong>{perm ? `权限请求 · ${perm.tool || "工具"}` : (request.title || "扩展请求")}</strong>
      {perm?.command && <code className="perm-chip">{perm.command}</code>}
      {perm?.rule && <span className="perm-rule">{perm.rule}</span>}
      {sessionName && <span className="perm-rule">{sessionName}</span>}
      {!perm && <span className="perm-rule">{sessionName ? `${sessionName} · ` : ""}扩展{ASK_METHOD_LABEL[request.method] ?? ""}请求</span>}
    </div>
    {perm?.full && <pre className="ask-inline-full">{perm.full}</pre>}
    {request.method === "confirm" && <p className="ask-message">{request.message}</p>}
    {request.method === "select" && <div className="ask-inline-options">
      {(request.options ?? []).map((option, optionIndex) => <button key={option} className={optionIndex === index ? "active" : ""} onMouseEnter={() => setIndex(optionIndex)} onClick={() => onRespond({ value: option })}>{option}</button>)}
    </div>}
    {request.method === "input" && <input className="ask-input" autoFocus value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} />}
    {request.method === "editor" && <textarea className="ask-editor" autoFocus value={value} onChange={(event) => setValue(event.target.value)} spellCheck={false} />}
    <div className="ask-inline-foot">
      {request.method === "editor" && <span className="ask-hint">⌘Enter 提交</span>}
      {request.method === "select" && <span className="ask-hint">↑↓ 选择 · Enter 确认 · Esc 取消</span>}
      <button className="ask-cancel" onClick={() => onRespond({ cancelled: true })}>取消</button>
      {request.method === "confirm"
        ? <button className="ask-confirm" autoFocus onClick={() => onRespond({ confirmed: true })}>确认</button>
        : request.method !== "select" && <button className="ask-confirm" onClick={() => onRespond({ value })}>提交</button>}
    </div>
  </div>;
}
