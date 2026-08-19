"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");
const { Writable } = require("stream");
const { StringDecoder } = require("string_decoder");

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_BACKUPS = 1;
const LOG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REDACTION_TEXT = "[REDACTED]";
const SCAN_TAIL_CHARS = 192;
const URL_AUTHORITY_LIMIT = 512;
const TOKEN_CHARACTER_PATTERN = /[A-Za-z0-9_-]/;
const UNQUOTED_VALUE_DELIMITER_PATTERN = /[\s&,;}\])>#"'`]/;
const URL_AUTHORITY_DELIMITER_PATTERN = /[/?#\s"'`<>\\]/;
const DETECTION_RULES = [
  { type: "token", pattern: /pihub_key_[A-Za-z0-9_-]{43}/g },
  { type: "token", pattern: /pihub-[A-Za-z0-9_-]{43}/g },
  {
    type: "authorization",
    pattern: /["']?authorization["']?[ \t]{0,64}[:=][ \t]{0,64}(?:(["'])|(?=[^\s&,;}\])>#"'`]))/gi,
    requiresBoundary: true,
  },
  {
    type: "authorization",
    pattern: /\bPiHub-HMAC-SHA256[ \t]+(?=[^\s&,;}\])>#"'`])/gi,
  },
  {
    type: "field",
    pattern: /["']?(?:api_key|api-key|apikey|x-api-key|token|access_token|access-token|secret|password)["']?[ \t]{0,64}[:=][ \t]{0,64}(?:(["'])|(?=[^\s&,;}\])>#"'`]))/gi,
    requiresBoundary: true,
  },
  { type: "url", pattern: /(?:https?|wss?|ftp):\/\//gi },
];

function findNextSensitiveValue(value, start) {
  let earliest = null;
  for (const rule of DETECTION_RULES) {
    rule.pattern.lastIndex = start;
    let match = rule.pattern.exec(value);
    while (
      match
      && rule.requiresBoundary
      && match.index > 0
      && TOKEN_CHARACTER_PATTERN.test(value[match.index - 1])
    ) {
      match = rule.pattern.exec(value);
    }
    if (!match || (earliest && match.index >= earliest.match.index)) continue;
    earliest = { match, rule };
  }
  return earliest;
}

class StreamingLogRedactor {
  constructor() {
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
    this.state = null;
  }

  write(chunk) {
    return this.process(this.decoder.write(chunk), false);
  }

  end() {
    return this.process(this.decoder.end(), true);
  }

  consumeState(value, cursor, output) {
    if (this.state.kind === "token") {
      while (cursor < value.length && TOKEN_CHARACTER_PATTERN.test(value[cursor])) cursor += 1;
      if (cursor < value.length) this.state = null;
      return cursor;
    }

    if (this.state.kind === "quoted") {
      while (cursor < value.length) {
        const character = value[cursor];
        if (character === "\r" || character === "\n") {
          this.state = null;
          break;
        }
        cursor += 1;
        if (this.state.escaped) {
          this.state.escaped = false;
        } else if (character === "\\") {
          this.state.escaped = true;
        } else if (character === this.state.quote) {
          output.push(character);
          this.state = null;
          break;
        }
      }
      return cursor;
    }

    if (this.state.kind === "unquoted") {
      while (
        cursor < value.length
        && !UNQUOTED_VALUE_DELIMITER_PATTERN.test(value[cursor])
      ) cursor += 1;
      if (cursor < value.length) this.state = null;
      return cursor;
    }

    if (this.state.kind === "line") {
      while (cursor < value.length && value[cursor] !== "\r" && value[cursor] !== "\n") {
        cursor += 1;
      }
      if (cursor < value.length) this.state = null;
      return cursor;
    }

    while (cursor < value.length) {
      const character = value[cursor];
      if (character === "@") {
        if (!this.state.redacted) output.push(REDACTION_TEXT);
        output.push("@");
        this.state = null;
        return cursor + 1;
      }
      if (URL_AUTHORITY_DELIMITER_PATTERN.test(character)) {
        if (!this.state.redacted) output.push(this.state.buffer);
        this.state = null;
        return cursor;
      }
      if (!this.state.redacted) {
        if (this.state.buffer.length < URL_AUTHORITY_LIMIT) {
          this.state.buffer += character;
        } else {
          output.push(REDACTION_TEXT);
          this.state.buffer = "";
          this.state.redacted = true;
        }
      }
      cursor += 1;
    }
    return cursor;
  }

  process(text, final) {
    const value = this.pending + text;
    const output = [];
    let cursor = 0;
    this.pending = "";

    while (cursor < value.length) {
      if (this.state) {
        const previousCursor = cursor;
        cursor = this.consumeState(value, cursor, output);
        if (this.state && cursor === value.length) break;
        if (cursor === previousCursor && this.state) {
          throw new Error("PiHub log redaction did not make progress.");
        }
        continue;
      }

      const detected = findNextSensitiveValue(value, cursor);
      if (detected) {
        output.push(value.slice(cursor, detected.match.index));
        cursor = detected.match.index + detected.match[0].length;
        if (detected.rule.type === "token") {
          output.push(REDACTION_TEXT);
          this.state = { kind: "token" };
        } else if (detected.rule.type === "field" || detected.rule.type === "authorization") {
          output.push(detected.match[0], REDACTION_TEXT);
          const quote = detected.match[1];
          if (quote) {
            this.state = { escaped: false, kind: "quoted", quote };
          } else if (detected.rule.type === "authorization") {
            this.state = { kind: "line" };
          } else {
            this.state = { kind: "unquoted" };
          }
        } else {
          output.push(detected.match[0]);
          this.state = { buffer: "", kind: "url-authority", redacted: false };
        }
        continue;
      }

      if (final) {
        output.push(value.slice(cursor));
        cursor = value.length;
      } else {
        const lastLineBreak = Math.max(value.lastIndexOf("\n"), value.lastIndexOf("\r"));
        const safeEnd = Math.max(
          cursor,
          value.length - SCAN_TAIL_CHARS,
          lastLineBreak >= cursor ? lastLineBreak + 1 : cursor,
        );
        output.push(value.slice(cursor, safeEnd));
        this.pending = value.slice(safeEnd);
        cursor = value.length;
      }
    }

    if (final) {
      if (this.state?.kind === "url-authority" && !this.state.redacted) {
        output.push(this.state.buffer);
      }
      this.state = null;
      this.pending = "";
    }
    return output.join("");
  }
}

function assertLogOptions({ directory, name, maxBytes, backups }) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) {
    throw new Error("The PiHub log directory must be an absolute path without control characters.");
  }
  if (typeof name !== "string" || !LOG_NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw new Error("The PiHub log name is invalid.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 100 * 1024 * 1024) {
    throw new Error("The PiHub log size limit is invalid.");
  }
  if (!Number.isSafeInteger(backups) || backups < 0 || backups > 5) {
    throw new Error("The PiHub log backup limit is invalid.");
  }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to use a non-directory or symbolic link for PiHub logs: ${directory}`);
  }
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function regularFileStat(file, { allowMissing = false } = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing to use a non-regular file or symbolic link for PiHub logs: ${file}`);
    }
    return stat;
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
}

function removeRegularFile(file) {
  const stat = regularFileStat(file, { allowMissing: true });
  if (stat) fs.unlinkSync(file);
}

function openPrivateAppendFile(file) {
  regularFileStat(file, { allowMissing: true });
  const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(
    file,
    fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow,
    0o600,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(`PiHub log is not a regular file: ${file}`);
    const current = regularFileStat(file);
    if (
      process.platform !== "win32"
      && (opened.dev !== current.dev || opened.ino !== current.ino)
    ) {
      throw new Error(`PiHub log changed while it was being opened: ${file}`);
    }
    if (process.platform !== "win32") fs.fchmodSync(descriptor, 0o600);
    return { descriptor, size: opened.size };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function stagedTail(source, destination, maxBytes) {
  const sourceStat = regularFileStat(source);
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`,
  );
  let sourceDescriptor;
  let targetDescriptor;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    sourceDescriptor = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(sourceDescriptor);
    if (
      !opened.isFile()
      || opened.size !== sourceStat.size
      || (
        process.platform !== "win32"
        && (opened.dev !== sourceStat.dev || opened.ino !== sourceStat.ino)
      )
    ) {
      throw new Error(`PiHub log changed while it was being bounded: ${source}`);
    }
    targetDescriptor = fs.openSync(temporary, "wx", 0o600);
    const bytesToKeep = Math.min(opened.size, maxBytes);
    const buffer = Buffer.allocUnsafe(bytesToKeep);
    let offset = 0;
    while (offset < bytesToKeep) {
      const count = fs.readSync(
        sourceDescriptor,
        buffer,
        offset,
        bytesToKeep - offset,
        opened.size - bytesToKeep + offset,
      );
      if (count === 0) throw new Error(`PiHub log could not be read completely: ${source}`);
      offset += count;
    }
    fs.writeFileSync(targetDescriptor, buffer);
    fs.fsyncSync(targetDescriptor);
    fs.closeSync(targetDescriptor);
    targetDescriptor = undefined;
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    removeRegularFile(destination);
    fs.renameSync(temporary, destination);
    fs.unlinkSync(source);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  } finally {
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
    if (targetDescriptor !== undefined) fs.closeSync(targetDescriptor);
  }
}

function rotateFiles(file, backups) {
  for (let index = 0; index <= backups; index += 1) {
    regularFileStat(index === 0 ? file : `${file}.${index}`, { allowMissing: true });
  }
  for (let index = backups; index >= 1; index -= 1) {
    const destination = `${file}.${index}`;
    const source = index === 1 ? file : `${file}.${index - 1}`;
    removeRegularFile(destination);
    if (regularFileStat(source, { allowMissing: true })) fs.renameSync(source, destination);
  }
  if (backups === 0) removeRegularFile(file);
}

class BoundedLogStream extends Writable {
  constructor(options) {
    super({ decodeStrings: true });
    this.directory = options.directory;
    this.file = path.join(options.directory, options.name);
    this.maxBytes = options.maxBytes;
    this.backups = options.backups;
    this.descriptor = undefined;
    this.size = 0;
    this.redactor = new StreamingLogRedactor();
    ensurePrivateDirectory(this.directory);
    const existing = regularFileStat(this.file, { allowMissing: true });
    if (existing && existing.size >= this.maxBytes) {
      if (this.backups === 0) removeRegularFile(this.file);
      else stagedTail(this.file, `${this.file}.1`, this.maxBytes);
    }
    this.open();
  }

  open() {
    const opened = openPrivateAppendFile(this.file);
    this.descriptor = opened.descriptor;
    this.size = opened.size;
  }

  close() {
    if (this.descriptor === undefined) return;
    fs.closeSync(this.descriptor);
    this.descriptor = undefined;
  }

  rotate() {
    this.close();
    rotateFiles(this.file, this.backups);
    this.open();
  }

  writeSanitized(value) {
    const buffer = Buffer.from(value, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      if (this.size >= this.maxBytes) this.rotate();
      const count = Math.min(buffer.length - offset, this.maxBytes - this.size);
      const written = fs.writeSync(this.descriptor, buffer, offset, count);
      if (written < 1) throw new Error(`PiHub log could not be written: ${this.file}`);
      this.size += written;
      offset += written;
    }
  }

  _write(chunk, encoding, callback) {
    try {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      this.writeSanitized(this.redactor.write(buffer));
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _final(callback) {
    try {
      this.writeSanitized(this.redactor.end());
      this.close();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _destroy(error, callback) {
    try {
      this.close();
      callback(error);
    } catch (closeError) {
      callback(error ?? closeError);
    }
  }
}

function createBoundedLogStream({
  directory,
  name,
  maxBytes = DEFAULT_MAX_BYTES,
  backups = DEFAULT_BACKUPS,
}) {
  assertLogOptions({ directory, name, maxBytes, backups });
  return new BoundedLogStream({ directory, name, maxBytes, backups });
}

module.exports = {
  DEFAULT_BACKUPS,
  DEFAULT_MAX_BYTES,
  createBoundedLogStream,
};
