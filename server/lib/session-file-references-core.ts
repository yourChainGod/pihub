import type { SessionEntry } from "./types";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A read result can be truncated. Letting it authorize a whole-file download
// would amplify the original operation, so only successful mutations grant a
// capability for the exact file they wrote.
const TRUSTED_FILE_TOOL_NAMES = new Set(["write", "edit"]);
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

const SENSITIVE_PATH_SEGMENTS = new Set([
  ".aws",
  ".azure",
  ".codex",
  ".docker",
  ".git",
  ".gnupg",
  ".kube",
  ".password-store",
  ".pi",
  ".ssh",
  "appdata",
  "keychains",
  "secrets",
]);

const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
  "secrets.json",
  "shadow",
  "sudoers",
  "token",
  "token.json",
]);

interface StructuredFileToolCall {
  toolCallId: string;
  toolName: string;
  filePath: string;
}

export function isValidSessionId(sessionId: string | null): sessionId is string {
  return !!sessionId && SESSION_ID_RE.test(sessionId);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function isWindowsPath(value: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(value) || value.startsWith("//");
}

function sameExactPath(left: string, right: string): boolean {
  const normalizedLeft = normalizeSlashes(left);
  const normalizedRight = normalizeSlashes(right);
  if (isWindowsPath(normalizedLeft) || isWindowsPath(normalizedRight)) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function isAbsoluteFilePath(value: string): boolean {
  const normalized = normalizeSlashes(value);
  return normalized.startsWith("/") || WINDOWS_ABSOLUTE_RE.test(normalized) || normalized.startsWith("//");
}

/** External session capabilities must never cover OS state or likely credentials. */
export function isSensitiveExternalFilePath(filePath: string): boolean {
  if (!filePath || filePath.includes("\0") || filePath.length > 32_768) return true;

  const normalized = normalizeSlashes(filePath).toLowerCase();
  // Never mint an external-session capability for a network share or Windows
  // device namespace. The same path can resolve to different remote content.
  if (normalized.startsWith("//")) return true;
  const withoutDrive = normalized.replace(/^[a-z]:/, "");
  const segments = withoutDrive.split("/").filter(Boolean);
  const fileName = segments.at(-1) ?? "";

  if (isWindowsPath(normalized)) {
    if (segments.some((segment) => segment.includes(":") || /[. ]$/.test(segment))) return true;
    if (segments.some((segment) => {
      const stem = segment.split(".", 1)[0];
      return /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])$/i.test(stem);
    })) return true;
  }

  if (
    withoutDrive === "/etc"
    || withoutDrive.startsWith("/etc/")
    || withoutDrive === "/private/etc"
    || withoutDrive.startsWith("/private/etc/")
    || withoutDrive === "/proc"
    || withoutDrive.startsWith("/proc/")
    || withoutDrive === "/sys"
    || withoutDrive.startsWith("/sys/")
    || withoutDrive === "/dev"
    || withoutDrive.startsWith("/dev/")
    || withoutDrive === "/run"
    || withoutDrive.startsWith("/run/")
    || withoutDrive === "/system"
    || withoutDrive.startsWith("/system/")
    || withoutDrive === "/windows"
    || withoutDrive.startsWith("/windows/")
    || withoutDrive === "/programdata"
    || withoutDrive.startsWith("/programdata/")
    || withoutDrive === "/program files"
    || withoutDrive.startsWith("/program files/")
    || withoutDrive === "/program files (x86)"
    || withoutDrive.startsWith("/program files (x86)/")
    || withoutDrive === "/root"
    || withoutDrive.startsWith("/root/")
    || withoutDrive === "/boot"
    || withoutDrive.startsWith("/boot/")
  ) return true;

  if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment))) return true;
  const configIndex = segments.indexOf(".config");
  if (
    configIndex !== -1
    && ["gcloud", "gh", "hub", "op", "1password"].includes(segments[configIndex + 1] ?? "")
  ) return true;
  if (SENSITIVE_FILE_NAMES.has(fileName) || fileName.startsWith(".env.")) return true;
  if (/\.(?:key|pem|p12|pfx|jks|keystore)$/.test(fileName)) return true;

  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function structuredToolCallsFromEntry(entry: SessionEntry): StructuredFileToolCall[] {
  if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
    return [];
  }

  const calls: StructuredFileToolCall[] = [];
  for (const rawBlock of entry.message.content as unknown[]) {
    const block = asRecord(rawBlock);
    if (!block || block.type !== "toolCall") continue;

    // SessionManager exposes normalized fields, while older JSONL files retain
    // the SDK's id/name/arguments field names. Both forms are still structured.
    const toolCallId = typeof block.toolCallId === "string"
      ? block.toolCallId
      : typeof block.id === "string" ? block.id : null;
    const rawToolName = typeof block.toolName === "string"
      ? block.toolName
      : typeof block.name === "string" ? block.name : null;
    const input = asRecord(block.input) ?? asRecord(block.arguments);
    const rawPath = input?.path ?? input?.file_path;
    const toolName = rawToolName?.toLowerCase() ?? "";

    if (
      !toolCallId
      || !TRUSTED_FILE_TOOL_NAMES.has(toolName)
      || typeof rawPath !== "string"
      || !isAbsoluteFilePath(rawPath)
      || isSensitiveExternalFilePath(rawPath)
    ) continue;

    calls.push({ toolCallId, toolName, filePath: rawPath });
  }
  return calls;
}

export function isFilePathReferencedByEntries(filePath: string, entries: SessionEntry[]): boolean {
  if (!isAbsoluteFilePath(filePath) || isSensitiveExternalFilePath(filePath)) return false;

  const pendingCalls = new Map<string, StructuredFileToolCall>();
  const ambiguousCallIds = new Set<string>();
  const seenCallIds = new Set<string>();
  const settledResultIds = new Set<string>();
  const matchingCallIds = new Set<string>();

  for (const entry of entries) {
    for (const call of structuredToolCallsFromEntry(entry)) {
      if (seenCallIds.has(call.toolCallId)) {
        pendingCalls.delete(call.toolCallId);
        matchingCallIds.delete(call.toolCallId);
        ambiguousCallIds.add(call.toolCallId);
      } else if (!settledResultIds.has(call.toolCallId)) {
        seenCallIds.add(call.toolCallId);
        pendingCalls.set(call.toolCallId, call);
      }
    }

    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const result = entry.message;
    if (settledResultIds.has(result.toolCallId)) {
      pendingCalls.delete(result.toolCallId);
      matchingCallIds.delete(result.toolCallId);
      ambiguousCallIds.add(result.toolCallId);
      continue;
    }
    settledResultIds.add(result.toolCallId);
    const call = pendingCalls.get(result.toolCallId);
    // The first result consumes the call whether it succeeded or failed.
    pendingCalls.delete(result.toolCallId);
    if (result.isError || ambiguousCallIds.has(result.toolCallId)) continue;
    if (!call) continue;

    if (typeof result.toolName !== "string" || result.toolName.toLowerCase() !== call.toolName) continue;
    if (sameExactPath(call.filePath, filePath)) matchingCallIds.add(result.toolCallId);
  }

  return [...matchingCallIds].some((toolCallId) => !ambiguousCallIds.has(toolCallId));
}

export function isBashOutputPathReferencedByEntries(filePath: string, entries: SessionEntry[]): boolean {
  return entries.some((entry) => (
    entry.type === "message"
    && entry.message.role === "bashExecution"
    && entry.message.fullOutputPath === filePath
  ));
}
