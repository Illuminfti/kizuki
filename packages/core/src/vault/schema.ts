import { isNonEmptyString } from "../util/validate";

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

const REQUIRED_KEYS = ["id", "title", "type", "status", "sensitivity"] as const;
const KNOWN_KEYS = new Set<string>([...REQUIRED_KEYS, "sources"]);

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

  if (hasOwn(data, "sources")) {
    const sources = data["sources"];
    if (!Array.isArray(sources) || !sources.every((source) => typeof source === "string")) {
      errors.push("sources: must be a string array");
    }
  }

  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key) && !key.startsWith("x-")) {
      errors.push(`${key}: unknown key; extensions must start with "x-"`);
    }
  }

  return errors;
}
