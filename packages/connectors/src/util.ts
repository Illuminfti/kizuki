import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { HealthReport, isPlainObject } from "@kizuki/core";
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

/**
 * Snapshot importers read whole export files the owner unzipped by hand. The
 * bounds below are the only thing between a hostile export and unbounded
 * allocation, so every parser in this package applies them.
 */
export const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
export const MAX_RECORDS = 1_000_000;
export const MAX_RECORD_BYTES = 1024 * 1024;
/** Nesting a hostile export can use to blow the stack during JSON.parse. */
export const MAX_JSON_DEPTH = 64;

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Walks the bytes for structural nesting without building a graph. Strings
 * are skipped so a payload full of braces cannot fake depth.
 */
export function jsonNestingDepth(source: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      if (depth > max) max = depth;
      continue;
    }
    if (char === "}" || char === "]") {
      if (depth > 0) depth -= 1;
    }
  }
  return max;
}

export function parseJsonArray(
  source: string,
  label: string,
  maxRecords = MAX_RECORDS,
): unknown[] {
  if (jsonNestingDepth(source) > MAX_JSON_DEPTH) {
    throw new KizukiError(
      "parse_error",
      `${label}: JSON nesting exceeds ${MAX_JSON_DEPTH}`,
    );
  }
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
  if (parsed.length > maxRecords) {
    throw new KizukiError(
      "parse_error",
      `${label}: export holds more than ${maxRecords} records`,
    );
  }
  return parsed;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Fixed so a fixture hashes identically on every run and every machine. */
export const FIXTURE_OBSERVED_AT = "2026-01-01T00:00:00.000Z";

// Well past any plausible export, and short of the magnitudes where seconds
// and milliseconds stop being distinguishable.
const MAX_UNIX_SECONDS = 2 ** 40;

export function unixSecondsToIso(value: unknown, where: string): string {
  const seconds =
    typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : typeof value === "number" && Number.isFinite(value)
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

/**
 * A display name with only what a reader cannot see taken out: composition
 * differences and direction marks. Two names that render the same are one
 * subject; anything a reader can tell apart stays apart, because merging two
 * participants is worse than filing one person twice.
 */
export function subjectName(name: string): string {
  return name.normalize("NFC").replace(BIDI_CONTROLS, "").trim();
}

export function subjectSlug(name: string): string {
  const slug = subjectName(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
  return slug.length > 0 ? slug : "unknown";
}

/**
 * Record ids for a list that may repeat one of them. The first entry keeps the
 * plain id and every repeat is numbered, so a doubled export cannot collapse
 * two records into one. An id that already ends in the suffix a repeat would
 * take keeps its own identity: the number moves on rather than renaming a
 * record that exists.
 */
export function numberRepeats(ids: readonly string[]): string[] {
  const taken = new Set(ids);
  const seen = new Map<string, number>();
  // Where the next repeat of an id starts looking. Nothing ever leaves
  // `taken`, so a suffix proven taken stays taken and the search resumes
  // instead of walking the same run again: an export of one id and its own
  // numbered run would otherwise cost a pass per repeat.
  const resume = new Map<string, number>();
  return ids.map((id) => {
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    if (count === 1) return id;
    let suffix = Math.max(count, resume.get(id) ?? 0);
    while (taken.has(`${id}#${suffix}`)) suffix += 1;
    const numbered = `${id}#${suffix}`;
    resume.set(id, suffix + 1);
    taken.add(numbered);
    return numbered;
  });
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
