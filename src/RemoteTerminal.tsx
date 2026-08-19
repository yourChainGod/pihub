import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { closeRemoteTerminal, createRemoteTerminal, readRemoteTerminal, resizeRemoteTerminal, writeRemoteTerminal } from "./lib";
import type { Device, RemoteSession } from "./types";

export default function RemoteTerminal({ device, session }: { device: Device; session: RemoteSession }) {
  const container = useRef<HTMLDivElement>(null); const [error, setError] = useState(""); const [connecting, setConnecting] = useState(true);
  useEffect(() => {
    let alive = true;
    let disposeTerminal: (() => void) | undefined;

    // StrictMode immediately tears down and replays effects in development.
    // Deferring setup prevents that probe from opening a duplicate remote PTY.
    const startup = window.setTimeout(() => {
      const host = container.current;
      if (!alive || !host) return;

      let terminalId = "";
      let poll = 0;
      let cursor = 0;
      const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: "'DM Mono', Menlo, monospace", fontSize: 11, theme: { background: "#101216", foreground: "#d8dadd", cursor: "#60a5fa", selectionBackground: "#60a5fa44" } });
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host); fit.fit(); terminal.focus();
      const dataDisposable = terminal.onData((data) => { if (terminalId) void writeRemoteTerminal(device, terminalId, data); });
      const resizeDisposable = terminal.onResize(({ cols, rows }) => { if (terminalId) void resizeRemoteTerminal(device, terminalId, cols, rows); });
      const observer = new ResizeObserver(() => { try { fit.fit(); } catch { /* closed */ } }); observer.observe(host);

      void createRemoteTerminal(device, session.cwd).then(async (created) => {
        if (!alive) { void closeRemoteTerminal(device, created.id); return; }
        terminalId = created.id; setConnecting(false); fit.fit(); await resizeRemoteTerminal(device, terminalId, terminal.cols, terminal.rows);
        // Cursor-based incremental reads keep the terminal stable between polls.
        let reading = false; poll = window.setInterval(async () => { if (reading) return; reading = true; try { const value = await readRemoteTerminal(device, terminalId, cursor); if (value.reset) terminal.clear(); if (value.chunk) terminal.write(value.chunk); cursor = value.cursor; } catch (cause) { if (alive) { setError(cause instanceof Error ? cause.message : String(cause)); window.clearInterval(poll); } } finally { reading = false; } }, 250);
      }).catch((cause) => {
        if (!alive) return;
        setConnecting(false); setError(cause instanceof Error ? cause.message : String(cause)); terminal.writeln("\r\n无法启动终端。请确认服务端已升级为 PiHub Server。");
      });

      disposeTerminal = () => {
        window.clearInterval(poll); observer.disconnect(); dataDisposable.dispose(); resizeDisposable.dispose(); terminal.dispose();
        if (terminalId) void closeRemoteTerminal(device, terminalId);
      };
    }, 0);

    return () => { alive = false; window.clearTimeout(startup); disposeTerminal?.(); };
  }, [device, session.cwd]);
  return <div className="remote-terminal-wrap"><div ref={container} className="remote-terminal" />{connecting && <div className="terminal-connecting"><span className="terminal-dot" />正在建立远程 PTY…</div>}{error && <div className="terminal-error" role="alert">{error}</div>}</div>;
}
