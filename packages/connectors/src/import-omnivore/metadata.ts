import { EVENT_LIMITS, isPlainObject, isRfc3339 } from "@kizuki/core";
import { KizukiError } from "../errors";
import { MAX_RECORDS, MAX_RECORD_BYTES, parseJsonArray } from "../util";

export interface OmnivoreItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  url: string;
  state: string;
  labels: string[];
  saved_at: string;
  published_at: string | null;
}

/**
 * Every captured field is bounded on its own: an export is hostile input, and
 * a title alone must not be able to spend the whole record budget. The
 * position is named, never the value.
 */
export function bounded(text: string, where: string): string {
  if (Buffer.byteLength(text, "utf8") > MAX_RECORD_BYTES) {
    throw new KizukiError(
      "parse_error",
      `${where}: exceeds ${MAX_RECORD_BYTES} bytes`,
    );
  }
  return text;
}

function stringOr(value: unknown, fallback: string, where: string): string {
  return bounded(typeof value === "string" ? value : fallback, where);
}

/**
 * Labels are bounded as one field, while they are being collected: count,
 * per-name bytes, and total bytes. Bounding each name on its own left the
 * list itself unbounded, so an export could spend several times the record
 * budget on labels no single one of which was too long.
 */
function labelsOf(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  let bytes = 0;
  for (const label of value) {
    const name =
      typeof label === "string"
        ? label
        : isPlainObject(label) && typeof label["name"] === "string"
          ? label["name"]
          : "";
    if (name.length === 0) continue;
    const size = Buffer.byteLength(name, "utf8");
    if (size > EVENT_LIMITS.metadataStringBytes) {
      throw new KizukiError(
        "parse_error",
        `${where}: exceeds ${EVENT_LIMITS.metadataStringBytes} bytes`,
      );
    }
    if (labels.length >= EVENT_LIMITS.metadataArrayLength) {
      throw new KizukiError(
        "parse_error",
        `${where}: more than ${EVENT_LIMITS.metadataArrayLength} labels`,
      );
    }
    bytes += size;
    if (bytes > MAX_RECORD_BYTES) {
      throw new KizukiError(
        "parse_error",
        `${where}: exceeds ${MAX_RECORD_BYTES} bytes`,
      );
    }
    labels.push(name);
  }
  return labels;
}

/**
 * `Date.parse` accepts rolled calendar dates and timezone-less strings.
 * Ingress timestamps have to be real RFC3339 so `occurred_at` is the instant
 * the export wrote, not a host-local guess.
 */
function requiredTimestamp(value: unknown, where: string): string {
  if (typeof value === "string" && isRfc3339(value)) {
    const normalized = new Date(value).toISOString();
    if (isRfc3339(normalized)) return normalized;
  }
  throw new KizukiError("parse_error", `${where}: invalid timestamp`);
}

function optionalTimestamp(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  try {
    return requiredTimestamp(value, where);
  } catch {
    // A publication date the source could not state is absent, not fatal.
    return null;
  }
}

export function parseOmnivoreMetadata(
  text: string,
  where: string,
): OmnivoreItem[] {
  const raw = parseJsonArray(text, where);
  if (raw.length > MAX_RECORDS) {
    throw new KizukiError(
      "parse_error",
      `${where}: more than ${MAX_RECORDS} items`,
    );
  }
  const items: OmnivoreItem[] = [];
  raw.forEach((element, index) => {
    if (!isPlainObject(element)) return;
    const at = `${where}[${index}]`;
    const id = element["id"];
    const slug = element["slug"];
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      typeof slug !== "string" ||
      slug.length === 0
    ) {
      throw new KizukiError("parse_error", `${at}: id and slug are required`);
    }
    items.push({
      id: bounded(id, `${at}.id`),
      slug: bounded(slug, `${at}.slug`),
      title: stringOr(element["title"], "", `${at}.title`),
      description: stringOr(element["description"], "", `${at}.description`),
      author: stringOr(element["author"], "", `${at}.author`),
      url: stringOr(element["url"], "", `${at}.url`),
      state: stringOr(element["state"], "", `${at}.state`),
      labels: labelsOf(element["labels"], `${at}.labels`),
      saved_at: requiredTimestamp(element["savedAt"], `${at}.savedAt`),
      published_at: optionalTimestamp(
        element["publishedAt"],
        `${at}.publishedAt`,
      ),
    });
  });
  return items;
}
