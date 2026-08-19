import { PihubAuthInputError } from "./pihub-auth-shared";

const DEFAULT_MAX_BODY_BYTES = 8 * 1024;

function isJsonContentType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || Boolean(mediaType?.startsWith("application/") && mediaType.endsWith("+json"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readPihubAuthJsonBody(
  request: Request,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    throw new PihubAuthInputError("Expected a JSON request body");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^[0-9]+$/.test(contentLength) || Number(contentLength) > maxBytes) {
      throw new PihubAuthInputError("Request body is too large");
    }
  }
  if (!request.body) throw new PihubAuthInputError("Missing request body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new PihubAuthInputError("Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new PihubAuthInputError("Invalid JSON request body");
  }
  if (!isRecord(parsed)) throw new PihubAuthInputError("Expected a JSON object");
  return parsed;
}

export function pihubNoStoreHeaders(additional?: HeadersInit): Headers {
  const headers = new Headers(additional);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}
