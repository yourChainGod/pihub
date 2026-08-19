import { isSensitiveEnvironmentName, type ProcessEnvironmentSource } from "./process-environment";

export const DEFAULT_PROCESS_OUTPUT_LIMIT = 64 * 1024;
const REDACTION_TEXT = "[REDACTED]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sensitiveValues(source: ProcessEnvironmentSource): string[] {
  return Array.from(new Set(
    Object.entries(source)
      .filter(([name, value]) => isSensitiveEnvironmentName(name) && typeof value === "string" && value.length >= 4)
      .map(([, value]) => value as string),
  )).sort((left, right) => right.length - left.length);
}

/** Redact credentials before subprocess output crosses an API or log boundary. */
export function redactProcessOutput(
  input: string | Buffer | undefined,
  source: ProcessEnvironmentSource = process.env,
): string {
  let value = Buffer.isBuffer(input) ? input.toString("utf8") : (input ?? "");
  for (const secret of sensitiveValues(source)) {
    value = value.replace(new RegExp(escapeRegExp(secret), "g"), REDACTION_TEXT);
  }
  return value
    .replace(/\b(?:pihub_key_|pihub-)[A-Za-z0-9_-]{20,}\b/g, REDACTION_TEXT)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (match) => `${match.split(/\s+/, 1)[0]} ${REDACTION_TEXT}`)
    .replace(
      /(["']?(?:api[_-]?key|authorization|cookie|password|private[_-]?key|secret|token)["']?\s*[:=]\s*)(["']?)([^\s,;}\]"']+)/gi,
      (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTION_TEXT}`,
    )
    .replace(/\b(https?|wss?):\/\/([^\s/@:]+):([^\s/@]+)@/gi, `$1://${REDACTION_TEXT}@`);
}

export function boundedProcessOutput(
  input: string | Buffer | undefined,
  options: { limit?: number; source?: ProcessEnvironmentSource } = {},
): string {
  const limit = options.limit ?? DEFAULT_PROCESS_OUTPUT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024 * 1024) {
    throw new TypeError("Process output limit must be between 1 and 1048576 characters");
  }
  const redacted = redactProcessOutput(input, options.source);
  return redacted.length <= limit
    ? redacted
    : `[output truncated]\n${redacted.slice(-limit)}`;
}
