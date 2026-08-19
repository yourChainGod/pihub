import { invoke } from "@tauri-apps/api/core";

export interface DesktopWindowBridge {
  isFullscreen(): Promise<boolean>;
  onResized(callback: () => void): Promise<() => void>;
  startDragging(): Promise<void>;
}

export interface PiHubDesktopBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen?<T>(event: string, callback: (payload: T) => void): Promise<() => void>;
  window?: DesktopWindowBridge;
}

declare global {
  interface Window {
    __PIHUB_DESKTOP_BRIDGE__?: PiHubDesktopBridge;
    __TAURI_INTERNALS__?: unknown;
  }
}

function injectedBridge(): PiHubDesktopBridge | undefined {
  const host = window.location.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return undefined;
  return window.__PIHUB_DESKTOP_BRIDGE__;
}

export function isDesktopEnvironment(): boolean {
  return Boolean(window.__TAURI_INTERNALS__ || injectedBridge());
}

export async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = injectedBridge();
  if (bridge) return bridge.invoke<T>(command, args);
  return invoke<T>(command, args);
}

export async function listenDesktopEvent<T>(event: string, callback: (payload: T) => void): Promise<() => void> {
  const bridge = injectedBridge();
  if (bridge?.listen) return bridge.listen(event, callback);
  if (!window.__TAURI_INTERNALS__) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, ({ payload }) => callback(payload));
}

export async function isDesktopWindowFullscreen(): Promise<boolean> {
  const bridge = injectedBridge();
  if (bridge?.window) return bridge.window.isFullscreen();
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().isFullscreen();
}

export async function onDesktopWindowResized(callback: () => void): Promise<() => void> {
  const bridge = injectedBridge();
  if (bridge?.window) return bridge.window.onResized(callback);
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().onResized(callback);
}

export async function startDesktopWindowDragging(): Promise<void> {
  const bridge = injectedBridge();
  if (bridge?.window) return bridge.window.startDragging();
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().startDragging();
}
