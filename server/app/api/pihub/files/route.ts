import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  type AllowedRootScope,
} from "@/lib/file-access";
import {
  assertPortableFileNameAvailable,
  assertUploadDirectoryGuard,
  validateUploadFileNames,
  writeUploadFileAtomically,
} from "@/lib/file-upload";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { samePath } from "@/lib/paths";

const MAX_FILE_CONTENT_BYTES = 5 * 1024 * 1024;
const MAX_JSON_REQUEST_BYTES = MAX_FILE_CONTENT_BYTES + 64 * 1024;
const MAX_PATH_LENGTH = 32_768;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

interface FileMutationBody {
  action?: unknown;
  path?: unknown;
  name?: unknown;
  content?: unknown;
  destination?: unknown;
}

class BodyTooLargeError extends Error {}

function json(body: unknown, init: ResponseInit = {}): NextResponse {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) headers.set(name, value);
  return NextResponse.json(body, { ...init, headers });
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

async function parseBoundedJson(request: Request): Promise<FileMutationBody> {
  const declared = declaredContentLength(request);
  if (declared !== null && declared > MAX_JSON_REQUEST_BYTES) throw new BodyTooLargeError();

  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_JSON_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError();
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const parsed = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("Invalid JSON object");
  return parsed as FileMutationBody;
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && !!value && !value.includes("\0") && value.length <= MAX_PATH_LENGTH;
}

function validName(name: unknown): name is string {
  return typeof name === "string" && validateUploadFileNames([name]) === null;
}

async function authorize(
  target: string,
  scope: AllowedRootScope,
  allowMissing = false,
): Promise<string> {
  if (!path.isAbsolute(target)) throw new Error("Absolute path required");
  const roots = await getAllowedFileRoots(scope);

  try {
    const targetStat = fs.lstatSync(target);
    const realTarget = fs.realpathSync(target);
    if (
      targetStat.isSymbolicLink()
      || !isFilePathAllowed(realTarget, roots)
      || !isExistingFilePathAllowed(realTarget, roots)
    ) {
      throw new Error("Access denied");
    }
    return realTarget;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (!allowMissing) throw new Error("Not found");
  const parent = path.dirname(target);
  const realParent = fs.realpathSync(parent);
  if (
    !isFilePathAllowed(realParent, roots)
    || !isExistingFilePathAllowed(realParent, roots)
    || !fs.statSync(realParent).isDirectory()
  ) {
    throw new Error("Access denied");
  }
  return path.join(realParent, path.basename(target));
}

async function refuseRootMutation(target: string, scope: AllowedRootScope): Promise<void> {
  const realTarget = fs.realpathSync(target);
  const roots = await getAllowedFileRoots(scope);
  for (const root of roots) {
    try {
      if (samePath(fs.realpathSync(root), realTarget)) throw new Error("Cannot modify an authorized workspace root");
    } catch (error) {
      if (error instanceof Error && error.message === "Cannot modify an authorized workspace root") throw error;
    }
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function assertAuthorizedTargetUnchanged(target: string, expected: fs.Stats): void {
  const current = fs.lstatSync(target);
  if (
    current.isSymbolicLink()
    || !sameFileIdentity(current, expected)
    || !samePath(fs.realpathSync.native(target), target)
  ) {
    throw new Error("Access denied");
  }
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "File operation failed";
  if ([
    "Absolute path required",
    "Access denied",
    "Not found",
    "Cannot modify an authorized workspace root",
    "Cannot replace a directory or symbolic link",
  ].includes(error.message)) return error.message;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return "Destination already exists";
  if (code === "ENOTEMPTY") return "Directory is not empty";
  if (error instanceof SyntaxError) return "Invalid JSON body";
  return "File operation failed";
}

export async function POST(request: NextRequest) {
  const trusted = getTrustedPihubRequestContext(request);
  if (!trusted) return json({ error: "Authentication required" }, { status: 401 });
  if (!trusted.capabilities.includes("files:write")) {
    return json({ error: "Insufficient device capability" }, { status: 403 });
  }
  if (!isApiRequestAllowed(request)) return json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return json({ error: "Content-Type must be application/json" }, { status: 415 });
  const scope = { ownerId: trusted.deviceId } satisfies AllowedRootScope;

  try {
    const body = await parseBoundedJson(request);
    if (!validPath(body.path)) return json({ error: "path is required" }, { status: 400 });
    if (typeof body.action !== "string") return json({ error: "action is required" }, { status: 400 });
    const target = await authorize(body.path, scope, body.action === "write");
    let authorizedTargetStat: fs.Stats | null = null;
    try {
      authorizedTargetStat = fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (body.action === "mkdir" || body.action === "touch") {
      if (!validName(body.name)) return json({ error: "Invalid name" }, { status: 400 });
      const created = await authorize(path.join(target, body.name), scope, true);
      if (body.action === "mkdir") {
        const createdExists = fs.existsSync(created);
        const directoryGuard = assertPortableFileNameAvailable(
          path.dirname(created),
          body.name,
          createdExists && path.basename(created) === body.name,
        );
        if (createdExists) {
          const existing = fs.lstatSync(created);
          if (existing.isSymbolicLink() || !existing.isDirectory()) {
            return json({ error: "Destination already exists" }, { status: 409 });
          }
          return json({ success: true, path: created, existed: true });
        }
        assertUploadDirectoryGuard(path.dirname(created), directoryGuard);
        fs.mkdirSync(created, { recursive: false });
      } else {
        const content = body.content === undefined ? "" : body.content;
        if (typeof content !== "string") return json({ error: "content must be a string" }, { status: 400 });
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_CONTENT_BYTES) {
          return json({ error: "File content must be 5MB or smaller" }, { status: 413 });
        }
        writeUploadFileAtomically(path.dirname(created), path.basename(created), Buffer.from(content), false);
      }
      return json({ success: true, path: created });
    }

    if (body.action === "write") {
      if (typeof body.content !== "string") return json({ error: "content must be a string" }, { status: 400 });
      if (Buffer.byteLength(body.content, "utf8") > MAX_FILE_CONTENT_BYTES) {
        return json({ error: "File content must be 5MB or smaller" }, { status: 413 });
      }
      const exists = fs.existsSync(target);
      assertPortableFileNameAvailable(
        path.dirname(target),
        path.basename(body.path),
        exists && path.basename(target) === path.basename(body.path),
      );
      writeUploadFileAtomically(path.dirname(target), path.basename(target), Buffer.from(body.content), exists);
      return json({ success: true, path: target });
    }

    if (body.action === "rename" || body.action === "move") {
      await refuseRootMutation(target, scope);
      if (!validPath(body.destination)) return json({ error: "destination is required" }, { status: 400 });
      if (body.action === "rename" && !validName(body.destination)) {
        return json({ error: "Invalid destination name" }, { status: 400 });
      }
      const rawDestination = body.action === "rename"
        ? path.join(path.dirname(target), body.destination)
        : body.destination;
      if (!validName(path.basename(rawDestination))) {
        return json({ error: "Invalid destination name" }, { status: 400 });
      }
      const destination = await authorize(rawDestination, scope, true);
      const destinationGuard = assertPortableFileNameAvailable(
        path.dirname(destination),
        path.basename(rawDestination),
        false,
      );
      if (fs.existsSync(destination)) return json({ error: "Destination already exists" }, { status: 409 });
      if (!authorizedTargetStat) throw new Error("Not found");
      assertAuthorizedTargetUnchanged(target, authorizedTargetStat);
      assertUploadDirectoryGuard(path.dirname(destination), destinationGuard);
      fs.renameSync(target, destination);
      return json({ success: true, path: destination });
    }

    if (body.action === "delete") {
      await refuseRootMutation(target, scope);
      if (!authorizedTargetStat) throw new Error("Not found");
      assertAuthorizedTargetUnchanged(target, authorizedTargetStat);
      fs.rmSync(target, { recursive: true, force: false });
      return json({ success: true });
    }
    return json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return json({ error: "Request body is too large" }, { status: 413 });
    }
    const message = safeErrorMessage(error);
    return json(
      { error: message },
      {
        status: message === "Access denied"
          ? 403
          : message === "Not found"
            ? 404
            : message === "Destination already exists"
              ? 409
              : 400,
      },
    );
  }
}
