import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionMessage } from "./types";

/**
 * Scroll minimap ported from pi-web's ChatMinimap: a slim rail on the right
 * edge with one node per user turn (evenly spaced, not proportional), the
 * active turn highlighted from the scroll position, and a hover preview panel
 * listing each turn's question and assistant outline. Click/drag jumps.
 */

const MINIMAP_PADDING = 12;
const MAX_NODE_GAP = 50;
const PREVIEW_HIDE_DELAY = 250;
const NAV_ACTIVE_LOCK_MS = 1600;

interface OutlineItem { level: number; text: string }
interface AssistantPreview { items: OutlineItem[]; element: HTMLElement | null }
interface Turn { userText: string; scrollTop: number | null; assistants: AssistantPreview[] }
interface NodeLayout { gap: number; fillsHeight: boolean }

type ContentBlock = Record<string, unknown>;

function contentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? content.filter((item): item is ContentBlock => Boolean(item) && typeof item === "object") : [];
}

function userText(message: SessionMessage): string {
  return contentBlocks(message.content)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n")
    .trim();
}

function assistantAnswerText(message: SessionMessage): string {
  return contentBlocks(message.content)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("\n\n")
    .trim();
}

/** Headings (h1–h3) from the answer markdown; falls back to the first paragraph line. */
function extractOutline(markdown: string): OutlineItem[] {
  const lines = markdown.split("\n");
  const headings: OutlineItem[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = /^(#{1,3})\s+(.+)$/.exec(line.trimEnd());
    if (match) headings.push({ level: match[1].length, text: match[2].trim() });
  }
  if (headings.length) return headings;
  inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const text = line.trim();
    if (text && !/^(#{1,6}\s|[-*+>|]|\||---)/.test(text)) return [{ level: 0, text }];
  }
  return [];
}

function layoutGap(count: number, height: number): NodeLayout {
  if (count <= 1) return { gap: MAX_NODE_GAP, fillsHeight: false };
  const usable = Math.max(0, height - MINIMAP_PADDING * 2);
  const natural = usable / (count - 1);
  return { gap: Math.min(MAX_NODE_GAP, natural), fillsHeight: natural <= MAX_NODE_GAP };
}

export default function ChatMinimap({ messages, scrollRef }: { messages: SessionMessage[]; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const previewItemRefs = useRef(new Map<number, HTMLDivElement>());
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeLockRef = useRef<{ index: number; until: number } | null>(null);
  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  const layoutRef = useRef<NodeLayout>({ gap: MAX_NODE_GAP, fillsHeight: false });
  const heightRef = useRef(0);

  const [visible, setVisible] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [height, setHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);

  const layout = useMemo(() => layoutGap(turns.length, height), [turns.length, height]);
  layoutRef.current = layout;
  heightRef.current = height;

  const syncActive = useCallback((scroll: HTMLDivElement, nextTurns: Turn[]) => {
    const lock = activeLockRef.current;
    if (lock && Date.now() < lock.until) { setActiveIndex(lock.index); return; }
    activeLockRef.current = null;
    const measured = nextTurns.map((turn, index) => ({ turn, index })).filter((item) => item.turn.scrollTop !== null);
    if (!measured.length) { setActiveIndex(null); return; }
    const focus = scroll.scrollTop + scroll.clientHeight * 0.3;
    let best = measured[0];
    for (const item of measured) {
      if (Math.abs((item.turn.scrollTop ?? 0) - focus) < Math.abs((best.turn.scrollTop ?? 0) - focus)) best = item;
    }
    setActiveIndex(best.index);
  }, []);

  const measure = useCallback(() => {
    const scroll = scrollRef.current;
    const track = trackRef.current;
    if (!scroll || !track) return;
    const containerRect = scroll.getBoundingClientRect();
    // `.original-message` covers user + assistant nodes in render order. Walk it
    // in lockstep with the message list, replicating MessageView's null-render
    // conditions (toolResult/bash/custom render under different classes; an
    // empty assistant without an error renders nothing).
    const elements = Array.from(scroll.querySelectorAll<HTMLElement>(".original-message"));
    const next: Turn[] = [];
    let elementIndex = 0;
    let current: Turn | null = null;
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const renders = message.role === "user" || contentBlocks(message.content).length > 0 || message.stopReason === "error";
      const element = renders ? elements[elementIndex++] ?? null : null;
      if (message.role === "user") {
        current = {
          userText: userText(message),
          scrollTop: element ? element.getBoundingClientRect().top - containerRect.top + scroll.scrollTop : null,
          assistants: [],
        };
        next.push(current);
        continue;
      }
      if (!current) continue;
      const answer = assistantAnswerText(message);
      if (answer) current.assistants.push({ items: extractOutline(answer), element });
    }
    turnsRef.current = next;
    setTurns(next);
    setHeight(track.clientHeight);
    setVisible(scroll.scrollHeight - scroll.clientHeight > 20);
    syncActive(scroll, next);
  }, [messages, scrollRef, syncActive]);

  const measureThrottled = useCallback(() => {
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => { measureThrottleRef.current = null; measure(); }, 150);
  }, [measure]);

  const updateScroll = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    setVisible(scroll.scrollHeight - scroll.clientHeight > 20);
    syncActive(scroll, turnsRef.current);
  }, [scrollRef, syncActive]);

  // Visibility must not depend on the track being mounted (that deadlocks:
  // no track → no measure → never visible). Scroll events and this effect
  // decide visibility; once visible the track mounts and the effect below
  // takes over measurement.
  useEffect(() => {
    const timer = setTimeout(() => { updateScroll(); }, 50);
    return () => clearTimeout(timer);
  }, [messages.length, updateScroll]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const track = trackRef.current;
    if (!scroll || !track || !visible) return;
    measure();
    const observer = new ResizeObserver(measureThrottled);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    observer.observe(track);
    scroll.addEventListener("scroll", updateScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", updateScroll);
      if (measureThrottleRef.current) { clearTimeout(measureThrottleRef.current); measureThrottleRef.current = null; }
    };
  }, [visible, measure, measureThrottled, scrollRef, updateScroll]);

  const lockActive = useCallback((index: number) => {
    activeLockRef.current = { index, until: Date.now() + NAV_ACTIVE_LOCK_MS };
    setActiveIndex(index);
  }, []);

  const scrollToTurn = useCallback((index: number, behavior: ScrollBehavior) => {
    const scroll = scrollRef.current;
    const top = turnsRef.current[index]?.scrollTop;
    if (!scroll || top === null || top === undefined) return;
    lockActive(index);
    scroll.scrollTo({ top: Math.max(0, top - scroll.clientHeight * 0.3), behavior });
  }, [lockActive, scrollRef]);

  const scrollToAssistant = useCallback((turnIndex: number, assistantIndex: number) => {
    const scroll = scrollRef.current;
    const element = turnsRef.current[turnIndex]?.assistants[assistantIndex]?.element;
    if (!scroll || !element) return;
    const rect = element.getBoundingClientRect();
    const containerRect = scroll.getBoundingClientRect();
    lockActive(turnIndex);
    scroll.scrollTo({ top: Math.max(0, rect.top - containerRect.top + scroll.scrollTop - scroll.clientHeight * 0.3), behavior: "smooth" });
  }, [lockActive, scrollRef]);

  const scrollToHeading = useCallback((turnIndex: number, assistantIndex: number, headingIndex: number) => {
    const scroll = scrollRef.current;
    const element = turnsRef.current[turnIndex]?.assistants[assistantIndex]?.element;
    const heading = element?.querySelectorAll<HTMLElement>("h1, h2, h3").item(headingIndex);
    if (!scroll || !element || !heading) { scrollToAssistant(turnIndex, assistantIndex); return; }
    const rect = heading.getBoundingClientRect();
    const containerRect = scroll.getBoundingClientRect();
    lockActive(turnIndex);
    scroll.scrollTo({ top: Math.max(0, rect.top - containerRect.top + scroll.scrollTop - scroll.clientHeight * 0.3), behavior: "smooth" });
  }, [lockActive, scrollRef, scrollToAssistant]);

  const findNearest = useCallback((ratio: number): number | null => {
    const count = turnsRef.current.length;
    const trackHeight = heightRef.current;
    if (!count || trackHeight <= 0) return null;
    const { gap, fillsHeight } = layoutRef.current;
    const pointerY = Math.max(0, Math.min(trackHeight, ratio * trackHeight));
    const index = Math.max(0, Math.min(count - 1, gap > 0 ? Math.round((pointerY - MINIMAP_PADDING) / gap) : 0));
    if (!fillsHeight) {
      const nodeY = MINIMAP_PADDING + index * gap;
      if (Math.abs(pointerY - nodeY) > Math.max(10, gap / 2)) return null;
    }
    return index;
  }, []);

  const cancelPreviewHide = useCallback(() => {
    if (previewHideTimerRef.current) { clearTimeout(previewHideTimerRef.current); previewHideTimerRef.current = null; }
  }, []);
  const showPreview = useCallback(() => { cancelPreviewHide(); setHovered(true); }, [cancelPreviewHide]);
  const schedulePreviewHide = useCallback(() => {
    cancelPreviewHide();
    previewHideTimerRef.current = setTimeout(() => { previewHideTimerRef.current = null; setHovered(false); setMouseYRatio(null); }, PREVIEW_HIDE_DELAY);
  }, [cancelPreviewHide]);
  useEffect(() => () => cancelPreviewHide(), [cancelPreviewHide]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!visible) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    showPreview();
    const rect = event.currentTarget.getBoundingClientRect();
    const jump = (clientY: number, behavior: ScrollBehavior) => {
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      setMouseYRatio(ratio);
      const index = findNearest(ratio);
      if (index !== null) scrollToTurn(index, behavior);
    };
    jump(event.clientY, "smooth");
    const onMove = (moveEvent: PointerEvent) => { if (moveEvent.buttons === 1) jump(moveEvent.clientY, "auto"); };
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [findNearest, scrollToTurn, showPreview, visible]);

  const nearestIndex = mouseYRatio === null ? null : findNearest(mouseYRatio);

  // Keep the located turn centered inside the preview panel while hovering.
  useEffect(() => {
    if (!hovered || nearestIndex === null) return;
    const box = previewBoxRef.current;
    const item = previewItemRefs.current.get(nearestIndex);
    if (!box || !item) return;
    box.scrollTop = Math.max(0, item.offsetTop - (box.clientHeight - item.offsetHeight) / 2);
  }, [turns, hovered, nearestIndex]);

  if (!visible) return null;

  const nodeTop = (index: number) => (turns.length === 1 ? MINIMAP_PADDING : MINIMAP_PADDING + index * layout.gap);
  const railHeight = Math.max(1, nodeTop(turns.length - 1) - MINIMAP_PADDING);

  return <div
    ref={trackRef}
    className="chat-minimap"
    onPointerDown={handlePointerDown}
    onMouseEnter={showPreview}
    onMouseLeave={schedulePreviewHide}
    onMouseMove={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setMouseYRatio((event.clientY - rect.top) / rect.height);
    }}
  >
    <div className="chat-minimap-rail" style={{ height: railHeight }} />
    {turns.map((_, index) => <div key={index} className="chat-minimap-node" style={{ top: nodeTop(index), height: Math.max(1, layout.gap) }}>
      <div className={`chat-minimap-dot ${activeIndex === index ? "active" : ""} ${hovered && nearestIndex === index ? "nearest" : ""}`} />
    </div>)}

    {hovered && turns.length > 0 && <div
      ref={previewBoxRef}
      className="minimap-preview"
      onMouseEnter={showPreview}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseMove={(event) => event.stopPropagation()}
    >
      {turns.map((turn, index) => <div
        key={index}
        ref={(element) => { if (element) previewItemRefs.current.set(index, element); else previewItemRefs.current.delete(index); }}
        className="minimap-turn"
        data-located={nearestIndex === index ? "true" : undefined}
      >
        <span className="minimap-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
        <div className="minimap-content">
          <button type="button" className="minimap-user" onClick={() => scrollToTurn(index, "smooth")}>
            <span className="minimap-user-text">{turn.userText || "（无文本）"}</span>
          </button>
          {turn.assistants.map((assistant, assistantIndex) => <div key={assistantIndex} className="minimap-assistant">
            <button type="button" className="minimap-assistant-jump" title="定位到该回答" onClick={() => scrollToAssistant(index, assistantIndex)}>A</button>
            <div className="minimap-outline">
              {assistant.items.map((item, itemIndex) => item.level === 0
                ? <button key={itemIndex} type="button" className="minimap-paragraph" onClick={() => scrollToAssistant(index, assistantIndex)}>{item.text}</button>
                : <button key={itemIndex} type="button" className="minimap-heading" data-level={item.level} onClick={() => scrollToHeading(index, assistantIndex, itemIndex)}>{item.text}</button>)}
            </div>
          </div>)}
        </div>
      </div>)}
    </div>}
  </div>;
}
