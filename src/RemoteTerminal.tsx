import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { closeRemoteTerminal, createRemoteTerminal, isTauriEnvironment, readRemoteTerminal, remoteTerminalEventMatchesDevice, resizeRemoteTerminal, startRemoteTerminalStream, stopRemoteTerminalStream, writeRemoteTerminal } from "./lib";
import { listenDesktopEvent } from "./desktopTransport";
import type { Device, RemoteSession, RemoteTerminalEventPayload } from "./types";

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
      let stopStream: (() => void) | undefined;
      const terminal = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: "'DM Mono', Menlo, monospace", fontSize: 11, theme: { background: "#101216", foreground: "#d8dadd", cursor: "#60a5fa", selectionBackground: "#60a5fa44" } });
      const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host); fit.fit(); terminal.focus();
      const dataDisposable = terminal.onData((data) => { if (terminalId) void writeRemoteTerminal(device, terminalId, data); });
      const resizeDisposable = terminal.onResize(({ cols, rows }) => { if (terminalId) void resizeRemoteTerminal(device, terminalId, cols, rows); });
      const observer = new ResizeObserver(() => { try { fit.fit(); } catch { /* closed */ } }); observer.observe(host);

      // Fallback for browsers and older servers without /events: cursor-based
      // incremental polling, unchanged from the original implementation.
      const stopPolling = () => { if (poll) { window.clearInterval(poll); poll = 0; } };
      const startPolling = () => {
        if (!alive || poll) return;
        let reading = false;
        poll = window.setInterval(async () => { if (reading) return; reading = true; try { const value = await readRemoteTerminal(device, terminalId, cursor); if (value.reset) terminal.clear(); if (value.chunk) terminal.write(value.chunk); cursor = value.cursor; } catch (cause) { if (alive) { setError(cause instanceof Error ? cause.message : String(cause)); stopPolling(); } } finally { reading = false; } }, 250);
      };

      // Desktop: subscribe to the server's terminal SSE stream via Rust. The
      // first output frame is a full snapshot, so a reconnect clears before
      // writing it. Any stream failure falls back to polling.
      const startStream = async () => {
        let snapshotPending = true;
        let generation = 0;
        let unlisten: (() => void) | undefined;
        try {
          unlisten = await listenDesktopEvent<RemoteTerminalEventPayload>("pihub-terminal-event", (payload) => {
            if (!alive || payload.terminalId !== terminalId || payload.generation < generation) return;
            if (!remoteTerminalEventMatchesDevice(payload, device)) return;
            const event = payload.event;
            if (event.type === "output") {
              if (snapshotPending) { terminal.clear(); snapshotPending = false; }
              terminal.write(String(event.data ?? ""));
            } else if (event.type === "exit") {
              setError("远程终端已退出");
            } else if (event.type === "stream_error") {
              stopStream?.();
              startPolling();
            }
          });
          generation = await startRemoteTerminalStream(device, terminalId);
        } catch {
          unlisten?.();
          startPolling();
          return;
        }
        stopStream = () => { unlisten?.(); void stopRemoteTerminalStream(device, terminalId); };
      };

      void createRemoteTerminal(device, session.cwd).then(async (created) => {
        if (!alive) { void closeRemoteTerminal(device, created.id); return; }
        terminalId = created.id; setConnecting(false); fit.fit(); await resizeRemoteTerminal(device, terminalId, terminal.cols, terminal.rows);
        if (isTauriEnvironment()) await startStream();
        else startPolling();
      }).catch((cause) => {
        if (!alive) return;
        setConnecting(false); setError(cause instanceof Error ? cause.message : String(cause)); terminal.writeln("\r\n无法启动终端。请确认服务端已升级为 PiHub Server。");
      });

      disposeTerminal = () => {
        window.clearInterval(poll); stopStream?.(); observer.disconnect(); dataDisposable.dispose(); resizeDisposable.dispose(); terminal.dispose();
        if (terminalId) void closeRemoteTerminal(device, terminalId);
      };
    }, 0);

    return () => { alive = false; window.clearTimeout(startup); disposeTerminal?.(); };
  }, [device, session.cwd]);
  return <div className="remote-terminal-wrap"><div ref={container} className="remote-terminal" />{connecting && <div className="terminal-connecting"><span className="terminal-dot" />正在建立远程 PTY…</div>}{error && <div className="terminal-error" role="alert">{error}</div>}</div>;
}
