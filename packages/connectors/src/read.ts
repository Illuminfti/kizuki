import { constants } from "node:fs";
import { lstat, open, readFile, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { KizukiError } from "./errors";
import { MAX_EXPORT_BYTES, errorMessage } from "./util";

function notARegularFile(path: string, connectorId: string): KizukiError {
  return new KizukiError(
    "misconfigured",
    `${connectorId}: not a regular file: ${path}`,
  );
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
export interface BoundedFile {
  text: string;
  /**
   * What the file cost to read, before a BOM was dropped and CRLF collapsed.
   * A budget spent across several files must charge the bytes that left the
   * disk, or a CRLF export would buy twice the bound it declares.
   */
  byte_size: number;
}

export async function readBoundedUtf8File(
  path: string,
  connectorId: string,
  maxBytes = MAX_EXPORT_BYTES,
): Promise<BoundedFile> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrno(error, "ELOOP")) throw notARegularFile(path, connectorId);
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: cannot read ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notARegularFile(path, connectorId);
    if (info.size > maxBytes) {
      throw new KizukiError(
        "misconfigured",
        `${connectorId}: ${path} exceeds the ${maxBytes} byte import limit`,
      );
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    // The file name is the owner's own; the contents are never quoted back.
    throw new KizukiError(
      "parse_error",
      `${connectorId}: ${basename(path)} is not valid UTF-8`,
      { cause: error },
    );
  }
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return {
    text: withoutBom.replace(/\r\n?/g, "\n"),
    byte_size: bytes.byteLength,
  };
}

export async function readBoundedUtf8(
  path: string,
  connectorId: string,
  maxBytes = MAX_EXPORT_BYTES,
): Promise<string> {
  return (await readBoundedUtf8File(path, connectorId, maxBytes)).text;
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
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrno(error, "ELOOP")) throw notARegularFile(path, connectorId);
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: cannot read ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  let window: Buffer;
  let complete: boolean;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notARegularFile(path, connectorId);
    const wanted = Math.min(info.size, windowBytes);
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await handle.read(buffer, 0, wanted, 0);
    window = buffer.subarray(0, bytesRead);
    complete = info.size <= windowBytes;
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
      `${connectorId}: ${basename(path)} has no line break in its first ${windowBytes} bytes`,
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
      `${connectorId}: ${basename(path)} is not valid UTF-8`,
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
