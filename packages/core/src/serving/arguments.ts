import { compareRfc3339 } from "../agents/time";
import type { Grant } from "../agents";
import { isRfc3339 } from "../util/time";
import { ServeError } from "./types";

/**
 * Same shape as the audit layer's short-id rule, so audited id arrays stay
 * readable instead of collapsing into hashes.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const PATH_SEGMENT = /^[^\u0000-\u001F\u007F\\]+$/;
const MAX_PATH_CHARS = 256;

function refuse(field: string, rule: string): ServeError {
  return new ServeError(
    "invalid_arguments",
    `invalid arguments: ${field}: ${rule}`,
  );
}

export function identifier(field: string, value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw refuse(field, "must be an identifier of at most 64 characters");
  }
  return value;
}

export function text(field: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw refuse(field, "must be a string");
  if (FORBIDDEN_TEXT.test(value)) {
    throw refuse(field, "must not contain control characters");
  }
  if (value.trim().length === 0) throw refuse(field, "must not be blank");
  if (Array.from(value).length > max) {
    throw refuse(field, `must be at most ${max} characters`);
  }
  return value;
}

export function range(
  field: string,
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw refuse(field, "must be an integer");
  }
  if (value < min || value > max) {
    throw refuse(field, `must be between ${min} and ${max}`);
  }
  return value;
}

export function limit(
  field: string,
  value: unknown,
  max: number,
  fallback: number,
): number {
  return range(field, value, 1, max, fallback);
}

export function idList(field: string, value: unknown, max: number): string[] {
  if (!Array.isArray(value)) throw refuse(field, "must be an array");
  if (value.length > max) {
    throw refuse(field, `must hold at most ${max} entries`);
  }
  const entries = value.map((entry) => identifier(field, entry));
  if (new Set(entries).size !== entries.length) {
    throw refuse(field, "must not repeat an entry");
  }
  return entries;
}

export function rfc3339(field: string, value: unknown): string {
  if (!isRfc3339(value)) throw refuse(field, "must be an RFC3339 timestamp");
  return value;
}

export function day(field: string, value: unknown): string {
  if (typeof value !== "string" || !DAY.test(value)) {
    throw refuse(field, "must be a YYYY-MM-DD calendar day");
  }
  return value;
}

/**
 * The value is only ever compared against `relPath` values produced by the
 * vault walk; nothing joins it onto the filesystem. The rules still refuse
 * traversal so a caller cannot probe outside the vault by trial and error.
 */
export function relPath(field: string, value: unknown): string {
  if (typeof value !== "string") throw refuse(field, "must be a string");
  if (value.length > MAX_PATH_CHARS) {
    throw refuse(field, `must be at most ${MAX_PATH_CHARS} characters`);
  }
  if (!value.endsWith(".md") || value.length === 3) {
    throw refuse(field, "must name a Markdown page");
  }
  if (value.startsWith("/")) throw refuse(field, "must be vault-relative");
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw refuse(field, "must not contain a relative segment");
    }
    if (!PATH_SEGMENT.test(segment)) {
      throw refuse(field, "must use forward slashes and printable characters");
    }
  }
  return value;
}

export function enumOf<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw refuse(field, `must be one of ${allowed.join(" | ")}`);
  }
  return value as T;
}

function scoped(
  field: string,
  reason: "subject_out_of_scope" | "type_out_of_scope",
  allowed: string[] | null,
  requested: string[] | undefined,
): string[] | undefined {
  if (allowed === null) return requested;
  if (requested === undefined) return [...allowed];
  for (const entry of requested) {
    if (!allowed.includes(entry)) {
      throw new ServeError(reason, `${field} outside the grant`);
    }
  }
  return requested;
}

export function scopedSubjects(
  grant: Grant,
  requested: string[] | undefined,
): string[] | undefined {
  return scoped("subjects", "subject_out_of_scope", grant.subjects, requested);
}

export function scopedTypes(
  grant: Grant,
  requested: string[] | undefined,
): string[] | undefined {
  return scoped("types", "type_out_of_scope", grant.types, requested);
}

function later(left: string, right: string): string {
  return compareRfc3339(left, "since", right, "since") >= 0 ? left : right;
}

function earlier(left: string, right: string): string {
  return compareRfc3339(left, "until", right, "until") <= 0 ? left : right;
}

export function scopedWindow(
  grant: Grant,
  since: string | undefined,
  until: string | undefined,
): { since?: string; until?: string } {
  const start =
    grant.since === null
      ? since
      : since === undefined
        ? grant.since
        : later(grant.since, since);
  const end =
    grant.until === null
      ? until
      : until === undefined
        ? grant.until
        : earlier(grant.until, until);
  return {
    ...(start === undefined ? {} : { since: start }),
    ...(end === undefined ? {} : { until: end }),
  };
}
