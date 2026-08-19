import { useEffect, useRef, useState } from "react";
import { CircleAlert, Pencil } from "lucide-react";

// WKWebView does not implement window.prompt/confirm (they silently return
// null/false), so all rename/delete interactions use these dialogs instead.

export function useDialogFocus<T extends HTMLElement>(onClose: () => void, returnFocus?: HTMLElement | null) {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  onCloseRef.current = onClose;
  useEffect(() => {
    const previousFocus = previousFocusRef.current;
    const onKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const openDialogs = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')];
      if (openDialogs.at(-1) !== dialog) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); onCloseRef.current(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog && !dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>("input, textarea, button")?.focus();
    });
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", onKey); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  return dialogRef;
}

export function NamePromptDialog({ title, initial, submitLabel = "保存", onSubmit, onClose }: {
  title: string;
  initial: string;
  submitLabel?: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  return <div className="modal-backdrop ask-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="ask-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <header><span className="ask-icon"><Pencil size={17} /></span><div><h3>{title}</h3></div></header>
      <form onSubmit={(event) => { event.preventDefault(); const name = value.trim(); if (name) onSubmit(name); }}>
        <input className="ask-input" aria-label={title} autoFocus value={value} onChange={(event) => setValue(event.target.value)} onFocus={(event) => event.target.select()} />
        <footer><button type="button" className="ask-cancel" onClick={onClose}>取消</button><button type="submit" className="ask-confirm" disabled={!value.trim()}>{submitLabel}</button></footer>
      </form>
    </section>
  </div>;
}

export function ConfirmDialog({ title, message, confirmLabel = "确认", danger = false, returnFocus, onConfirm, onClose }: {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  returnFocus?: HTMLElement | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLElement>(onClose, returnFocus);
  return <div className="modal-backdrop ask-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className="ask-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
      <header><span className="ask-icon" style={danger ? { color: "var(--danger)" } : undefined}><CircleAlert size={17} /></span><div><h3>{title}</h3>{message && <p>{message}</p>}</div></header>
      <footer><button className="ask-cancel" onClick={onClose}>取消</button><button className="ask-confirm" autoFocus style={danger ? { background: "var(--danger)" } : undefined} onClick={onConfirm}>{confirmLabel}</button></footer>
    </section>
  </div>;
}
