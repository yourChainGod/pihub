import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { Check, ChevronDown, ChevronRight, CircleAlert, Command, Copy, FileCode2, GitFork, Search, TerminalSquare, Wrench, X } from "lucide-react";
import type { SessionMessage } from "./types";
import { normalizeDisplayMath } from "./markdown";

type ContentBlock = Record<string, unknown>;

interface ConversationProps {
  messages: SessionMessage[];
  /** Parallel to messages — session entry ids used for fork/branch actions. */
  entryIds?: string[];
  onFork?: (entryId: string) => void;
  forkingId?: string;
  /** Loads the full text of a deferred (historical) thinking block on demand. */
  onLoadThinking?: (entryId: string, blockIndex: number) => Promise<string>;
}

export default function ConversationMessages({ messages, entryIds, onFork, forkingId, onLoadThinking }: ConversationProps) {
  const results = useMemo(() => {
    const map = new Map<string, SessionMessage>();
    for (const message of messages) if (message.role === "toolResult" && typeof message.toolCallId === "string") map.set(message.toolCallId, message);
    return map;
  }, [messages]);
  const items = useMemo(() => groupMessages(messages, entryIds), [messages, entryIds]);

  return <>{items.map((item) => item.type === "toolGroup" ? (
    <ToolCallGroup key={item.key} messages={item.messages} messageEntryIds={item.entryIds} toolResults={results} onLoadThinking={onLoadThinking} />
  ) : (
    <MessageView
      key={item.key}
      message={item.message}
      toolResults={results}
      entryId={entryIds?.[item.index]}
      onFork={onFork}
      forking={forkingId !== undefined && entryIds?.[item.index] === forkingId}
      onLoadThinking={onLoadThinking}
    />
  ))}</>;
}

type ConversationItem =
  | { type: "single"; key: string; message: SessionMessage; index: number }
  | { type: "toolGroup"; key: string; messages: SessionMessage[]; entryIds: (string | undefined)[] };

// An assistant entry that carries no answer text (only tool calls and/or
// thinking, no error) merges visually with adjacent ones — long think/bash
// runs otherwise render as a wall of near-identical message bubbles.
function isActivityOnly(message: SessionMessage): boolean {
  if (message.role !== "assistant" || message.stopReason === "error") return false;
  const blocks = normalizeBlocks(message.content);
  return blocks.length > 0 && blocks.every((block) => block.type === "toolCall" || block.type === "thinking");
}

function singleItem(message: SessionMessage, index: number, entryIds: string[] | undefined): ConversationItem {
  return { type: "single", key: entryIds?.[index] ?? `${message.role}-${message.timestamp ?? index}`, message, index };
}

function groupMessages(messages: SessionMessage[], entryIds: string[] | undefined): ConversationItem[] {
  const items: ConversationItem[] = [];
  let run: SessionMessage[] = [];
  let runStart = 0;
  const flush = () => {
    if (run.length >= 2) {
      items.push({
        type: "toolGroup",
        key: entryIds?.[runStart] ?? `tool-group-${runStart}`,
        messages: run,
        entryIds: run.map((_, offset) => entryIds?.[runStart + offset]),
      });
    } else run.forEach((message, offset) => items.push(singleItem(message, runStart + offset, entryIds)));
    run = [];
  };
  messages.forEach((message, index) => {
    // toolResult entries render inside the owning tool call; they are invisible
    // in the flow and must not break a run of activity-only messages.
    if (message.role === "toolResult") return;
    if (isActivityOnly(message)) {
      if (!run.length) runStart = index;
      run.push(message);
      return;
    }
    flush();
    items.push(singleItem(message, index, entryIds));
  });
  flush();
  return items;
}

function MessageViewInner({ message, toolResults, entryId, onFork, forking, onLoadThinking }: { message: SessionMessage; toolResults: Map<string, SessionMessage>; entryId?: string; onFork?: (entryId: string) => void; forking?: boolean; onLoadThinking?: (entryId: string, blockIndex: number) => Promise<string> }) {
  if (message.role === "toolResult") return null;
  if (message.role === "user") return <UserMessage message={message} entryId={entryId} onFork={onFork} forking={forking} />;
  if (message.role === "assistant") return <AssistantMessage message={message} toolResults={toolResults} entryId={entryId} onLoadThinking={onLoadThinking} />;
  if (message.role === "bashExecution") return <BashMessage message={message} />;
  if (message.role === "custom") return <CustomMessage message={message} />;
  return null;
}

// Streaming deltas rebuild the messages array (and the toolResults map) on every
// frame, but untouched messages keep their object identity. Skipping re-render
// for them keeps ReactMarkdown/KaTeX from re-parsing and — critically — keeps
// the browser text selection alive while other messages stream in.
const MessageView = memo(MessageViewInner, (prev, next) => {
  if (prev.message !== next.message || prev.entryId !== next.entryId || prev.forking !== next.forking) return false;
  if (prev.onFork !== next.onFork || prev.onLoadThinking !== next.onLoadThinking) return false;
  for (const id of messageToolCallIds(next.message)) {
    if (prev.toolResults.get(id) !== next.toolResults.get(id)) return false;
  }
  return true;
});

function messageToolCallIds(message: SessionMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const block of message.content as ContentBlock[]) {
    if (block && block.type === "toolCall" && typeof block.toolCallId === "string") ids.push(block.toolCallId);
  }
  return ids;
}

function ToolCallGroupInner({ messages, messageEntryIds, toolResults, onLoadThinking }: { messages: SessionMessage[]; messageEntryIds: (string | undefined)[]; toolResults: Map<string, SessionMessage>; onLoadThinking?: (entryId: string, blockIndex: number) => Promise<string> }) {
  const [open, setOpen] = useState(true);
  const modelLabel = messages.map((message) => (message.model || message.provider ? String(message.model ?? message.provider) : "")).find(Boolean) ?? "";
  // Keep the original block order across the merged messages so the group reads
  // as the chronological think → act → think → … sequence it was.
  const entries = messages.flatMap((message, messageIndex) => normalizeBlocks(message.content).map((block, blockIndex) => ({ block, messageIndex, blockIndex })));
  const callCount = entries.filter((entry) => entry.block.type === "toolCall").length;
  const thinkingCount = entries.length - callCount;
  const errorCount = entries.filter((entry) => typeof entry.block.toolCallId === "string" && toolResults.get(entry.block.toolCallId)?.isError).length;
  const summary = [
    callCount ? `${callCount} 个工具调用` : "",
    thinkingCount ? `${thinkingCount} 段思考` : "",
  ].filter(Boolean).join(" · ");
  return <article className="original-message assistant-message tool-group">
    <button className="tool-group-head" onClick={() => setOpen(!open)} aria-expanded={open}>
      <Wrench size={12} />
      <span>{summary}{errorCount ? `（${errorCount} 个失败）` : ""}</span>
      {modelLabel && <small>{modelLabel}</small>}
      <small>{formatTime(messages[messages.length - 1]?.timestamp)}</small>
      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
    </button>
    {open && <div className="tool-group-calls">{entries.map((entry, index) => {
      const { block } = entry;
      if (block.type === "thinking") {
        const entryId = messageEntryIds[entry.messageIndex];
        return <ThinkingBlock key={`t-${entry.messageIndex}-${entry.blockIndex}`} compact text={String(block.thinking ?? "")} streaming={messages[entry.messageIndex]?.pihubStreaming === true} deferred={Boolean(block.deferred)} load={entryId && onLoadThinking ? () => onLoadThinking(entryId, entry.blockIndex) : undefined} />;
      }
      return <ToolCall key={typeof block.toolCallId === "string" ? block.toolCallId : index} compact block={block} result={typeof block.toolCallId === "string" ? toolResults.get(block.toolCallId) : undefined} />;
    })}</div>}
  </article>;
}

// Same identity argument as MessageView: unchanged groups keep their message
// object references across streaming frames, so they skip re-rendering.
const ToolCallGroup = memo(ToolCallGroupInner, (prev, next) => {
  if (prev.messages.length !== next.messages.length) return false;
  if (prev.onLoadThinking !== next.onLoadThinking) return false;
  for (let i = 0; i < prev.messages.length; i++) {
    if (prev.messages[i] !== next.messages[i] || prev.messageEntryIds[i] !== next.messageEntryIds[i]) return false;
    for (const id of messageToolCallIds(next.messages[i])) {
      if (prev.toolResults.get(id) !== next.toolResults.get(id)) return false;
    }
  }
  return true;
});

function UserMessage({ message, entryId, onFork, forking }: { message: SessionMessage; entryId?: string; onFork?: (entryId: string) => void; forking?: boolean }) {
  const [copied, setCopied] = useState(false);
  const blocks = normalizeBlocks(message.content);
  const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("\n");
  const images = blocks.filter((block) => block.type === "image");
  return <article className="original-message user-message">
    <div className="user-bubble">
      {images.length > 0 && <div className="image-grid">{images.map((block, index) => <MessageImage key={index} block={block} />)}</div>}
      {text && <Markdown text={text} />}
    </div>
    <div className="message-meta">
      <button onClick={() => copy(text, setCopied)}><Copy size={11} />{copied ? "已复制" : "复制"}</button>
      {entryId && onFork && <button disabled={forking} title="从这里分叉出一个新会话" onClick={() => onFork(entryId)}><GitFork size={11} />{forking ? "分叉中…" : "分叉"}</button>}
      {formatTime(message.timestamp)}
    </div>
  </article>;
}

function AssistantMessage({ message, toolResults, entryId, onLoadThinking }: { message: SessionMessage; toolResults: Map<string, SessionMessage>; entryId?: string; onLoadThinking?: (entryId: string, blockIndex: number) => Promise<string> }) {
  const [copied, setCopied] = useState(false);
  const blocks = normalizeBlocks(message.content);
  const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("\n");
  const modelLabel = message.model || message.provider ? String(message.model ?? message.provider) : "";
  if (!blocks.length && message.stopReason !== "error") return null;
  return <article className="original-message assistant-message">
    {modelLabel && <div className="model-label">{modelLabel}</div>}
    {renderBlocks(blocks, (block, index) => <Block key={index} block={block} streaming={message.pihubStreaming === true} result={typeof block.toolCallId === "string" ? toolResults.get(block.toolCallId) : undefined} loadThinking={entryId && onLoadThinking ? () => onLoadThinking(entryId, index) : undefined} />)}
    {message.stopReason === "error" && <div className="provider-error"><CircleAlert size={14} />{String(message.errorMessage || "模型返回错误")}</div>}
    <div className="message-meta assistant-meta">
      {text.trim() && <button onClick={() => copy(text, setCopied)}><Copy size={11} />{copied ? "已复制" : "复制"}</button>}
      <span className="assistant-time">{formatTime(message.timestamp)}</span>
    </div>
  </article>;
}

/** Renders content blocks, folding consecutive images into one media grid. */
function renderBlocks(blocks: ContentBlock[], render: (block: ContentBlock, index: number) => React.ReactNode): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index]?.type === "image") {
      const run: Array<{ block: ContentBlock; index: number }> = [];
      while (index < blocks.length && blocks[index]?.type === "image") { run.push({ block: blocks[index], index }); index += 1; }
      index -= 1;
      nodes.push(<div key={`images-${run[0].index}`} className="image-grid">{run.map(({ block, index: imageIndex }) => <MessageImage key={imageIndex} block={block} />)}</div>);
      continue;
    }
    nodes.push(render(blocks[index], index));
  }
  return nodes;
}

function Block({ block, result, loadThinking, streaming = false }: { block: ContentBlock; result?: SessionMessage; loadThinking?: () => Promise<string>; streaming?: boolean }) {  if (block.type === "text") return <Markdown text={String(block.text ?? "")} streaming={streaming} />;
  if (block.type === "image") return <MessageImage block={block} />;
  if (block.type === "thinking") return <ThinkingBlock text={String(block.thinking ?? "")} deferred={Boolean(block.deferred)} load={loadThinking} streaming={streaming} />;
  if (block.type === "toolCall") return <ToolCall block={block} result={result} />;
  return null;
}

function ThinkingBlock({ text, deferred, load, compact = false, streaming = false }: { text: string; deferred: boolean; load?: () => Promise<string>; compact?: boolean; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [state, setState] = useState<"" | "loading" | "error">("");
  if (!text && !deferred) return null;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && deferred && load && loaded === null && state !== "loading") {
      setState("loading");
      load().then((value) => { setLoaded(value); setState(""); }, () => setState("error"));
    }
  };
  const body = deferred
    ? (loaded ?? (state === "loading" ? "正在加载思考内容…" : state === "error" ? "思考内容加载失败" : "历史思考内容已延迟加载"))
    : text;
  return <div className={`thinking-block ${compact ? "compact" : ""}`}><button onClick={toggle}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}思考过程{compact && !open && text ? <span className="thinking-preview">{preview(text)}</span> : null}</button>{open && <div><Markdown text={body} streaming={streaming} /></div>}</div>;
}

function ToolCall({ block, result, compact = false }: { block: ContentBlock; result?: SessionMessage; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const name = String(block.toolName || block.name || "工具调用");
  const input = toolText(block.input ?? block.rawInput);
  const output = result ? normalizeBlocks(result.content).map((item) => item.type === "text" ? String(item.text ?? "") : "[媒体]").filter(Boolean).join("\n") : "";
  const edit = editToolDiff(name, block.input ?? block.rawInput, result);
  const clippedOutput = clipToolText(output);
  const outputTruncated = clippedOutput !== output;
  return <div className={`original-tool-call ${compact ? "compact" : ""} ${result?.isError ? "error" : ""}`}>
    <button onClick={() => setOpen(!open)}>{compact && <i className={`tool-status ${result ? (result.isError ? "failed" : "done") : "pending"}`} aria-hidden="true" />}<ToolIcon name={name} /><strong>{name}</strong><span>{toolSummary(block.input ?? block.rawInput) || preview(input)}</span>{edit && <em className="diff-chips"><i className="add">+{edit.added}</i><i className="del">−{edit.removed}</i></em>}{!compact && result && <i className={`tool-verdict ${result.isError ? "failed" : "done"}`} aria-label={result.isError ? "失败" : "成功"}>{result.isError ? <X size={12} /> : <Check size={12} />}</i>}{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
    {open && <div className="tool-detail">{edit ? <DiffView diff={edit} /> : input && <><label>输入</label><pre>{clipToolText(input)}</pre></>}{result && (!edit || Boolean(result.isError)) && <><label>{result.isError ? "错误" : "结果"}</label>{clippedOutput ? <><Markdown text={clippedOutput} />{outputTruncated && <div className="tool-output-more">… 内容过长，已截断（共 {output.length} 字符）…</div>}</> : <div className="tool-output-empty">完成</div>}</>}</div>}
  </div>;
}

interface EditDiffLine { kind: "add" | "del" | "ctx" | "hunk"; text: string }
interface EditDiffInfo { path: string; added: number; removed: number; lines: EditDiffLine[]; truncated: boolean }

const DIFF_LINE_CAP = 400;

/** The pi edit tool reports a unified patch in result.details.patch; older or
 * failed runs fall back to the requested edits[] themselves. */
function editToolDiff(name: string, input: unknown, result?: SessionMessage): EditDiffInfo | null {
  if (!name.toLowerCase().includes("edit")) return null;
  const args = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const path = typeof args?.path === "string" ? args.path : "";
  const details = result && typeof result.details === "object" && result.details !== null ? result.details as Record<string, unknown> : null;
  const patch = typeof details?.patch === "string" ? details.patch : "";
  if (patch) return parseUnifiedPatch(patch, path);
  const edits = Array.isArray(args?.edits) ? args.edits : [];
  const lines: EditDiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const entry of edits) {
    if (!entry || typeof entry !== "object") continue;
    const { oldText, newText } = entry as Record<string, unknown>;
    if (typeof oldText === "string" && oldText) for (const line of oldText.split("\n")) { lines.push({ kind: "del", text: line }); removed += 1; }
    if (typeof newText === "string" && newText) for (const line of newText.split("\n")) { lines.push({ kind: "add", text: line }); added += 1; }
  }
  if (!added && !removed) return null;
  return { path, added, removed, lines: lines.slice(0, DIFF_LINE_CAP), truncated: lines.length > DIFF_LINE_CAP };
}

function parseUnifiedPatch(patch: string, path: string): EditDiffInfo | null {
  const lines: EditDiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) { lines.push({ kind: "hunk", text: raw }); continue; }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) continue;
    if (raw.startsWith("+")) { lines.push({ kind: "add", text: raw.slice(1) }); added += 1; continue; }
    if (raw.startsWith("-")) { lines.push({ kind: "del", text: raw.slice(1) }); removed += 1; continue; }
    lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  if (!added && !removed) return null;
  return { path, added, removed, lines: lines.slice(0, DIFF_LINE_CAP), truncated: lines.length > DIFF_LINE_CAP };
}

const DIFF_SIGNS: Record<EditDiffLine["kind"], string> = { add: "+", del: "−", ctx: "", hunk: "" };

function DiffView({ diff }: { diff: EditDiffInfo }) {
  return <div className="tool-diff">
    {diff.path && <div className="tool-diff-path">{diff.path}</div>}
    <pre>{diff.lines.map((line, index) => <div key={index} className={`diff-line ${line.kind}`}><span className="diff-sign">{DIFF_SIGNS[line.kind]}</span><span>{line.text}</span></div>)}</pre>
    {diff.truncated && <div className="tool-diff-more">… diff 过长，仅显示前 {DIFF_LINE_CAP} 行 …</div>}
  </div>;
}

function ToolIcon({ name }: { name: string }) {
  const lowered = name.toLowerCase();
  if (lowered === "bash" || lowered.includes("terminal") || lowered.includes("shell")) return <TerminalSquare size={13} />;
  if (/read|write|edit|file/.test(lowered)) return <FileCode2 size={13} />;
  if (/grep|find|search|glob/.test(lowered)) return <Search size={13} />;
  if (/todo|task|checklist/.test(lowered)) return <Check size={13} />;
  if (/agent|workflow|subagent/.test(lowered)) return <GitFork size={13} />;
  return <Wrench size={13} />;
}

function BashMessage({ message }: { message: SessionMessage }) {
  const output = String(message.output ?? "");
  return <div className="bash-message"><div><Command size={13} /><code>{String(message.command ?? "")}</code></div>{output && <Markdown text={output} />}</div>;
}

function CustomMessage({ message }: { message: SessionMessage }) {
  const text = normalizeBlocks(message.content).map((block) => String(block.text ?? "")).join("\n");
  if (!text) return null;
  return <div className={`custom-message ${message.customType === "stream_error" ? "stream-error-message" : ""}`}><strong>{message.customType === "compaction" ? "上下文已压缩" : message.customType === "stream_error" ? "远端响应错误" : "系统消息"}</strong><Markdown text={text} /></div>;
}

/** Re-parse budget for the one message that is still streaming. */
const STREAM_PARSE_INTERVAL_MS = 140;

/** Finalized messages keep their object identity across frames, so this memo
 * never re-parses them. The streaming message is the exception: its text grows
 * every frame, so `streaming` throttles how often the (whole-document)
 * normalizeDisplayMath + remark + KaTeX pass runs. */
function useStreamedText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const latest = useRef(text);
  const timer = useRef(0);
  latest.current = text;
  useEffect(() => {
    if (!streaming) {
      if (timer.current) { window.clearTimeout(timer.current); timer.current = 0; }
      setShown(text);
      return;
    }
    // Never restart a pending timer: at delta rates that would starve it into a
    // debounce that only fires once the model pauses. The timer reads the ref.
    if (timer.current) return;
    timer.current = window.setTimeout(() => { timer.current = 0; setShown(latest.current); }, STREAM_PARSE_INTERVAL_MS);
  }, [text, streaming]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  // Once streaming stops the prop wins outright, so message_end paints the full
  // final text in that same commit instead of waiting on a throttled tick.
  return streaming ? shown : text;
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const body = useStreamedText(text, streaming);
  const normalized = useMemo(() => normalizeDisplayMath(body), [body]);
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]} components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" />, pre: (props) => <CodeBlock {...props} />, code: ({ className, children, ...props }) => <code className={className} {...props}>{children}</code>, table: (props) => <div className="table-wrap"><table {...props} /></div> }}>{normalized}</ReactMarkdown></div>;
});

function CodeBlock({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return <div className="code-block">
    <pre ref={preRef} {...props}>{children}</pre>
    <button className="code-copy" aria-label="复制代码" onClick={() => copy(preRef.current?.innerText ?? "", setCopied)}><Copy size={11} />{copied ? "已复制" : "复制"}</button>
  </div>;
}

function MessageImage({ block }: { block: ContentBlock }) {
  const source = block.source as Record<string, unknown> | undefined;
  const base64 = typeof source?.data === "string" ? source.data : typeof block.data === "string" ? block.data : "";
  const src = source?.type === "base64" ? `data:${source.media_type};base64,${source.data}` : String(source?.url || block.url || (block.data ? `data:${block.mimeType};base64,${block.data}` : ""));
  if (!src) return null;
  const mime = String(source?.media_type ?? block.mimeType ?? "image");
  const caption = base64 ? `${mime} · ${formatBytes(Math.floor(base64.length * 3 / 4))}` : mime;
  return <figure className="message-image"><img src={src} alt="" /><figcaption>{caption}</figcaption></figure>;
}

function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }

function normalizeBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((item): item is ContentBlock => Boolean(item) && typeof item === "object") : [];
}
function toolText(value: unknown) { return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2); }
/** Long tool payloads are clipped before they reach the DOM (pi-app style caps). */
function clipToolText(value: string, cap = 20_000): string {
  return value.length <= cap ? value : `${value.slice(0, cap)}\n… 内容过长，已截断（共 ${value.length} 字符）…`;
}
/** PiDeck-style one-liner: surface the most telling argument instead of raw JSON. */
function toolSummary(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const args = value as Record<string, unknown>;
    for (const key of ["command", "path", "filePath", "file", "pattern", "query", "url"]) {
      const entry = args[key];
      if (typeof entry === "string" && entry.trim()) return preview(entry);
    }
  }
  return "";
}
function preview(value: string) { return value.replace(/\s+/g, " ").slice(0, 90); }
function formatTime(value: unknown) { return typeof value === "number" ? new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : null; }
function copy(text: string, setter: (value: boolean) => void) { void navigator.clipboard.writeText(text).then(() => { setter(true); window.setTimeout(() => setter(false), 1400); }); }
