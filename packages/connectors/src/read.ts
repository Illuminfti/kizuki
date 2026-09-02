import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { KizukiError } from "./errors";
import { MAX_EXPORT_BYTES, errorMessage } from "./util";

export function notARegularFile(label: string, connectorId: string): KizukiError {
  return new KizukiError(
    "misconfigured",
    `${connectorId}: not a regular file: ${label}`,
  );
}

/**
 * Why a file would not open, without the path the filesystem repeats back: a
 * caller reading a name it found inside an export names the configured path
 * instead, and the operating system's own message would put the export's name
 * back into the refusal.
 */
export function readReason(error: unknown): string {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" ? code : errorMessage(error);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Reads an export file the way the importers need it: size-checked before a
 * byte is read, never through a symlink, strictly UTF-8, newline-normalized.
 *
 * One descriptor serves the type check, the size check and the read, so the
 * file cannot be swapped for another between them. `O_NOFOLLOW` makes the
 * kernel refuse a symlink instead of the caller noticing afterwards, and
 * `O_NONBLOCK` keeps a pipe planted in an export folder from hanging the
 * import before its file type is even known.
 */
function overLimit(
  label: string,
  connectorId: string,
  maxBytes: number,
): KizukiError {
  return new KizukiError(
    "misconfigured",
    `${connectorId}: ${label} exceeds the ${maxBytes} byte import limit`,
  );
}

/**
 * Fills a buffer, or as much of it as the file has left. A regular file hands
 * back everything asked for until it ends, but a short read is not an end, and
 * treating one as an end would silently truncate an export.
 */
async function fill(
  handle: FileHandle,
  bytes: Buffer,
  from: number,
  through: number,
): Promise<number> {
  let at = from;
  while (at < through) {
    const { bytesRead } = await handle.read(bytes, at, through - at, at);
    if (bytesRead === 0) return at;
    at += bytesRead;
  }
  return at;
}

/**
 * The bytes of an open file, up to a bound the file cannot talk its way past.
 * A size is what a file claims before the read; a file that reports less than
 * it holds, or that grows after it was measured, would otherwise spend more of
 * an import's budget than the bound allows. Reading one byte past the bound is
 * what proves the bound was passed.
 *
 * `expected` is only the first allocation: an honest file is read into one
 * buffer of its own size and never copied.
 */
export async function readBoundedBytes(
  handle: FileHandle,
  maxBytes: number,
  connectorId: string,
  label: string,
  expected = 0,
): Promise<Buffer> {
  const limit = maxBytes + 1;
  let capacity = Math.min(Math.max(expected, 0) + 1, limit);
  let bytes = Buffer.alloc(capacity);
  let total = 0;
  for (;;) {
    if (total === capacity) {
      if (capacity === limit) break;
      capacity = Math.min(capacity * 2, limit);
      const grown = Buffer.alloc(capacity);
      bytes.copy(grown);
      bytes = grown;
    }
    const read = await fill(handle, bytes, total, capacity);
    if (read === total) break;
    total = read;
  }
  if (total > maxBytes) throw overLimit(label, connectorId, maxBytes);
  return bytes.subarray(0, total);
}

export interface BoundedFile {
  text: string;
  /**
   * What the file cost to read, before a BOM was dropped and CRLF collapsed.
   * A budget spent across several files must charge the bytes that left the
   * disk, or a CRLF export would buy twice the bound it declares.
   */
  byte_size: number;
}

export async function openFile(
  path: string,
  connectorId: string,
  label: string,
): Promise<FileHandle> {
  try {
    return await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrno(error, "ELOOP")) throw notARegularFile(label, connectorId);
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: cannot read ${label}: ${readReason(error)}`,
      { cause: error },
    );
  }
}

/** Reads an open file to the end its bound allows, and closes it either way. */
export async function boundedFile(
  handle: FileHandle,
  connectorId: string,
  maxBytes: number,
  label: string,
): Promise<BoundedFile> {
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notARegularFile(label, connectorId);
    // Refused before a byte is read, when the file says up front that it is
    // too big. What it says is not what it delivers, so the read is bounded
    // on its own below.
    if (info.size > maxBytes) throw overLimit(label, connectorId, maxBytes);
    bytes = await readBoundedBytes(
      handle,
      maxBytes,
      connectorId,
      label,
      info.size,
    );
  } finally {
    await handle.close();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    // The contents are never quoted back, and neither is a name the importer
    // discovered rather than the owner configured.
    throw new KizukiError(
      "parse_error",
      `${connectorId}: ${label} is not valid UTF-8`,
      { cause: error },
    );
  }
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return {
    text: withoutBom.replace(/\r\n?/g, "\n"),
    byte_size: bytes.byteLength,
  };
}

export async function readBoundedUtf8File(
  path: string,
  connectorId: string,
  maxBytes = MAX_EXPORT_BYTES,
  /**
   * What a refusal names in place of the path. A file name discovered inside
   * an export is a contact, a chat or an article title, so a caller that found
   * its path rather than being configured with it passes the configured path
   * here and the discovered name never leaves the process (§0.6).
   */
  label = path,
): Promise<BoundedFile> {
  return boundedFile(
    await openFile(path, connectorId, label),
    connectorId,
    maxBytes,
    label,
  );
}

export async function readBoundedUtf8(
  path: string,
  connectorId: string,
  maxBytes = MAX_EXPORT_BYTES,
  label = path,
): Promise<string> {
  return (await readBoundedUtf8File(path, connectorId, maxBytes, label)).text;
}

/** Enough for any header line an export could honestly carry. */
const MAX_HEADER_BYTES = 64 * 1024;

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * The first line of a file that carries something, for a health check that has
 * to prove the file opens and says what it claims to be without paying for the
 * whole export. A byte-order mark and leading blank lines are skipped, because
 * the row readers skip them too and health must agree with the import.
 */
export async function readFirstLine(
  path: string,
  connectorId: string,
  windowBytes = MAX_HEADER_BYTES,
): Promise<string> {
  return firstLineOf(
    await openFile(path, connectorId, path),
    connectorId,
    path,
    windowBytes,
  );
}

/**
 * The opening bytes of an open file, closing it either way. For a probe that
 * has to prove a file opens and says what it claims to be without paying for
 * an export it is not going to keep.
 */
export async function headOf(
  handle: FileHandle,
  connectorId: string,
  label: string,
  windowBytes: number,
): Promise<Buffer> {
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notARegularFile(label, connectorId);
    const buffer = Buffer.alloc(windowBytes);
    const read = await fill(handle, buffer, 0, windowBytes);
    return buffer.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/** The first line of an open file, closing it either way. */
export async function firstLineOf(
  handle: FileHandle,
  connectorId: string,
  label: string,
  windowBytes = MAX_HEADER_BYTES,
): Promise<string> {
  let window: Buffer;
  let complete: boolean;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notARegularFile(label, connectorId);
    const buffer = Buffer.alloc(windowBytes);
    // Where the file ends is what the read says, not what the size said: a
    // file that reports less than it holds would otherwise look complete and
    // its first line would be whatever the window happened to cut.
    const read = await fill(handle, buffer, 0, windowBytes);
    window = buffer.subarray(0, read);
    complete = read < windowBytes;
  } finally {
    await handle.close();
  }
  // A line feed can never be part of a multi-byte sequence, so cutting at one
  // leaves whole characters; without one the window is only decodable when it
  // is the entire file. Everything skipped below is a mark or a line break, so
  // the cut still lands between characters.
  let start = 0;
  if (window.subarray(0, 3).equals(UTF8_BOM)) start = 3;
  while (window[start] === 0x0a || window[start] === 0x0d) start += 1;
  const cut = window.indexOf(0x0a, start);
  if (cut === -1 && !complete) {
    throw new KizukiError(
      "parse_error",
      `${connectorId}: ${label} has no line break in its first ${windowBytes} bytes`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      window.subarray(start, cut === -1 ? window.length : cut),
    );
  } catch (error) {
    throw new KizukiError(
      "parse_error",
      `${connectorId}: ${label} is not valid UTF-8`,
      { cause: error },
    );
  }
  return text.replace(/\r$/, "");
}

/**
 * Size of a media file without opening it. Anything that is not a plain file —
 * missing, a symlink, a directory, an unreadable device — is simply absent, so
 * a broken export costs the owner an attachment reference, not the import.
 */
export async function statRegularFile(
  path: string,
): Promise<{ byte_size: number } | null> {
  try {
    const info = await lstat(path);
    return info.isFile() ? { byte_size: info.size } : null;
  } catch {
    return null;
  }
}
