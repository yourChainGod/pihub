import fs from "fs";
import path from "path";
import { inflateRawSync } from "node:zlib";
import type { PihubCapability } from "@/lib/pihub-auth-shared";
import {
  DOCX_PREVIEW_MAX_ARCHIVE_ENTRIES,
  DOCX_PREVIEW_MAX_COMPRESSION_RATIO,
  DOCX_PREVIEW_MAX_ENTRY_BYTES,
  DOCX_PREVIEW_MAX_EXPANDED_BYTES,
} from "@/lib/file-types";

const FILE_REQUEST_TYPES = ["list", "read", "download", "meta", "preview", "watch"] as const;
const FILE_REQUEST_TYPE_SET = new Set<string>(FILE_REQUEST_TYPES);
const SESSION_REFERENCE_REQUEST_TYPES = new Set<FileRequestType>(["read", "download", "meta", "preview"]);
const SESSION_REFERENCE_MAX_BYTES = 100 * 1024 * 1024;
const MAX_ACTIVE_WATCHERS_GLOBAL = 128;
const MAX_ACTIVE_WATCHERS_PER_DEVICE = 16;
const FILE_STREAM_CHUNK_BYTES = 64 * 1024;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_MAX_ENTRY_NAME_BYTES = 1_024;

export const PRIVATE_FILE_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

export type FileRequestType = typeof FILE_REQUEST_TYPES[number];

interface FileWatcherRuntime {
  total: number;
  byDevice: Map<string, number>;
}

declare global {
  var __pihubFileWatcherRuntime: FileWatcherRuntime | undefined;
}

function fileWatcherRuntime(): FileWatcherRuntime {
  globalThis.__pihubFileWatcherRuntime ??= { total: 0, byDevice: new Map() };
  return globalThis.__pihubFileWatcherRuntime;
}

export function tryAcquireFileWatcher(deviceId: string): (() => void) | null {
  const runtime = fileWatcherRuntime();
  const deviceCount = runtime.byDevice.get(deviceId) ?? 0;
  if (runtime.total >= MAX_ACTIVE_WATCHERS_GLOBAL || deviceCount >= MAX_ACTIVE_WATCHERS_PER_DEVICE) {
    return null;
  }
  runtime.total += 1;
  runtime.byDevice.set(deviceId, deviceCount + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    runtime.total = Math.max(0, runtime.total - 1);
    const next = (runtime.byDevice.get(deviceId) ?? 1) - 1;
    if (next <= 0) runtime.byDevice.delete(deviceId);
    else runtime.byDevice.set(deviceId, next);
  };
}

export function resetFileWatcherRuntimeForTests(): void {
  globalThis.__pihubFileWatcherRuntime = undefined;
}

export function parseFileRequestType(value: string): FileRequestType | null {
  return FILE_REQUEST_TYPE_SET.has(value) ? (value as FileRequestType) : null;
}

export function isSessionReferenceRequestType(type: FileRequestType): boolean {
  return SESSION_REFERENCE_REQUEST_TYPES.has(type);
}

export function canUseSessionFileReference(
  type: FileRequestType,
  capabilities: readonly PihubCapability[],
): boolean {
  return capabilities.includes("sessions:read") && isSessionReferenceRequestType(type);
}

export function isSessionReferencedResponseSizeAllowed(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= SESSION_REFERENCE_MAX_BYTES;
}

export function openedFileMatchesExpected(opened: fs.Stats, expected: fs.Stats): boolean {
  return opened.isFile()
    && opened.dev === expected.dev
    && opened.ino === expected.ino
    && opened.size === expected.size;
}

export function readVerifiedFile(filePath: string, expectedStat: fs.Stats, maxBytes: number): Buffer {
  if (expectedStat.size > maxBytes) throw new Error("File exceeds read limit");
  const noFollow = process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
    ? fs.constants.O_NOFOLLOW
    : 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    if (!openedFileMatchesExpected(fs.fstatSync(fd), expectedStat)) {
      throw new Error("File changed before it could be read");
    }
    const contents = fs.readFileSync(fd);
    if (contents.byteLength > maxBytes || !openedFileMatchesExpected(fs.fstatSync(fd), expectedStat)) {
      throw new Error("File changed while it was being read");
    }
    return contents;
  } finally {
    fs.closeSync(fd);
  }
}

export function createVerifiedFileBodyStream(
  filePath: string,
  expectedStat: fs.Stats,
  range?: { start: number; end: number },
): ReadableStream<Uint8Array> {
  let handle: fs.promises.FileHandle | null = null;
  let position = range?.start ?? 0;
  const end = range?.end ?? expectedStat.size - 1;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    const openHandle = handle;
    handle = null;
    if (openHandle) await openHandle.close().catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const remaining = end - position + 1;
        if (remaining <= 0) {
          await close();
          controller.close();
          return;
        }
        const noFollow = process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
          ? fs.constants.O_NOFOLLOW
          : 0;
        if (!handle) handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
        if (!openedFileMatchesExpected(await handle.stat(), expectedStat)) {
          throw new Error("File changed before it could be streamed");
        }

        const buffer = Buffer.allocUnsafe(Math.min(FILE_STREAM_CHUNK_BYTES, remaining));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0 || !openedFileMatchesExpected(await handle.stat(), expectedStat)) {
          throw new Error("File changed while it was being streamed");
        }
        position += bytesRead;
        const finished = position > end;
        if (finished) await close();
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
        if (finished) controller.close();
      } catch (error) {
        await close();
        controller.error(error);
      }
    },
    async cancel() {
      await close();
    },
  }, { highWaterMark: 0 });
}

export type DocxPreviewArchiveValidation =
  | { ok: true }
  | { ok: false; reason: "invalid" | "resource_limit" };

function findZipEndOfCentralDirectory(contents: Buffer): number {
  const firstCandidate = contents.length - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES;
  const minimumCandidate = Math.max(
    0,
    firstCandidate - ZIP_MAX_COMMENT_BYTES,
  );
  for (let offset = firstCandidate; offset >= minimumCandidate; offset -= 1) {
    if (contents.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentBytes = contents.readUInt16LE(offset + 20);
    if (offset + ZIP_END_OF_CENTRAL_DIRECTORY_BYTES + commentBytes === contents.length) return offset;
  }
  return -1;
}

function isSafeZipEntryName(name: Buffer): boolean {
  if (name.length === 0 || name.length > ZIP_MAX_ENTRY_NAME_BYTES) return false;
  if (name[0] === 0x2f || name[0] === 0x5c || name.includes(0) || name.includes(0x5c)) return false;
  if (
    name.length >= 2
    && ((name[0] >= 0x41 && name[0] <= 0x5a) || (name[0] >= 0x61 && name[0] <= 0x7a))
    && name[1] === 0x3a
  ) return false;

  const segments = name.toString("latin1").split("/");
  const lastIndex = segments.length - 1;
  return segments.every((segment, index) => (
    (segment.length > 0 || index === lastIndex)
    && segment !== "."
    && segment !== ".."
  ));
}

/**
 * Inspect ZIP metadata before Mammoth decompresses a DOCX. The preview is an
 * optional convenience, so unsupported ZIP64/encrypted/ambiguous archives fail
 * closed instead of entering an unbounded decompression path.
 */
export function validateDocxPreviewArchive(contents: Buffer): DocxPreviewArchiveValidation {
  if (contents.length < ZIP_END_OF_CENTRAL_DIRECTORY_BYTES) return { ok: false, reason: "invalid" };
  const eocdOffset = findZipEndOfCentralDirectory(contents);
  if (eocdOffset < 0) return { ok: false, reason: "invalid" };

  const diskNumber = contents.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = contents.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = contents.readUInt16LE(eocdOffset + 8);
  const entryCount = contents.readUInt16LE(eocdOffset + 10);
  const centralDirectoryBytes = contents.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = contents.readUInt32LE(eocdOffset + 16);
  if (
    diskNumber !== 0
    || centralDirectoryDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0
    || entryCount === 0xffff
    || centralDirectoryBytes === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
    || centralDirectoryOffset + centralDirectoryBytes !== eocdOffset
  ) return { ok: false, reason: "invalid" };
  if (entryCount > DOCX_PREVIEW_MAX_ARCHIVE_ENTRIES) {
    return { ok: false, reason: "resource_limit" };
  }

  let cursor = centralDirectoryOffset;
  let expandedBytes = 0;
  const entryNames = new Set<string>();
  const localHeaderOffsets = new Set<number>();
  const compressedEntries: Array<{
    dataOffset: number;
    compressedBytes: number;
    uncompressedBytes: number;
  }> = [];
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (cursor + 46 > eocdOffset || contents.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      return { ok: false, reason: "invalid" };
    }
    const flags = contents.readUInt16LE(cursor + 8);
    const compressionMethod = contents.readUInt16LE(cursor + 10);
    const compressedBytes = contents.readUInt32LE(cursor + 20);
    const uncompressedBytes = contents.readUInt32LE(cursor + 24);
    const nameBytes = contents.readUInt16LE(cursor + 28);
    const extraBytes = contents.readUInt16LE(cursor + 30);
    const commentBytes = contents.readUInt16LE(cursor + 32);
    const diskStart = contents.readUInt16LE(cursor + 34);
    const localHeaderOffset = contents.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (
      nextCursor > eocdOffset
      || diskStart !== 0
      || (flags & 0x2041) !== 0
      || (compressionMethod !== 0 && compressionMethod !== 8)
      || compressedBytes === 0xffffffff
      || uncompressedBytes === 0xffffffff
      || localHeaderOffset === 0xffffffff
    ) return { ok: false, reason: "invalid" };

    const entryName = contents.subarray(cursor + 46, cursor + 46 + nameBytes);
    const entryNameKey = entryName.toString("hex");
    if (
      !isSafeZipEntryName(entryName)
      || entryNames.has(entryNameKey)
      || localHeaderOffsets.has(localHeaderOffset)
    ) return { ok: false, reason: "invalid" };
    entryNames.add(entryNameKey);
    localHeaderOffsets.add(localHeaderOffset);

    if (
      uncompressedBytes > DOCX_PREVIEW_MAX_ENTRY_BYTES
      || expandedBytes + uncompressedBytes > DOCX_PREVIEW_MAX_EXPANDED_BYTES
      || (uncompressedBytes > 0 && compressedBytes === 0)
      || uncompressedBytes > compressedBytes * DOCX_PREVIEW_MAX_COMPRESSION_RATIO
    ) return { ok: false, reason: "resource_limit" };
    if (compressionMethod === 0 && compressedBytes !== uncompressedBytes) {
      return { ok: false, reason: "invalid" };
    }
    expandedBytes += uncompressedBytes;

    if (
      localHeaderOffset + 30 > centralDirectoryOffset
      || contents.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_SIGNATURE
    ) return { ok: false, reason: "invalid" };
    const localFlags = contents.readUInt16LE(localHeaderOffset + 6);
    const localCompressionMethod = contents.readUInt16LE(localHeaderOffset + 8);
    const localCompressedBytes = contents.readUInt32LE(localHeaderOffset + 18);
    const localUncompressedBytes = contents.readUInt32LE(localHeaderOffset + 22);
    const localNameBytes = contents.readUInt16LE(localHeaderOffset + 26);
    const localExtraBytes = contents.readUInt16LE(localHeaderOffset + 28);
    const localDataOffset = localHeaderOffset + 30 + localNameBytes + localExtraBytes;
    if (
      localFlags !== flags
      || localCompressionMethod !== compressionMethod
      || localDataOffset + compressedBytes > centralDirectoryOffset
      || localNameBytes !== nameBytes
      || !contents.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameBytes).equals(entryName)
      || ((flags & 0x8) === 0 && (
        localCompressedBytes !== compressedBytes
        || localUncompressedBytes !== uncompressedBytes
      ))
    ) return { ok: false, reason: "invalid" };

    if (compressionMethod === 8) {
      compressedEntries.push({ dataOffset: localDataOffset, compressedBytes, uncompressedBytes });
    }

    cursor = nextCursor;
  }

  if (cursor !== eocdOffset) return { ok: false, reason: "invalid" };
  for (const entry of compressedEntries) {
    try {
      const expanded = inflateRawSync(
        contents.subarray(entry.dataOffset, entry.dataOffset + entry.compressedBytes),
        { maxOutputLength: Math.max(1, entry.uncompressedBytes) },
      );
      if (expanded.byteLength !== entry.uncompressedBytes) return { ok: false, reason: "invalid" };
    } catch (error) {
      return {
        ok: false,
        reason: (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
          ? "resource_limit"
          : "invalid",
      };
    }
  }
  return { ok: true };
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function isActiveContentType(contentType: string): boolean {
  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  return mime === "image/svg+xml" || mime === "text/html" || mime === "application/xhtml+xml";
}

export function getContentDisposition(
  filePath: string,
  asDownload = false,
  contentType = "application/octet-stream",
): string {
  const disposition = asDownload || isActiveContentType(contentType) ? "attachment" : "inline";
  const fileName = path.basename(filePath);
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

export function getFileResponseHeaders(
  filePath: string,
  contentType: string,
  asDownload = false,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...PRIVATE_FILE_RESPONSE_HEADERS,
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Content-Disposition": getContentDisposition(filePath, asDownload, contentType),
    "Referrer-Policy": "no-referrer",
  };
  if (isActiveContentType(contentType)) {
    headers["Content-Security-Policy"] = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  }
  return headers;
}
