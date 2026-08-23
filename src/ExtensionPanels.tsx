/**
 * Client panels for the server-integrated Pi extensions.
 *
 *   TodoRail       — read-only list above the composer (pi-todo-rail)
 *   PermissionPill — rule editor inside the composer toolbar (@gotgenes/pi-permission-system)
 *   SubagentPanel  — polled progress list (@gotgenes/pi-subagents)
 *   AskFlowPanel   — native ask dialog bridged from the extension event bus (@eko24ive/pi-ask)
 *
 * The todo list is owned entirely by pi-todo-rail and lives in the session
 * transcript. The agent calls the `todo` tool and the user can run /todo
 * commands; this panel just reflects the current snapshot.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, CircleDot, CircleHelp, LoaderCircle, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { addRemotePermissionRule, loadRemotePermissions, loadRemoteSubagents, loadRemoteTodos, removeRemotePermissionRule } from "./lib";
import type { Device, RailTodo, RemoteAskAnswer, RemoteAskFlow, RemoteAskQuestion, RemoteAskResponse, RemotePermissionRule, RemoteSubagent } from "./types";

// ── TodoRail ─────────────────────────────────────────────────────────────────

/**
 * Read-only todo list pinned above the composer. Replays the session transcript
 * to find the latest pi-todo-rail snapshot. Done items render with a
 * strikethrough; once every item is done the panel closes itself. The agent and
 * the user's /todo commands are the only writers.
 */
export function TodoRail({ device, sessionId, refreshKey }: {
  device: Device | null;
  sessionId: string | null;
  /** Bump to force a re-read, e.g. after an agent turn settles. */
  refreshKey?: number;
}) {
  const [todos, setTodos] = useState<RailTodo[]>([]);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("pihub-todo-collapsed") === "1");

  useEffect(() => { localStorage.setItem("pihub-todo-collapsed", collapsed ? "1" : "0"); }, [collapsed]);

  const reload = useCallback(async () => {
    if (!device || !sessionId) { setTodos([]); return; }
    try {
      const result = await loadRemoteTodos(device, sessionId);
      setTodos(result.snapshot.todos);
    } catch {
      setTodos([]);
    }
  }, [device, sessionId]);

  useEffect(() => { void reload(); }, [reload, refreshKey]);

  if (!sessionId || !todos.length) return null;

  const done = todos.filter((t) => t.done).length;
  // Everything finished: the panel closes itself instead of lingering as a
  // fully-struck list.
  if (done === todos.length) return null;
  const currentId = todos.find((t) => !t.done)?.id;

  return <div className="todo-rail">
    <div className="todo-rail-head">
      <button className="todo-rail-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <strong>待办</strong>
        <span>{done}/{todos.length}</span>
      </button>
    </div>

    {!collapsed && <ul className="todo-rail-list">
      {todos.map((todo) => <li key={todo.id} className={todo.done ? "done" : todo.id === currentId ? "current" : ""}>
        <span className="todo-check" aria-hidden>
          {todo.done ? <Check size={12} />
            : todo.id === currentId ? <CircleDot size={12} />
            : <span className="todo-box" />}
        </span>
        <span className="todo-text">
          {todo.text}
          {todo.note && <em className="todo-note">{todo.note}</em>}
        </span>
      </li>)}
    </ul>}
  </div>;
}

// ── PermissionPill ───────────────────────────────────────────────────────────

/**
 * Permission rules, editable straight from the composer toolbar. Rules whose
 * scope is `pi-native` come from Pi's own config and are read-only here.
 */
export function PermissionPill({ device }: { device: Device | null }) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<RemotePermissionRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [pattern, setPattern] = useState("");
  const [action, setAction] = useState<"allow" | "deny" | "ask">("ask");
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click, matching the other composer popovers.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const reload = useCallback(async () => {
    if (!device) return;
    setLoading(true);
    try {
      setRules((await loadRemotePermissions(device)).rules);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [device]);

  useEffect(() => { if (open) void reload(); }, [open, reload]);

  async function addRule() {
    if (!device) return;
    const trimmed = pattern.trim();
    if (!trimmed) return;
    setBusy("add");
    setError("");
    try {
      setRules((await addRemotePermissionRule(device, { pattern: trimmed, action })).rules);
      setPattern("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }

  async function removeRule(target: string) {
    if (!device) return;
    setBusy(target);
    setError("");
    try {
      setRules((await removeRemotePermissionRule(device, target)).rules);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }

  const editable = rules.filter((rule) => rule.scope !== "pi-native");
  const native = rules.filter((rule) => rule.scope === "pi-native");

  return <div className="permission-pill-root popover-root" ref={rootRef}>
    <button className="thinking-pill" title="权限规则" aria-label="权限规则" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ShieldCheck size={11} />权限<ChevronDown size={11} />
    </button>

    {open && <div className="composer-menu permission-menu">
      <div className="permission-new">
        <input value={pattern} placeholder="规则，如 bash:rm -rf *" aria-label="权限规则模式"
          onChange={(event) => setPattern(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void addRule(); } }} />
        <select value={action} aria-label="权限动作" onChange={(event) => setAction(event.target.value as typeof action)}>
          <option value="allow">允许</option>
          <option value="deny">拒绝</option>
          <option value="ask">询问</option>
        </select>
        <button aria-label="添加规则" disabled={!pattern.trim() || busy === "add"} onClick={() => void addRule()}>
          {busy === "add" ? <LoaderCircle className="spin" size={12} /> : <Plus size={12} />}
        </button>
      </div>

      {loading ? <div className="permission-loading"><LoaderCircle className="spin" size={13} />读取规则…</div> : <>
        {editable.length > 0 && <div className="permission-group">
          <div className="permission-group-label">PiHub 规则（可编辑）</div>
          {editable.map((rule) => <div className="permission-row" key={`${rule.pattern}:${rule.scope ?? ""}`}>
            <code>{rule.pattern}</code>
            <em className={`act-${rule.action}`}>{rule.action === "allow" ? "允许" : rule.action === "deny" ? "拒绝" : "询问"}</em>
            <button aria-label={`删除规则 ${rule.pattern}`} disabled={busy === rule.pattern} onClick={() => void removeRule(rule.pattern)}>
              {busy === rule.pattern ? <LoaderCircle className="spin" size={11} /> : <Trash2 size={11} />}
            </button>
          </div>)}
        </div>}

        {native.length > 0 && <div className="permission-group">
          <div className="permission-group-label">Pi 原生规则（只读）</div>
          {native.slice(0, 12).map((rule) => <div className="permission-row native" key={`native:${rule.pattern}`}>
            <code>{rule.pattern}</code>
            <em className={`act-${rule.action}`}>{rule.action === "allow" ? "允许" : rule.action === "deny" ? "拒绝" : "询问"}</em>
          </div>)}
          {native.length > 12 && <div className="permission-more">另有 {native.length - 12} 条…</div>}
        </div>}
      </>}

      {error && <div className="permission-error">{error}</div>}
    </div>}
  </div>;
}

// ── SubagentPanel ────────────────────────────────────────────────────────────

const SUBAGENT_POLL_MS = 2000;

/**
 * Subagent progress, refreshed by polling. The panel only renders while at
 * least one subagent is running and closes itself once all of them settle.
 */
export function SubagentPanel({ device, sessionId }: { device: Device | null; sessionId: string | null }) {
  const [subagents, setSubagents] = useState<RemoteSubagent[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!device || !sessionId) { setSubagents([]); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const result = await loadRemoteSubagents(device, sessionId);
        if (!active) return;
        setSubagents(result.subagents);
        // Keep polling fast while work is in flight, back off when idle.
        timer = setTimeout(() => void poll(), result.activeCount > 0 ? SUBAGENT_POLL_MS : SUBAGENT_POLL_MS * 5);
      } catch {
        if (!active) return;
        timer = setTimeout(() => void poll(), SUBAGENT_POLL_MS * 5);
      }
    };

    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [device, sessionId]);

  if (!subagents.length) return null;
  const running = subagents.filter((item) => item.status === "running").length;
  // Close the panel as soon as every subagent has settled.
  if (running === 0) return null;

  return <div className="subagent-panel">
    <button className="subagent-head" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
      <strong>子代理</strong>
      <span>{`${running} 运行中`}</span>
    </button>
    {!collapsed && <ul className="subagent-list">
      {subagents.map((item) => <li key={item.id} className={`sa-${item.status}`}>
        {item.status === "running" ? <LoaderCircle className="spin" size={12} />
          : item.status === "completed" ? <Check size={12} />
          : <X size={12} />}
        <span className="subagent-name">{item.name}</span>
        {item.description && <em>{item.description}</em>}
      </li>)}
    </ul>}
  </div>;
}

// ── AskFlowPanel ─────────────────────────────────────────────────────────────

type AskDraft = { values: string[]; customText: string };

const EMPTY_DRAFT: AskDraft = { values: [], customText: "" };

/**
 * Native ask panel for @eko24ive/pi-ask. The worker bridges the extension's
 * structured remote-ask events (started/completed/submit over the shared
 * extension event bus) into `extension_ui_request` method "ask"; this panel
 * replaces the headless TUI character frame (suppressed server-side).
 */
export function AskFlowPanel({ flow, error, onRespond }: {
  flow: RemoteAskFlow;
  error?: string;
  onRespond: (response: RemoteAskResponse) => void;
}) {
  const questions = flow.questions ?? [];
  const [drafts, setDrafts] = useState<Record<string, AskDraft>>({});
  useEffect(() => { setDrafts({}); }, [flow.flowId]);

  const draftFor = (id: string) => drafts[id] ?? EMPTY_DRAFT;
  const setDraft = (id: string, draft: AskDraft) => setDrafts((current) => ({ ...current, [id]: draft }));

  const toggleOption = (question: RemoteAskQuestion, value: string) => {
    const draft = draftFor(question.id);
    if (question.type === "multi") {
      const values = draft.values.includes(value)
        ? draft.values.filter((item) => item !== value)
        : [...draft.values, value];
      setDraft(question.id, { ...draft, values });
    } else {
      // Single-choice cannot combine a selection with custom text.
      setDraft(question.id, { values: draft.values.includes(value) ? [] : [value], customText: "" });
    }
  };

  const setCustomText = (question: RemoteAskQuestion, customText: string) => {
    const draft = draftFor(question.id);
    setDraft(question.id, {
      values: question.type === "multi" ? draft.values : (customText.trim() ? [] : draft.values),
      customText,
    });
  };

  const answered = (question: RemoteAskQuestion) => {
    const draft = draftFor(question.id);
    return draft.values.length > 0 || draft.customText.trim().length > 0;
  };
  const missingRequired = questions.some((question) => question.required && !answered(question));

  const submit = () => {
    if (missingRequired) return;
    const answers: Record<string, RemoteAskAnswer> = {};
    for (const question of questions) {
      const draft = draftFor(question.id);
      if (!answered(question)) continue;
      answers[question.id] = {
        ...(draft.values.length ? { values: draft.values } : {}),
        ...(draft.customText.trim() ? { customText: draft.customText } : {}),
      };
    }
    onRespond({ kind: "answer", mode: "submit", answers });
  };

  return <div className="ask-flow-panel" role="alert">
    <div className="ask-flow-head">
      <CircleHelp size={15} />
      <strong>{flow.title || "需要你的回答"}</strong>
    </div>
    {error && <div className="ask-flow-error">{error}</div>}
    {questions.map((question, index) => {
      const draft = draftFor(question.id);
      return <div key={question.id} className="ask-flow-question">
        <div className="ask-flow-prompt">
          <span className="ask-flow-label">{question.label || `问题 ${index + 1}`}</span>
          {question.required && <span className="ask-flow-required">必填</span>}
          {question.type === "multi" && <span className="ask-flow-hint">可多选</span>}
        </div>
        <p>{question.prompt}</p>
        {question.options.length > 0 && <div className="ask-flow-options" role={question.type === "multi" ? "group" : "radiogroup"} aria-label={question.label || question.prompt}>
          {question.options.map((option) => {
            const selected = draft.values.includes(option.value);
            return <button
              key={option.value}
              type="button"
              role={question.type === "multi" ? "checkbox" : "radio"}
              aria-checked={selected}
              className={`ask-flow-option${selected ? " selected" : ""}`}
              onClick={() => toggleOption(question, option.value)}
            >
              <span className="ask-flow-option-marker">{question.type === "multi" ? (selected ? "☑" : "☐") : (selected ? "●" : "○")}</span>
              <span className="ask-flow-option-text">
                <span>{option.label}{option.recommended && <em className="ask-flow-recommended">推荐</em>}</span>
                {option.description && <small>{option.description}</small>}
              </span>
            </button>;
          })}
        </div>}
        <input
          className="ask-flow-custom"
          value={draft.customText}
          placeholder={question.type === "multi" ? "补充说明（可选）" : "自定义回答（与选项互斥）"}
          aria-label={`${question.label || question.prompt} 自定义回答`}
          onChange={(event) => setCustomText(question, event.target.value)}
        />
      </div>;
    })}
    <div className="ask-flow-foot">
      {missingRequired && <span className="ask-flow-hint">还有必填问题未回答</span>}
      <button type="button" className="ask-flow-cancel" onClick={() => onRespond({ kind: "cancel" })}>取消</button>
      <button type="button" className="ask-flow-submit" disabled={missingRequired} onClick={submit}>提交</button>
    </div>
  </div>;
}
