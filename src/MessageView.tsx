import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { ChevronDown, ChevronRight, CircleAlert, Command, Copy, GitFork, Wrench } from "lucide-react";
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

  return <>{messages.map((message, index) => (
    <MessageView
      key={entryIds?.[index] ?? `${message.role}-${message.timestamp ?? index}`}
      message={message}
      toolResults={results}
      entryId={entryIds?.[index]}
      onFork={onFork}
      forking={forkingId !== undefined && entryIds?.[index] === forkingId}
      onLoadThinking={onLoadThinking}
    />
  ))}</>;
}

function MessageView({ message, toolResults, entryId, onFork, forking, onLoadThinking }: { message: SessionMessage; toolResults: Map<string, SessionMessage>; entryId?: string; onFork?: (entryId: string) => void; forking?: boolean; onLoadThinking?: (entryId: string, blockIndex: number) => Promise<string> }) {
  if (message.role === "toolResult") return null;
  if (message.role === "user") return <UserMessage message={message} entryId={entryId} onFork={onFork} forking={forking} />;
  if (message.role === "assistant") return <AssistantMessage message={message} toolResults={toolResults} entryId={entryId} onLoadThinking={onLoadThinking} />;
  if (message.role === "bashExecution") return <BashMessage message={message} />;
  if (message.role === "custom") return <CustomMessage message={message} />;
  return null;
}

function UserMessage({ message, entryId, onFork, forking }: { message: SessionMessage; entryId?: string; onFork?: (entryId: string) => void; forking?: boolean }) {
  const [copied, setCopied] = useState(false);
  const blocks = normalizeBlocks(message.content);
  const text = blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("\n");
  const images = blocks.filter((block) => block.type === "image");
  return <article className="original-message user-message">
    <div className="user-bubble">
      {images.map((block, index) => <MessageImage key={index} block={block} />)}
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
  const blocks = normalizeBlocks(message.content);
  const modelLabel = message.model || message.provider ? String(message.model ?? message.provider) : "";
  if (!blocks.length && message.stopReason !== "error") return null;
  return <article className="original-message assistant-message">
    {modelLabel && <div className="model-label">{modelLabel}</div>}
    {blocks.map((block, index) => <Block key={index} block={block} result={typeof block.toolCallId === "string" ? toolResults.get(block.toolCallId) : undefined} loadThinking={entryId && onLoadThinking ? () => onLoadThinking(entryId, index) : undefined} />)}
    {message.stopReason === "error" && <div className="provider-error"><CircleAlert size={14} />{String(message.errorMessage || "模型返回错误")}</div>}
    <div className="assistant-time">{formatTime(message.timestamp)}</div>
  </article>;
}

function Block({ block, result, loadThinking }: { block: ContentBlock; result?: SessionMessage; loadThinking?: () => Promise<string> }) {
  if (block.type === "text") return <Markdown text={String(block.text ?? "")} />;
  if (block.type === "image") return <MessageImage block={block} />;
  if (block.type === "thinking") return <ThinkingBlock text={String(block.thinking ?? "")} deferred={Boolean(block.deferred)} load={loadThinking} />;
  if (block.type === "toolCall") return <ToolCall block={block} result={result} />;
  return null;
}

function ThinkingBlock({ text, deferred, load }: { text: string; deferred: boolean; load?: () => Promise<string> }) {
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
  return <div className="thinking-block"><button onClick={toggle}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}思考过程</button>{open && <div><Markdown text={body} /></div>}</div>;
}

function ToolCall({ block, result }: { block: ContentBlock; result?: SessionMessage }) {
  const [open, setOpen] = useState(false);
  const name = String(block.toolName || block.name || "工具调用");
  const input = toolText(block.input ?? block.rawInput);
  const output = result ? normalizeBlocks(result.content).map((item) => item.type === "text" ? String(item.text ?? "") : "[媒体]").filter(Boolean).join("\n") : "";
  return <div className={`original-tool-call ${result?.isError ? "error" : ""}`}>
    <button onClick={() => setOpen(!open)}><Wrench size={13} /><strong>{name}</strong><span>{preview(input)}</span>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
    {open && <div className="tool-detail">{input && <><label>输入</label><pre>{input}</pre></>}{result && <><label>{result.isError ? "错误" : "结果"}</label><pre>{output || "完成"}</pre></>}</div>}
  </div>;
}

function BashMessage({ message }: { message: SessionMessage }) {
  return <div className="bash-message"><div><Command size={13} /><code>{String(message.command ?? "")}</code></div><pre>{String(message.output ?? "")}</pre></div>;
}

function CustomMessage({ message }: { message: SessionMessage }) {
  const text = normalizeBlocks(message.content).map((block) => String(block.text ?? "")).join("\n");
  if (!text) return null;
  return <div className={`custom-message ${message.customType === "stream_error" ? "stream-error-message" : ""}`}><strong>{message.customType === "compaction" ? "上下文已压缩" : message.customType === "stream_error" ? "远端响应错误" : "系统消息"}</strong><Markdown text={text} /></div>;
}

export function Markdown({ text }: { text: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]} components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" />, code: ({ className, children, ...props }) => <code className={className} {...props}>{children}</code>, table: (props) => <div className="table-wrap"><table {...props} /></div> }}>{normalizeDisplayMath(text)}</ReactMarkdown></div>;
}

function MessageImage({ block }: { block: ContentBlock }) {
  const source = block.source as Record<string, unknown> | undefined;
  const src = source?.type === "base64" ? `data:${source.media_type};base64,${source.data}` : String(source?.url || block.url || (block.data ? `data:${block.mimeType};base64,${block.data}` : ""));
  return src ? <img className="message-image" src={src} alt="" /> : null;
}

function normalizeBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((item): item is ContentBlock => Boolean(item) && typeof item === "object") : [];
}
function toolText(value: unknown) { return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2); }
function preview(value: string) { return value.replace(/\s+/g, " ").slice(0, 90); }
function formatTime(value: unknown) { return typeof value === "number" ? new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : null; }
function copy(text: string, setter: (value: boolean) => void) { void navigator.clipboard.writeText(text).then(() => { setter(true); window.setTimeout(() => setter(false), 1400); }); }
