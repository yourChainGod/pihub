import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { Readable, Transform, type Readable as NodeReadable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import busboy from "busboy";
import {
  assertUploadDirectoryGuard,
  captureUploadDirectoryGuard,
  forgetStagedUploadTemporaryFile,
  registerStagedUploadTemporaryFile,
} from "./file-upload";

export const DEFAULT_MULTIPART_UPLOAD_LIMITS = Object.freeze({
  maxRequestBytes: 1120 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalFileBytes: 1024 * 1024 * 1024,
  maxFiles: 256,
  maxHeaderPairs: 128,
});

export interface MultipartUploadLimits {
  maxRequestBytes: number;
  maxFileBytes: number;
  maxTotalFileBytes: number;
  maxFiles: number;
  maxHeaderPairs: number;
}

export type MultipartUploadErrorKind =
  | "digest_mismatch"
  | "file_too_large"
  | "malformed"
  | "request_too_large"
  | "too_many_files"
  | "total_too_large";

export class MultipartUploadError extends Error {
  constructor(
    readonly kind: MultipartUploadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "MultipartUploadError";
  }
}

export interface StagedUploadFile {
  name: string;
  temporaryPath: string;
  size: number;
}

function requestHeaders(request: Request): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
}

function digestsEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export async function cleanupStagedUploadFiles(files: readonly StagedUploadFile[]): Promise<void> {
  const results = await Promise.allSettled(files.map(async ({ temporaryPath }) => {
    try {
      await fs.promises.unlink(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      forgetStagedUploadTemporaryFile(temporaryPath);
    }
  }));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length > 0) throw new AggregateError(failures, "Could not clean up upload temporary files");
}

/**
 * Stream the exact multipart wire body into private same-directory temporary
 * files. Nothing is published until the caller has received this result.
 */
export async function stageAuthenticatedMultipartUpload(
  request: Request,
  directory: string,
  expectedContentSha256: string,
  limits: MultipartUploadLimits = DEFAULT_MULTIPART_UPLOAD_LIMITS,
): Promise<StagedUploadFile[]> {
  if (!/^[a-f0-9]{64}$/.test(expectedContentSha256)) {
    throw new MultipartUploadError("digest_mismatch", "Invalid authenticated upload digest");
  }

  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength
    && /^\d+$/.test(declaredLength)
    && Number(declaredLength) > limits.maxRequestBytes
  ) {
    throw new MultipartUploadError("request_too_large", "Upload request is too large");
  }

  const directoryGuard = captureUploadDirectoryGuard(directory);

  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: requestHeaders(request),
      defParamCharset: "utf8",
      preservePath: true,
      highWaterMark: 64 * 1024,
      fileHwm: 64 * 1024,
      limits: {
        fieldNameSize: 64,
        fieldSize: 0,
        fields: 0,
        fileSize: limits.maxFileBytes,
        files: limits.maxFiles,
        parts: limits.maxFiles + 1,
        headerPairs: limits.maxHeaderPairs,
      },
    });
  } catch {
    throw new MultipartUploadError("malformed", "Malformed multipart upload");
  }

  const source = request.body
    ? Readable.fromWeb(request.body as NodeWebReadableStream<Uint8Array>)
    : Readable.from([]);
  const digest = createHash("sha256");
  const staged: StagedUploadFile[] = [];
  const fileStreams = new Set<NodeReadable>();
  const writerTasks: Promise<void>[] = [];
  const openedStats = new Map<string, fs.Stats>();
  let rawBytes = 0;
  let totalFileBytes = 0;
  let failure: Error | null = null;

  const recordFailure = (error: Error) => {
    failure ??= error;
  };

  const normalizeWriterFailure = (error: unknown): Error => {
    if (error instanceof MultipartUploadError) return error;
    if (error instanceof Error && error.message === "Unexpected end of form") {
      return new MultipartUploadError("malformed", "Malformed multipart upload");
    }
    return error instanceof Error ? error : new Error("Upload stream failed");
  };

  const abortPipeline = (error: Error) => {
    recordFailure(error);
    for (const stream of fileStreams) {
      if (!stream.destroyed) stream.destroy(error);
    }
    if (!parser.destroyed) parser.destroy(error);
    if (!source.destroyed) source.destroy(error);
  };

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      rawBytes += chunk.byteLength;
      if (rawBytes > limits.maxRequestBytes) {
        const error = new MultipartUploadError("request_too_large", "Upload request is too large");
        failure ??= error;
        callback(error);
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });

  parser.on("file", (fieldName, file, info) => {
    if (fieldName !== "files") {
      recordFailure(new MultipartUploadError("malformed", "Unexpected multipart file field"));
      file.resume();
      return;
    }

    const stagedFile: StagedUploadFile = {
      name: info.filename,
      temporaryPath: path.join(directory, `.pihub-${randomUUID()}.upload`),
      size: 0,
    };
    staged.push(stagedFile);
    fileStreams.add(file);
    // A directory guard can fail before pipeline() attaches its own listener.
    file.on("error", (error: Error) => recordFailure(normalizeWriterFailure(error)));
    // Opening and validating the destination descriptor is asynchronous. Keep
    // Busboy backpressured until pipeline() owns the stream.
    file.pause();
    file.on("data", (chunk: Buffer) => {
      stagedFile.size += chunk.byteLength;
      totalFileBytes += chunk.byteLength;
      if (totalFileBytes > limits.maxTotalFileBytes) {
        recordFailure(new MultipartUploadError("total_too_large", "Uploaded files are too large"));
      }
    });
    file.once("limit", () => {
      // Busboy updates its internal truncated flag immediately after this
      // callback, so defer destruction and let the bounded parser drain.
      recordFailure(new MultipartUploadError("file_too_large", "An uploaded file is too large"));
    });

    const task = (async () => {
      assertUploadDirectoryGuard(directory, directoryGuard);
      const noFollow = process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
        ? fs.constants.O_NOFOLLOW
        : 0;
      const handle = await fs.promises.open(
        stagedFile.temporaryPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      try {
        const openedStat = await handle.stat();
        assertUploadDirectoryGuard(directory, directoryGuard);
        const namedStat = await fs.promises.lstat(stagedFile.temporaryPath);
        if (
          !namedStat.isFile()
          || namedStat.isSymbolicLink()
          || namedStat.dev !== openedStat.dev
          || namedStat.ino !== openedStat.ino
          || namedStat.birthtimeMs !== openedStat.birthtimeMs
        ) {
          throw new Error("Upload temporary file changed before it could be written");
        }
        const writer = handle.createWriteStream({ autoClose: false, emitClose: false });
        try {
          await pipeline(file, writer);
          await handle.sync();
        } finally {
          // FileHandle.close() waits for attached streams, even after "finish".
          writer.destroy();
        }
        openedStats.set(stagedFile.temporaryPath, openedStat);
      } finally {
        await handle.close();
      }
    })()
      .catch((error: unknown) => {
        abortPipeline(normalizeWriterFailure(error));
      })
      .finally(() => {
        fileStreams.delete(file);
      });
    writerTasks.push(task);
  });
  parser.on("field", () => {
    recordFailure(new MultipartUploadError("malformed", "Unexpected multipart field"));
  });
  parser.once("filesLimit", () => {
    recordFailure(new MultipartUploadError("too_many_files", "Too many uploaded files"));
  });
  parser.once("partsLimit", () => {
    recordFailure(new MultipartUploadError("too_many_files", "Too many multipart parts"));
  });
  parser.once("fieldsLimit", () => {
    recordFailure(new MultipartUploadError("malformed", "Multipart fields are not allowed"));
  });
  parser.on("error", (error: unknown) => {
    if (failure) return;
    recordFailure(error instanceof MultipartUploadError
      ? error
      : new MultipartUploadError("malformed", "Malformed multipart upload"));
  });

  const abort = () => {
    abortPipeline(new MultipartUploadError("malformed", "Upload was interrupted"));
  };
  const listenForAbort = !request.signal.aborted;
  if (listenForAbort) request.signal.addEventListener("abort", abort, { once: true });
  else abort();

  try {
    try {
      await pipeline(source, meter, parser);
    } catch (error) {
      failure ??= error instanceof MultipartUploadError
        ? error
        : new MultipartUploadError("malformed", "Malformed multipart upload");
    }
    await Promise.all(writerTasks);
    if (failure) throw failure;
    if (staged.length === 0) {
      throw new MultipartUploadError("malformed", "No upload files were provided");
    }
    if (!digestsEqual(digest.digest("hex"), expectedContentSha256)) {
      throw new MultipartUploadError("digest_mismatch", "Upload body digest did not match");
    }
    assertUploadDirectoryGuard(directory, directoryGuard);
    for (const file of staged) {
      const openedStat = openedStats.get(file.temporaryPath);
      if (!openedStat) throw new Error("Upload temporary file was not completed");
      registerStagedUploadTemporaryFile(file.temporaryPath, directoryGuard, openedStat);
    }
    return staged;
  } catch (error) {
    try {
      await cleanupStagedUploadFiles(staged);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Upload failed and temporary files could not be removed");
    }
    throw error;
  } finally {
    if (listenForAbort) request.signal.removeEventListener("abort", abort);
  }
}
