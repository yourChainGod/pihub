import { NextRequest, NextResponse as FrameworkNextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
  normalizeSlashes,
  type AllowedRootScope,
} from "@/lib/file-access";
import {
  DOCX_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
} from "@/lib/file-types";
import { resolveDirentIsDirectory } from "@/lib/file-dirent";
import { isFilePathReferencedBySession } from "@/lib/session-file-references";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  inspectUploadTargets,
  parseUploadConflictStrategy,
  publishUploadTemporaryFile,
  validateUploadFileNames,
} from "@/lib/file-upload";
import { RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { samePath } from "@/lib/paths";
import { getTrustedPihubRequestContext } from "@/lib/pihub-auth";
import {
  cleanupStagedUploadFiles,
  MultipartUploadError,
  stageAuthenticatedMultipartUpload,
} from "@/lib/streaming-multipart-upload";
import {
  canUseSessionFileReference,
  createVerifiedFileBodyStream,
  getFileResponseHeaders,
  isSessionReferencedResponseSizeAllowed,
  parseFileRequestType,
  PRIVATE_FILE_RESPONSE_HEADERS,
  readVerifiedFile,
  tryAcquireFileWatcher,
  validateDocxPreviewArchive,
} from "@/lib/file-route-security";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store", ".git",
]);

const IGNORED_SUFFIXES = [".pyc"];

const MAX_UPLOAD_CHECK_REQUEST_BYTES = 64 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const MEDIA_PREVIEW_MAX_BYTES = 100 * 1024 * 1024;

type NextResponse = FrameworkNextResponse;

function privateJson<JsonBody>(body: JsonBody, init: ResponseInit = {}): FrameworkNextResponse<JsonBody> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(PRIVATE_FILE_RESPONSE_HEADERS)) headers.set(name, value);
  return FrameworkNextResponse.json(body, { ...init, headers });
}

// Keep every JSON return in this sensitive filesystem route private by default.
const NextResponse = { json: privateJson };

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl",
  env: "bash", gitignore: "bash", txt: "text",
  pdf: "pdf", docx: "word",
};

function getLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  // Special full-name matches
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

function readDirectoryEntriesLimited(directoryPath: string): { dirents: fs.Dirent[]; tooMany: boolean } {
  const directory = fs.opendirSync(directoryPath);
  const dirents: fs.Dirent[] = [];
  try {
    while (dirents.length <= MAX_DIRECTORY_ENTRIES) {
      const dirent = directory.readSync();
      if (!dirent) return { dirents, tooMany: false };
      dirents.push(dirent);
    }
    return { dirents: [], tooMany: true };
  } finally {
    directory.closeSync();
  }
}

async function getUploadDirectory(
  segments: string[],
  scope: AllowedRootScope,
): Promise<{ directory: string } | { response: NextResponse }> {
  const directory = filePathFromSegments(segments);
  const allowedRoots = await getAllowedFileRoots(scope);
  if (!isFilePathAllowed(directory, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch {
    return { response: NextResponse.json({ error: "Upload directory not found" }, { status: 404 }) };
  }
  if (!stat.isDirectory()) {
    return { response: NextResponse.json({ error: "Upload target is not a directory" }, { status: 400 }) };
  }

  // A browsable directory can be a symlink. Resolve both sides before writes
  // so a symlink inside an allowed root cannot redirect uploads outside it.
  const realDirectory = fs.realpathSync(directory);
  const realRoots = new Set<string>();
  for (const root of allowedRoots) {
    try {
      realRoots.add(fs.realpathSync(root));
    } catch {
      // Ignore stale session roots that no longer exist.
    }
  }
  if (!isFilePathAllowed(realDirectory, realRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }

  return { directory: realDirectory };
}

function parseUploadFileNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

function safeUploadError(error: unknown): string {
  if (error instanceof Error && error.message === "Cannot replace a directory or symbolic link") {
    return error.message;
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EEXIST") return "Destination already exists";
  if (code === "ENOSPC") return "Not enough disk space";
  return "Upload failed";
}

function multipartUploadErrorResponse(error: MultipartUploadError): NextResponse {
  switch (error.kind) {
    case "digest_mismatch":
      return NextResponse.json({ error: "Upload body authentication failed" }, { status: 401 });
    case "file_too_large":
      return NextResponse.json({ error: "Each upload must be 25MB or smaller" }, { status: 413 });
    case "request_too_large":
    case "total_too_large":
      return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
    case "too_many_files":
      return NextResponse.json({ error: "Too many files in one upload" }, { status: 413 });
    case "malformed":
      return NextResponse.json({ error: "Malformed multipart upload" }, { status: 400 });
  }
}

async function parseJsonWithinLimit(request: Request, maxBytes: number): Promise<unknown> {
  const declaredValue = request.headers.get("content-length");
  if (declaredValue && /^\d+$/.test(declaredValue) && Number(declaredValue) > maxBytes) {
    throw new RequestBodyTooLargeError();
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      size += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const trusted = getTrustedPihubRequestContext(request);
  if (!trusted) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!trusted.capabilities.includes("files:write")) {
    return NextResponse.json({ error: "Insufficient device capability" }, { status: 403 });
  }
  const scope = { ownerId: trusted.deviceId } satisfies AllowedRootScope;
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const { path: segments } = await params;
    const uploadDirectory = await getUploadDirectory(segments, scope);
    if ("response" in uploadDirectory) return uploadDirectory.response;
    const { directory } = uploadDirectory;
    const type = request.nextUrl.searchParams.get("type") ?? "upload";

    if (type === "upload-check") {
      let body: { fileNames?: unknown } | null = null;
      try {
        body = await parseJsonWithinLimit(request, MAX_UPLOAD_CHECK_REQUEST_BYTES) as { fileNames?: unknown } | null;
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return NextResponse.json({ error: "Upload check request is too large" }, { status: 413 });
        }
      }
      const fileNames = parseUploadFileNames(body?.fileNames);
      if (!fileNames) {
        return NextResponse.json({ error: "fileNames must be an array of strings" }, { status: 400 });
      }
      const validationError = validateUploadFileNames(fileNames);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
      return NextResponse.json(inspectUploadTargets(directory, fileNames));
    }

    if (type !== "upload") {
      return NextResponse.json({ error: "Invalid upload request type" }, { status: 400 });
    }

    const strategy = parseUploadConflictStrategy(request.nextUrl.searchParams.get("conflict"));
    if (!strategy) {
      return NextResponse.json({ error: "Invalid conflict strategy" }, { status: 400 });
    }
    if (!trusted.expectedContentSha256) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    try {
      const files = await stageAuthenticatedMultipartUpload(
        request,
        directory,
        trusted.expectedContentSha256,
      );
      try {
        const fileNames = files.map((file) => file.name);
        const validationError = validateUploadFileNames(fileNames);
        if (validationError) {
          return NextResponse.json({ error: validationError }, { status: 400 });
        }

        const inspection = inspectUploadTargets(directory, fileNames);
        if (strategy === "error" && inspection.conflicts.length > 0) {
          return NextResponse.json({
            error: "One or more files already exist",
            conflicts: inspection.conflicts,
            nonReplaceable: inspection.nonReplaceable,
          }, { status: 409 });
        }

        const uploaded: string[] = [];
        const skipped: string[] = [];
        const errors: Array<{ name: string; error: string }> = [];
        for (const file of files) {
          const destination = path.join(directory, file.name);
          let existing: fs.Stats | null = null;
          try {
            existing = fs.lstatSync(destination);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              errors.push({ name: file.name, error: safeUploadError(error) });
              continue;
            }
          }

          if (existing && strategy === "skip") {
            skipped.push(file.name);
            continue;
          }
          if (existing && strategy === "error") {
            errors.push({ name: file.name, error: "Destination already exists" });
            continue;
          }
          if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
            errors.push({ name: file.name, error: "Cannot replace a directory or symbolic link" });
            continue;
          }

          try {
            publishUploadTemporaryFile(file.temporaryPath, destination, existing);
            uploaded.push(file.name);
          } catch (error) {
            errors.push({ name: file.name, error: safeUploadError(error) });
          }
        }

        return NextResponse.json(
          { uploaded, skipped, errors },
          { status: errors.length > 0 ? 207 : 200 },
        );
      } finally {
        await cleanupStagedUploadFiles(files);
      }
    } catch (error) {
      if (error instanceof MultipartUploadError) return multipartUploadErrorResponse(error);
      throw error;
    }
  } catch {
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}

function streamFile(filePath: string, stat: fs.Stats, contentType: string, rangeHeader: string | null, asDownload = false): Response {
  const headers = getFileResponseHeaders(filePath, contentType, asDownload);

  if (!rangeHeader) {
    return new Response(createVerifiedFileBodyStream(filePath, stat), {
      headers: {
        ...headers,
        "Content-Length": String(stat.size),
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(stat.size - suffixLength, 0);
    end = stat.size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  end = Math.min(end, stat.size - 1);
  const chunkSize = end - start + 1;
  return new Response(createVerifiedFileBodyStream(filePath, stat, { start, end }), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    },
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapDocxPreviewHtml(bodyHtml: string, fileName: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #eef1f5; color: #171717; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
  main {
    box-sizing: border-box;
    max-width: 840px;
    min-height: calc(100vh - 56px);
    margin: 0 auto;
    padding: 56px 64px;
    background: #fff;
    box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14);
  }
  .file-title {
    margin: 0 0 28px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e5e7eb;
    color: #6b7280;
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-word;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.1em 0 0.45em; color: #111827; }
  p { margin: 0.65em 0; line-height: 1.7; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 9px; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { color: #2563eb; }
  @media (max-width: 720px) {
    body { padding: 0; background: #fff; }
    main { min-height: 100vh; padding: 28px 22px; box-shadow: none; }
  }
</style>
</head>
<body>
<main>
<div class="file-title">${escapeHtml(fileName)}</div>
${bodyHtml}
</main>
</body>
</html>`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const trusted = getTrustedPihubRequestContext(request);
  if (!trusted) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (!trusted.capabilities.includes("files:read")) {
    return NextResponse.json({ error: "Insufficient device capability" }, { status: 403 });
  }
  const scope = { ownerId: trusted.deviceId } satisfies AllowedRootScope;
  try {
    const { path: segments } = await params;
    const requestedFilePath = filePathFromSegments(segments);
    let canonicalExistingPath: string | null = null;
    try {
      canonicalExistingPath = fs.realpathSync(requestedFilePath);
    } catch {
      try {
        canonicalExistingPath = path.join(
          fs.realpathSync(path.dirname(requestedFilePath)),
          path.basename(requestedFilePath),
        );
      } catch { /* missing or inaccessible parent */ }
    }
    const filePath = canonicalExistingPath ?? requestedFilePath;
    const rawType = request.nextUrl.searchParams.get("type") ?? "list";
    const type = parseFileRequestType(rawType);
    if (!type) {
      return NextResponse.json({ error: "Invalid file request type" }, { status: 400 });
    }
    const sessionId = request.nextUrl.searchParams.get("sessionId");

    const allowedRoots = await getAllowedFileRoots(scope);
    const allowedByRoot = isFilePathAllowed(filePath, allowedRoots);

    // Snapshot the file identity before the session capability check. The
    // opened fd must match this snapshot, so a late symlink/reparse replacement
    // cannot make an external-session capability name a different file.
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(filePath);
    } catch { /* missing or inaccessible target */ }
    const allowedBySessionReference =
      !allowedByRoot &&
      canUseSessionFileReference(type, trusted.capabilities) &&
      await isFilePathReferencedBySession(requestedFilePath, sessionId, trusted.deviceId);
    if (!allowedByRoot && !allowedBySessionReference) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (!stat && type !== "watch") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (allowedBySessionReference && stat && !isSessionReferencedResponseSizeAllowed(stat.size)) {
      return NextResponse.json({ error: "Session-referenced file is too large (>100MB)" }, { status: 413 });
    }

    const existingAuthorizationPath = stat ? filePath : path.dirname(filePath);
    if (
      !allowedBySessionReference
      && !isExistingFilePathAllowed(existingAuthorizationPath, allowedRoots)
    ) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    if (type === "read") {
      if (!stat?.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const imageMime = getImageMime(filePath);
      if (imageMime) {
        if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
          return NextResponse.json({ error: "Image too large (>10MB)" }, { status: 413 });
        }
        return streamFile(filePath, stat, imageMime, request.headers.get("range"));
      }
      const audioMime = getAudioMime(filePath);
      if (audioMime) {
        if (stat.size > MEDIA_PREVIEW_MAX_BYTES) {
          return NextResponse.json({ error: "Audio too large for preview (>100MB)" }, { status: 413 });
        }
        return streamFile(filePath, stat, audioMime, request.headers.get("range"));
      }
      const documentMime = getDocumentMime(filePath);
      if (documentMime) {
        if (stat.size > MEDIA_PREVIEW_MAX_BYTES) {
          return NextResponse.json({ error: "Document too large for preview (>100MB)" }, { status: 413 });
        }
        return streamFile(filePath, stat, documentMime, request.headers.get("range"));
      }
      if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
        return NextResponse.json({ error: "File too large for preview (>256KB)" }, { status: 413 });
      }
      const content = readVerifiedFile(filePath, stat, TEXT_PREVIEW_MAX_BYTES).toString("utf8");
      const language = getLanguage(filePath);
      return NextResponse.json({ content, language, size: stat.size });
    }

    if (type === "download") {
      if (!stat?.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const mime = getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath) || "application/octet-stream";
      return streamFile(filePath, stat, mime, request.headers.get("range"), true);
    }

    if (type === "meta") {
      if (!stat?.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      return NextResponse.json({
        size: stat.size,
        language: getLanguage(filePath),
        mime: imageMime || audioMime || documentMime || "text/plain",
        previewKind: documentPreviewKind(filePath),
      });
    }

    if (type === "preview") {
      if (!stat?.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      if (getFileExt(filePath) !== "docx") {
        return NextResponse.json({ error: "Preview not available for this file type" }, { status: 400 });
      }
      if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
        return NextResponse.json({ error: "DOCX too large for preview (>10MB)" }, { status: 413 });
      }

      const docxBuffer = readVerifiedFile(filePath, stat, DOCX_PREVIEW_MAX_BYTES);
      const archiveValidation = validateDocxPreviewArchive(docxBuffer);
      if (!archiveValidation.ok) {
        return NextResponse.json(
          { error: archiveValidation.reason === "resource_limit" ? "DOCX exceeds safe preview limits" : "Invalid DOCX archive" },
          { status: archiveValidation.reason === "resource_limit" ? 413 : 400 },
        );
      }

      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml(
        { buffer: docxBuffer },
        {
          externalFileAccess: false,
          convertImage: mammoth.images.dataUri,
        }
      );
      const html = wrapDocxPreviewHtml(result.value, path.basename(filePath));
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ...PRIVATE_FILE_RESPONSE_HEADERS,
          "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (type === "watch") {
      if (stat && !stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const releaseWatcherSlot = tryAcquireFileWatcher(trusted.deviceId);
      if (!releaseWatcherSlot) {
        return NextResponse.json(
          { error: "Too many active file watchers" },
          { status: 429, headers: { "Retry-After": "5" } },
        );
      }
      let watcher: fs.FSWatcher | null = null;
      let lastMtimeMs = stat?.mtimeMs ?? 0;
      let lastCtimeMs = stat?.ctimeMs ?? 0;
      let lastIno = stat?.ino ?? 0;
      let lastSize = stat?.size ?? 0;
      let lastExists = stat !== undefined;
      let controllerClosed = false;
      let abortListener: (() => void) | null = null;
      let pendingChange: Uint8Array | null = null;
      const closeWatcher = () => {
        try { watcher?.close(); } catch { /* ignore */ }
        watcher = null;
        releaseWatcherSlot();
        if (abortListener) request.signal.removeEventListener("abort", abortListener);
        abortListener = null;
      };
      const stream = new ReadableStream({
        start(controller) {
          const closeStream = () => {
            if (controllerClosed) return;
            controllerClosed = true;
            closeWatcher();
            try { controller.close(); } catch { /* ignore */ }
          };
          abortListener = closeStream;
          request.signal.addEventListener("abort", abortListener, { once: true });
          if (request.signal.aborted) {
            closeStream();
            return;
          }
          const send = (eventName: string, data: Record<string, unknown>) => {
            if (controllerClosed) return;
            const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
            const encoded = new TextEncoder().encode(payload);
            if (
              eventName === "change"
              && (pendingChange !== null || (controller.desiredSize ?? 0) <= 0)
            ) {
              pendingChange = encoded;
              return;
            }
            try {
              controller.enqueue(encoded);
            } catch {
              // client disconnected
            }
          };
          try {
            const watchedDirectory = path.dirname(filePath);
            watcher = fs.watch(watchedDirectory, (_eventType, changedName) => {
              if (
                changedName != null
                && !samePath(path.join(watchedDirectory, changedName.toString()), filePath)
              ) return;
              try {
                const s = fs.statSync(filePath);
                // Some platforms emit watch events for file reads/attribute
                // access. Ignore those or the client's refresh read loops.
                if (
                  lastExists
                  && s.mtimeMs === lastMtimeMs
                  && s.ctimeMs === lastCtimeMs
                  && s.ino === lastIno
                  && s.size === lastSize
                ) return;
                lastExists = true;
                lastMtimeMs = s.mtimeMs;
                lastCtimeMs = s.ctimeMs;
                lastIno = s.ino;
                lastSize = s.size;
                send("change", { mtime: s.mtime.toISOString(), size: s.size });
              } catch {
                if (!lastExists) return;
                lastExists = false;
                send("change", { mtime: new Date().toISOString(), size: 0 });
              }
            });
            watcher.on("error", () => {
              closeStream();
            });
            // The client snapshots only after this event, so emit it after the
            // watcher exists to avoid dropping changes between those steps.
            send("connected", { filePath });
          } catch {
            send("error", { message: "Failed to watch file" });
            closeStream();
          }
        },
        pull(controller) {
          if (!pendingChange || controllerClosed) return;
          const payload = pendingChange;
          pendingChange = null;
          controller.enqueue(payload);
        },
        cancel() {
          controllerClosed = true;
          pendingChange = null;
          closeWatcher();
        },
      });
      return new Response(stream, {
        headers: {
          ...PRIVATE_FILE_RESPONSE_HEADERS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "private, no-store, no-transform, max-age=0",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // type === "list"
    if (!stat?.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }

    // Avoid per-entry stat calls for normal files and directories. Symlinks and
    // filesystems without directory type information use the stat fallback.
    const directoryRead = readDirectoryEntriesLimited(filePath);
    if (directoryRead.tooMany) {
      return NextResponse.json({ error: `Directory contains more than ${MAX_DIRECTORY_ENTRIES} entries` }, { status: 413 });
    }
    const entries = directoryRead.dirents
      .filter((d) => !IGNORED_NAMES.has(d.name) && !IGNORED_SUFFIXES.some((s) => d.name.endsWith(s)))
      .flatMap((d) => {
        const isDir = resolveDirentIsDirectory(d, path.join(filePath, d.name));
        return isDir === null
          ? []
          : [{ name: d.name, isDir, size: 0, modified: "" }];
      })
      .sort((a, b) => {
        // Dirs first, then files, both alphabetically
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({ entries, path: filePath });
  } catch {
    return NextResponse.json({ error: "File request failed" }, { status: 500 });
  }
}
