import { isRfc3339 } from "@kizuki/core";
import type { FrontmatterValue } from "@kizuki/core/staging";

/**
 * Pure conversions shared by both migration importers. Every value that
 * reaches here came out of an export file, so nothing throws and nothing
 * allocates without a bound.
 */

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/g;
export const MAX_FRONTMATTER_STRING = 4096;
export const MAX_FRONTMATTER_ARRAY = 256;

/**
 * One display-safe line. Control characters become spaces rather than
 * vanishing, so two words separated by a newline do not weld together, and
 * an escape sequence cannot survive into a terminal or a report.
 */
export function sanitizeLine(value: string, max: number): string {
  const collapsed = value
    .replace(CONTROL_CHARACTER, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...collapsed].slice(0, max).join("");
}

/** A path segment `targetProblem` accepts, for any input at all. */
export function slug(value: string, max = 64): string {
  const flattened = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "")
    .replace(/^[^a-z0-9]+/, "");
  const truncated = [...flattened].slice(0, max).join("");
  return truncated.length === 0 ? "page" : truncated;
}

/**
 * A subject id in the connector's own namespace. Wiki link syntax and its
 * `|alias` display suffix are stripped first: `[[Ada|Ada L.]]` and `Ada` are
 * the same person, and an id that kept the brackets would never merge.
 */
export function subjectId(namespace: string, value: string): string | null {
  const unlinked = value.replace(/\[\[/g, "").replace(/\]\]/g, "");
  const pipe = unlinked.indexOf("|");
  const base = pipe === -1 ? unlinked : unlinked.slice(0, pipe);
  const local = sanitizeLine(base, 200).toLowerCase();
  return local.length === 0 ? null : `${namespace}:${local}`;
}

export type CoercedNote =
  "kept" | "array_stringified" | "json_stringified" | "truncated";

export type Coerced =
  | { ok: true; value: FrontmatterValue; note: CoercedNote }
  | { ok: false; reason: "null" | "empty_array" | "unrepresentable" };

function truncateString(value: string): { value: string; truncated: boolean } {
  const points = [...value];
  return points.length > MAX_FRONTMATTER_STRING
    ? {
        value: points.slice(0, MAX_FRONTMATTER_STRING).join(""),
        truncated: true,
      }
    : { value, truncated: false };
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function stringifyJson(raw: unknown): Coerced {
  let serialized: string;
  try {
    serialized = JSON.stringify(raw) ?? "";
  } catch {
    return { ok: false, reason: "unrepresentable" };
  }
  if (serialized.length === 0) return { ok: false, reason: "unrepresentable" };
  const { value, truncated } = truncateString(serialized);
  return {
    ok: true,
    value,
    note: truncated ? "truncated" : "json_stringified",
  };
}

function coerceArray(raw: unknown[]): Coerced {
  if (raw.length === 0) return { ok: false, reason: "empty_array" };
  if (!raw.every(isScalar)) return stringifyJson(raw);

  const stringified = raw.some((item) => typeof item !== "string");
  const bounded = raw.slice(0, MAX_FRONTMATTER_ARRAY);
  let truncated = bounded.length !== raw.length;
  const items = bounded.map((item) => {
    const cut = truncateString(String(item));
    if (cut.truncated) truncated = true;
    return cut.value;
  });
  return {
    ok: true,
    value: items,
    note: truncated ? "truncated" : stringified ? "array_stringified" : "kept",
  };
}

/** Everything a frontmatter value can become, and why it could not stay itself. */
export function toFrontmatterValue(raw: unknown): Coerced {
  if (raw === null || raw === undefined) return { ok: false, reason: "null" };
  if (typeof raw === "string") {
    const { value, truncated } = truncateString(raw);
    return { ok: true, value, note: truncated ? "truncated" : "kept" };
  }
  if (typeof raw === "boolean") return { ok: true, value: raw, note: "kept" };
  if (typeof raw === "number") {
    return Number.isFinite(raw)
      ? { ok: true, value: raw, note: "kept" }
      : { ok: false, reason: "unrepresentable" };
  }
  if (Array.isArray(raw)) return coerceArray(raw);
  if (
    typeof raw === "object" &&
    Object.getPrototypeOf(raw) === Object.prototype
  ) {
    return stringifyJson(raw);
  }
  return { ok: false, reason: "unrepresentable" };
}

export type TimestampFormat =
  | "rfc3339"
  | "sqlite_datetime"
  | "date"
  | "unix_seconds"
  | "unix_millis"
  | "js_date";

export const TIMESTAMP_FORMATS: readonly TimestampFormat[] = [
  "rfc3339",
  "sqlite_datetime",
  "date",
  "unix_seconds",
  "unix_millis",
  "js_date",
];

function fromEpoch(raw: unknown, millisPerUnit: number): string | null {
  const numeric =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  const date = new Date(numeric * millisPerUnit);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Null rather than a guess: an unreadable timestamp is a reported decision. */
export function parseLegacyTimestamp(
  raw: unknown,
  format: TimestampFormat,
): string | null {
  switch (format) {
    case "rfc3339":
      return isRfc3339(raw) ? raw : null;
    case "sqlite_datetime": {
      if (typeof raw !== "string") return null;
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return null;
      const candidate = `${raw.replace(" ", "T")}Z`;
      return isRfc3339(candidate) ? candidate : null;
    }
    case "date": {
      if (typeof raw !== "string") return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
      const candidate = `${raw}T00:00:00.000Z`;
      return isRfc3339(candidate) ? candidate : null;
    }
    case "unix_seconds":
      return fromEpoch(raw, 1000);
    case "unix_millis":
      return fromEpoch(raw, 1);
    case "js_date": {
      if (typeof raw !== "string" && typeof raw !== "number") return null;
      const date = new Date(raw);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }
}

function globSource(pattern: string): string {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index] as string;
    if (character === "*") {
      let stars = 0;
      while (pattern[index] === "*") {
        stars += 1;
        index += 1;
      }
      if (stars === 1) {
        source += "[^/]*";
        continue;
      }
      // `**/` spans whole segments including none of them, so a pattern
      // anchored at the root still matches a file sitting in the root.
      if (pattern[index] === "/") {
        source += "(?:.*/)?";
        index += 1;
      } else {
        source += ".*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return source;
}

/** Anchored `*` / `**` / `?` matching over forward-slash relative paths. */
export function matchesGlob(relpath: string, pattern: string): boolean {
  return new RegExp(`^${globSource(pattern)}$`).test(relpath);
}
