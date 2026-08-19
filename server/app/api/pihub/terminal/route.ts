import { realpathSync, statSync } from "node:fs";
import { NextRequest } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { pihubNoStoreHeaders, readPihubAuthJsonBody } from "@/lib/pihub-auth-http";
import { PihubAuthInputError } from "@/lib/pihub-auth-shared";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  closeTerminal,
  createTerminal,
  getTerminal,
  readTerminal,
  resizeTerminal,
  TerminalCapacityError,
  writeTerminal,
} from "@/lib/pihub-terminal";

const MAX_TERMINAL_BODY_BYTES = 66 * 1024;
const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
const MAX_TERMINAL_INPUT_CODE_UNITS = 64 * 1024;
const MIN_TERMINAL_COLUMNS = 2;
const MAX_TERMINAL_COLUMNS = 500;
const MIN_TERMINAL_ROWS = 1;
const MAX_TERMINAL_ROWS = 300;

class TerminalRequestError extends Error {
  readonly status: 400 | 403;

  constructor(
    message: string,
    status: 400 | 403 = 400,
  ) {
    super(message);
    this.name = "TerminalRequestError";
    this.status = status;
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: pihubNoStoreHeaders() });
}

function unauthenticated(): Response {
  return Response.json({ error: "Authentication required" }, {
    status: 401,
    headers: pihubNoStoreHeaders({
      "WWW-Authenticate": 'PiHub-HMAC-SHA256 realm="PiHub"',
    }),
  });
}

function trustedOwner(request: Request): { ownerId?: string; status?: 401 | 403 } {
  const context = getTrustedPihubRequestContext(request);
  if (!context) return { status: 401 };
  if (!context.capabilities.includes("terminal:use")) return { status: 403 };
  return { ownerId: context.deviceId };
}

function requiredString(
  value: unknown,
  name: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
    || value.includes("\0")
  ) {
    throw new TerminalRequestError(`${name} is invalid`);
  }
  return value;
}

function parseOffset(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return Number.NaN;
  const offset = Number(value);
  return Number.isSafeInteger(offset) ? offset : Number.NaN;
}

function parseTerminalSize(value: unknown): [number, number] {
  if (typeof value !== "string") throw new TerminalRequestError("Invalid size");
  const match = /^([1-9][0-9]{0,3})x([1-9][0-9]{0,3})$/.exec(value);
  if (!match) throw new TerminalRequestError("Invalid size");
  const columns = Number(match[1]);
  const rows = Number(match[2]);
  if (
    columns < MIN_TERMINAL_COLUMNS
    || columns > MAX_TERMINAL_COLUMNS
    || rows < MIN_TERMINAL_ROWS
    || rows > MAX_TERMINAL_ROWS
  ) {
    throw new TerminalRequestError("Invalid size");
  }
  return [columns, rows];
}

function canonicalDirectory(target: string): string | null {
  try {
    const canonical = realpathSync.native(target);
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return json({ error: "Untrusted API request" }, 403);
  const authorization = trustedOwner(request);
  if (authorization.status === 401) return unauthenticated();
  if (authorization.status === 403) return json({ error: "Terminal capability required" }, 403);
  const ownerId = authorization.ownerId!;
  const id = request.nextUrl.searchParams.get("id");
  const terminal = id ? getTerminal(id, ownerId) : undefined;
  if (!terminal) return json({ error: "Terminal not found" }, 404);

  const offsetParam = request.nextUrl.searchParams.get("offset");
  if (offsetParam !== null) {
    const read = readTerminal(id!, ownerId, parseOffset(offsetParam));
    if (!read) return json({ error: "Terminal not found" }, 404);
    return json({ id: terminal.id, cwd: terminal.cwd, ...read, offsetEncoding: "utf-16" });
  }
  return json({
    id: terminal.id,
    cwd: terminal.cwd,
    output: terminal.output,
    cursor: terminal.dropped + terminal.output.length,
    offsetEncoding: "utf-16",
  });
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return json({ error: "Untrusted API request" }, 403);
  const authorization = trustedOwner(request);
  if (authorization.status === 401) return unauthenticated();
  if (authorization.status === 403) return json({ error: "Terminal capability required" }, 403);
  const ownerId = authorization.ownerId!;
  try {
    const body = await readPihubAuthJsonBody(request, MAX_TERMINAL_BODY_BYTES);
    const action = requiredString(body.action, "action", 16);
    if (action === "create") {
      const cwd = requiredString(body.cwd, "cwd", 4_096);
      const roots = await getAllowedFileRoots({ ownerId });
      const canonicalCwd = canonicalDirectory(cwd);
      if (
        !isFilePathAllowed(cwd, roots)
        || !isExistingFilePathAllowed(cwd, roots)
        || !canonicalCwd
      ) {
        throw new TerminalRequestError("Access denied", 403);
      }
      const terminal = createTerminal(canonicalCwd, ownerId);
      return json({ id: terminal.id, cwd: terminal.cwd });
    }
    const id = requiredString(body.id, "id", 128);
    if (action === "input") {
      if (typeof body.data !== "string" || body.data.length > MAX_TERMINAL_INPUT_CODE_UNITS) {
        throw new TerminalRequestError("Invalid terminal input");
      }
      if (new TextEncoder().encode(body.data).byteLength > MAX_TERMINAL_INPUT_BYTES) {
        throw new TerminalRequestError("Terminal input is too large");
      }
      if (!writeTerminal(id, ownerId, body.data)) return json({ error: "Terminal not found" }, 404);
      return json({ success: true });
    }
    if (action === "resize") {
      const [columns, rows] = parseTerminalSize(body.data);
      if (!resizeTerminal(id, ownerId, columns, rows)) return json({ error: "Terminal not found" }, 404);
      return json({ success: true });
    }
    if (action === "close") {
      if (!closeTerminal(id, ownerId)) return json({ error: "Terminal not found" }, 404);
      return json({ success: true });
    }
    return json({ error: "Unsupported action" }, 400);
  } catch (error) {
    if (error instanceof TerminalRequestError) return json({ error: error.message }, error.status);
    if (error instanceof PihubAuthInputError) return json({ error: "Invalid request" }, 400);
    if (error instanceof TerminalCapacityError) return json({ error: error.message }, 429);
    return json({ error: "Terminal unavailable" }, 503);
  }
}
