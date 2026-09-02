import { constants } from "node:fs";
import { lstat, open, readFile, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { HealthReport, isPlainObject } from "@kizuki/core";
import type { SensitivityHint } from "@kizuki/core";
import { KizukiError } from "./errors";

export function requirePathConfig(
  config: unknown,
  connectorId: string,
): string {
  if (!isPlainObject(config) || typeof config["path"] !== "string") {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: config.path must be a non-empty string`,
    );
  }
  const path = config["path"];
  if (path.length === 0) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: config.path must be a non-empty string`,
    );
  }
  return path;
}

export async function pathHealth(
  path: string,
  expected: "file" | "directory",
): Promise<HealthReport> {
  try {
    const info = await stat(path);
    const matches = expected === "file" ? info.isFile() : info.isDirectory();
    return new HealthReport({
      state: matches ? "ok" : "misconfigured",
      checked_at: new Date().toISOString(),
      ...(!matches ? { detail: `path is not a ${expected}: ${path}` } : {}),
    });
  } catch (error) {
    return new HealthReport({
      state: "misconfigured",
      checked_at: new Date().toISOString(),
      detail: `cannot access ${path}: ${errorMessage(error)}`,
    });
  }
}

export async function readUtf8(
  path: string,
  connectorId: string,
): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: cannot read ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function parseJsonArray(source: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new KizukiError("parse_error", `${label}: malformed JSON`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new KizukiError("parse_error", `${label}: expected a JSON array`);
  }
  return parsed;
}

export function normalizedDate(
  value: unknown,
  fallback: string,
  unit: "seconds" | "date",
): string {
  const raw =
    unit === "seconds" && typeof value === "number" ? value * 1000 : value;
  if (typeof raw === "number" || typeof raw === "string") {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallback;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
/**
 * Snapshot importers read whole export files the owner unzipped by hand. The
 * bounds below are the only thing between a hostile export and unbounded
 * allocation, so every parser in this package applies them.
 */
export const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
export const MAX_RECORDS = 1_000_000;
export const MAX_RECORD_BYTES = 1024 * 1024;

/** Fixed so a fixture hashes identically on every run and every machine. */
export const FIXTURE_OBSERVED_AT = "2026-01-01T00:00:00.000Z";

// Well past any plausible export, and short of the magnitudes where seconds
// and milliseconds stop being distinguishable.
const MAX_UNIX_SECONDS = 2 ** 40;

export function unixSecondsToIso(value: unknown, where: string): string {
  const seconds =
    typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : typeof value === "number" && Number.isSafeInteger(value)
        ? value
        : undefined;
  if (seconds === undefined || seconds <= 0 || seconds >= MAX_UNIX_SECONDS) {
    throw new KizukiError("parse_error", `${where}: invalid unix timestamp`);
  }
  return new Date(seconds * 1000).toISOString();
}

export function isoToRfc3339(value: unknown, where: string): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new KizukiError("parse_error", `${where}: invalid timestamp`);
}

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

// Control characters, which a terminal would act on rather than print.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * A file name taken from captured text may be joined onto the export directory
 * only when it is a bare name that cannot escape it. `null` means the caller
 * must not touch the filesystem with it.
 */
export function safeFilename(name: string): string | null {
  if (name.length === 0 || name.length > 255) return null;
  if (name === "." || name === "..") return null;
  if (name.includes("/") || name.includes("\\")) return null;
  if (basename(name) !== name) return null;
  // A leading dash reads as an option to anything that shells out later.
  if (name.startsWith("-")) return null;
  if (CONTROL_CHARACTERS.test(name)) return null;
  return name;
}

// Direction overrides let a display name render as something other than what
// it stores; a subject id has to be what it looks like.
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function subjectSlug(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(BIDI_CONTROLS, "")
    .trim()
    .toLowerCase();
  const slug = cleaned
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
  return slug.length > 0 ? slug : "unknown";
}

/**
 * Config is host-authored, but a typo must not silently become a default: an
 * unrecognized key fails construction rather than quietly changing behavior.
 */
export function requireKnownKeys(
  config: unknown,
  connectorId: string,
  allowed: readonly string[],
): void {
  if (!isPlainObject(config)) return;
  for (const key of Object.keys(config)) {
    if (!allowed.includes(key)) {
      throw new KizukiError(
        "misconfigured",
        `${connectorId}: unknown config key ${key}`,
      );
    }
  }
}

const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  pdf: "application/pdf",
  vcf: "text/vcard",
  txt: "text/plain",
  html: "text/html",
  md: "text/markdown",
});

/** Declared from the name alone: importers never read media bytes to sniff. */
export function mediaTypeFor(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const extension = dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
  return MEDIA_TYPES[extension] ?? "application/octet-stream";
}

/** Least to most sensitive; the order the floor and a hint are compared in. */
const SENSITIVITY_ORDER: readonly SensitivityHint[] = [
  "public",
  "personal",
  "private",
];

export interface SensitivityPolicy {
  default_sensitivity: SensitivityHint;
  sensitivity_floor: SensitivityHint;
}

/**
 * The label a record carries, decided by the connector rather than asked of
 * the owner. A source's own hint is honored only upward: a claim below the
 * floor is raised to it instead of believed. Anything the policy cannot
 * place — no hint, or a value that is not a label — falls to the default, and
 * a source with no default at all is `private`, because a record whose
 * sensitivity is unknown must not be served more widely than one that said.
 */
export function resolveSensitivity(
  policy: Partial<SensitivityPolicy>,
  hint?: unknown,
): SensitivityHint {
  const floor = policy.sensitivity_floor ?? "private";
  const claimed = SENSITIVITY_ORDER.find((value) => value === hint);
  if (claimed === undefined) return policy.default_sensitivity ?? "private";
  return SENSITIVITY_ORDER.indexOf(claimed) < SENSITIVITY_ORDER.indexOf(floor)
    ? floor
    : claimed;
}
