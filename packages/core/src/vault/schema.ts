import { CLAIMS_SCHEMA_VERSION } from "../claims/schema";
import { isNonEmptyString } from "../util/validate";
import type { ValidationResult } from "../util/validate";

/** RFC 0002 §18.1 — claims-core. Re-exported so vault schema tracks the durable version. */
export { CLAIMS_SCHEMA_VERSION };

export const PAGE_TYPES = [
  "person",
  "org",
  "project",
  "place",
  "topic",
  "event",
  "fact",
  "source",
  "rollup",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const PAGE_SENSITIVITIES = ["public", "personal", "private"] as const;
export type PageSensitivity = (typeof PAGE_SENSITIVITIES)[number];

export const PAGE_STATUSES = ["draft", "active", "archived"] as const;
export type PageStatus = (typeof PAGE_STATUSES)[number];

/** RFC 0002 §10.5: set by the writer; `quoted` means the body carries capture. */
export const PAGE_TAINTS = ["clean", "quoted"] as const;
export type PageTaint = (typeof PAGE_TAINTS)[number];

/** Closed identity and policy keys, in canonical serialization order. */
export const CANONICAL_FRONTMATTER_KEYS = [
  "id",
  "title",
  "type",
  "status",
  "sensitivity",
  "taint",
  "sources",
  "subjects",
] as const;

export const MAX_FRONTMATTER_STRING_CHARS = 4_096;
/** Matches the retrieval neighbor cap: a legal page can cite as many sources as a walk can return. */
export const MAX_FRONTMATTER_ARRAY_ITEMS = 100;

const REQUIRED_KEYS = [
  "id",
  "title",
  "type",
  "status",
  "sensitivity",
  "taint",
] as const;
const KNOWN_KEYS = new Set<string>(CANONICAL_FRONTMATTER_KEYS);
const FORBIDDEN_KEY_PARTS = ["__proto__", "prototype", "constructor"];

function hasOwn(data: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(data, key);
}

function validateEnum(
  data: Record<string, unknown>,
  key: string,
  values: readonly string[],
  errors: string[],
): void {
  if (!hasOwn(data, key)) return;
  const value = data[key];
  if (typeof value !== "string" || !values.includes(value)) {
    errors.push(`${key}: must be one of ${values.join(" | ")}`);
  }
}

function keyLooksHostile(key: string): boolean {
  const parts = key.toLowerCase().split(/[-_.]/);
  return FORBIDDEN_KEY_PARTS.some((part) => parts.includes(part));
}

/**
 * Frontmatter values are scalars or a flat string array. Nested objects,
 * nested arrays, and prototype-shaped keys are refused at every depth.
 */
export function validateFrontmatterValue(value: unknown, key: string): string[] {
  const errors: string[] = [];
  if (typeof value === "string") {
    if (value.length > MAX_FRONTMATTER_STRING_CHARS) {
      errors.push(`${key}: exceeds ${MAX_FRONTMATTER_STRING_CHARS} characters`);
    }
    return errors;
  }
  if (typeof value === "boolean") return errors;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${key}: must be a finite number`);
    return errors;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_FRONTMATTER_ARRAY_ITEMS) {
      errors.push(`${key}: exceeds ${MAX_FRONTMATTER_ARRAY_ITEMS} items`);
    }
    for (const [index, item] of value.entries()) {
      if (typeof item !== "string") {
        errors.push(`${key}[${index}]: arrays may contain only strings`);
      } else if (item.length > MAX_FRONTMATTER_STRING_CHARS) {
        errors.push(`${key}[${index}]: exceeds ${MAX_FRONTMATTER_STRING_CHARS} characters`);
      }
    }
    return errors;
  }
  errors.push(`${key}: must be a string, finite number, boolean, or string array`);
  return errors;
}

/**
 * Strict provenance shape for diagnostics. Keep the legacy writer/scanner
 * schema separate until owner-edit and purge postimages have complete support.
 */
export function parsePageSources(data: Record<string, unknown>): ValidationResult<string[]> {
  if (!hasOwn(data, "sources")) return { ok: false, errors: ["sources: is required"] };
  const sources = data["sources"];
  if (!Array.isArray(sources) || !sources.every((source): source is string => typeof source === "string")) {
    return { ok: false, errors: ["sources: must be a string array"] };
  }
  const errors = validateFrontmatterValue(sources, "sources");
  if (sources.length === 0 && data["status"] !== "archived") {
    errors.push("sources: must name at least one event unless archived");
  }
  if (sources.some((source) => source.trim().length === 0)) {
    errors.push("sources: event IDs must be non-empty strings");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: sources };
}

export function validatePage(data: Record<string, unknown>): string[] {
  const errors: string[] = [];

  for (const key of REQUIRED_KEYS) {
    if (!hasOwn(data, key)) errors.push(`${key}: is required`);
  }

  for (const key of ["id", "title"] as const) {
    if (hasOwn(data, key) && !isNonEmptyString(data[key])) {
      errors.push(`${key}: must be a non-empty string`);
    }
  }

  validateEnum(data, "type", PAGE_TYPES, errors);
  validateEnum(data, "status", PAGE_STATUSES, errors);
  validateEnum(data, "sensitivity", PAGE_SENSITIVITIES, errors);
  validateEnum(data, "taint", PAGE_TAINTS, errors);

  if (hasOwn(data, "sources")) {
    const sources = data["sources"];
    if (!Array.isArray(sources) || !sources.every((source) => typeof source === "string")) {
      errors.push("sources: must be a string array");
    }
  }

  if (hasOwn(data, "subjects")) {
    const subjects = data["subjects"];
    if (!Array.isArray(subjects) || !subjects.every((subject) => typeof subject === "string")) {
      errors.push("subjects: must be a string array");
    }
  }

  for (const key of Object.keys(data)) {
    if (keyLooksHostile(key)) {
      errors.push(`${key}: unknown key; extensions must start with "x-"`);
      continue;
    }
    if (!KNOWN_KEYS.has(key) && !key.startsWith("x-")) {
      errors.push(`${key}: unknown key; extensions must start with "x-"`);
    }
    errors.push(...validateFrontmatterValue(data[key], key));
  }

  return errors;
}
