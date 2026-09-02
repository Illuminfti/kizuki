import { lstat, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { HealthReport, isPlainObject } from "@kizuki/core";
import { KizukiError } from "./errors";

export function requirePathConfig(config: unknown, connectorId: string): string {
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

export async function readUtf8(path: string, connectorId: string): Promise<string> {
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

/**
 * Reads an export file the way the importers need it: size-checked before a
 * byte is read, never through a symlink, strictly UTF-8, newline-normalized.
 */
export async function readBoundedUtf8(
  path: string,
  connectorId: string,
  maxBytes = MAX_EXPORT_BYTES,
): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: cannot read ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!info.isFile()) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: not a regular file: ${path}`,
    );
  }
  if (info.size > maxBytes) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: ${path} exceeds the ${maxBytes} byte import limit`,
    );
  }
  const bytes = await readFile(path);
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
  return withoutBom.replace(/\r\n?/g, "\n");
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
  config: Record<string, unknown>,
  connectorId: string,
  allowed: readonly string[],
): void {
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
