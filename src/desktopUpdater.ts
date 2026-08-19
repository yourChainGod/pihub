import { invokeDesktop, isDesktopEnvironment, listenDesktopEvent } from "./desktopTransport";

export const DESKTOP_UPDATE_EVENT = "pihub-desktop-update";

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "upToDate"
  | "downloading"
  | "verifying"
  | "installing"
  | "readyToRestart"
  | "restarting"
  | "failed";

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  checkedAt?: number;
  errorCode?: string;
  errorMessage?: string;
}

export function supportsDesktopUpdates(): boolean {
  return isDesktopEnvironment();
}

export async function desktopUpdateStatus(): Promise<DesktopUpdateState | null> {
  if (!supportsDesktopUpdates()) return null;
  return invokeDesktop<DesktopUpdateState>("desktop_update_status");
}

export async function checkDesktopUpdate(): Promise<DesktopUpdateState> {
  if (!supportsDesktopUpdates()) throw new Error("桌面更新仅在 PiHub 客户端中可用。");
  return invokeDesktop<DesktopUpdateState>("desktop_update_check");
}

export async function installDesktopUpdate(): Promise<DesktopUpdateState> {
  if (!supportsDesktopUpdates()) throw new Error("桌面更新仅在 PiHub 客户端中可用。");
  return invokeDesktop<DesktopUpdateState>("desktop_update_install");
}

export async function cancelDesktopUpdate(): Promise<DesktopUpdateState> {
  if (!supportsDesktopUpdates()) throw new Error("桌面更新仅在 PiHub 客户端中可用。");
  return invokeDesktop<DesktopUpdateState>("desktop_update_cancel");
}

export async function restartAfterDesktopUpdate(): Promise<DesktopUpdateState> {
  if (!supportsDesktopUpdates()) throw new Error("桌面更新仅在 PiHub 客户端中可用。");
  return invokeDesktop<DesktopUpdateState>("desktop_update_restart");
}

export async function onDesktopUpdate(
  callback: (state: DesktopUpdateState) => void,
): Promise<() => void> {
  if (!supportsDesktopUpdates()) return () => {};
  return listenDesktopEvent<DesktopUpdateState>(DESKTOP_UPDATE_EVENT, callback);
}

export function desktopUpdatePercent(state: DesktopUpdateState): number | null {
  if (!state.totalBytes || state.downloadedBytes === undefined) return null;
  return Math.max(0, Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100)));
}
