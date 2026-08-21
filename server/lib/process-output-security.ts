import { isSensitiveEnvironmentName, type ProcessEnvironmentSource } from "./process-environment";

export const DEFAULT_PROCESS_OUTPUT_LIMIT = 64 * 1024;
const REDACTION_TEXT = "[REDACTED]";
// Environment names and values cannot contain NUL, so it is a safe separator
// for the cache fingerprint below.
const FINGERPRINT_SEPARATOR = "\u0000";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Secret -> matcher is a pure mapping, so this cache never needs invalidating:
 * a given literal value always escapes to the same pattern. Global-flagged
 * regexes are safe to reuse here because `String.prototype.replace` with a
 * global regex resets `lastIndex` before it starts matching.
 */
const secretMatchers = new Map<string, RegExp>();

function secretMatcher(secret: string): RegExp {
  let matcher = secretMatchers.get(secret);
  if (!matcher) {
    matcher = new RegExp(escapeRegExp(secret), "g");
    secretMatchers.set(secret, matcher);
  }
  return matcher;
}

interface SensitiveValueCacheEntry {
  readonly fingerprint: string;
  readonly sensitiveNames: readonly string[];
  readonly values: readonly string[];
}

/**
 * Keyed on the source object, so a caller-supplied environment never inherits
 * another source's secrets, and weak so short-lived sources stay collectable.
 */
const sensitiveValueCache = new WeakMap<ProcessEnvironmentSource, SensitiveValueCacheEntry>();

function isRedactableSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 4;
}

/**
 * Cheap staleness probe. Credentials can be rotated in place under an unchanged
 * key, so the fingerprint covers the current sensitive *values* and not just the
 * shape of the environment; the full key list is included as well so adding or
 * removing any key also invalidates. Only the previously sensitive values are
 * read, which keeps this proportional to the credential count rather than to
 * the size of the environment.
 */
function environmentFingerprint(
  source: ProcessEnvironmentSource,
  sensitiveNames: readonly string[],
): string {
  const parts = Object.keys(source);
  for (const name of sensitiveNames) parts.push(source[name] ?? "");
  return parts.join(FINGERPRINT_SEPARATOR);
}

function sensitiveValues(source: ProcessEnvironmentSource): readonly string[] {
  const cached = sensitiveValueCache.get(source);
  if (cached && environmentFingerprint(source, cached.sensitiveNames) === cached.fingerprint) {
    return cached.values;
  }

  const sensitiveNames: string[] = [];
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(source)) {
    if (!isSensitiveEnvironmentName(name) || !isRedactableSecret(value)) continue;
    sensitiveNames.push(name);
    secrets.add(value);
  }
  const values = Array.from(secrets).sort((left, right) => right.length - left.length);

  sensitiveValueCache.set(source, {
    fingerprint: environmentFingerprint(source, sensitiveNames),
    sensitiveNames,
    values,
  });
  return values;
}

/** Redact credentials before subprocess output crosses an API or log boundary. */
export function redactProcessOutput(
  input: string | Buffer | undefined,
  source: ProcessEnvironmentSource = process.env,
): string {
  let value = Buffer.isBuffer(input) ? input.toString("utf8") : (input ?? "");
  for (const secret of sensitiveValues(source)) {
    value = value.replace(secretMatcher(secret), REDACTION_TEXT);
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
