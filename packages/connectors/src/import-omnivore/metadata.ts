import { isPlainObject } from "@kizuki/core";
import { KizukiError } from "../errors";
import { MAX_RECORDS, MAX_RECORD_BYTES, isoToRfc3339, parseJsonArray } from "../util";

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

function labelsOf(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  value.forEach((label, index) => {
    const at = `${where}[${index}]`;
    if (typeof label === "string" && label.length > 0) {
      labels.push(bounded(label, at));
      return;
    }
    if (isPlainObject(label) && typeof label["name"] === "string") {
      const name = label["name"];
      if (name.length > 0) labels.push(bounded(name, `${at}.name`));
    }
  });
  return labels;
}

function optionalTimestamp(value: unknown, where: string): string | null {
  if (value === undefined || value === null) return null;
  try {
    return isoToRfc3339(value, where);
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
      saved_at: isoToRfc3339(element["savedAt"], `${at}.savedAt`),
      published_at: optionalTimestamp(
        element["publishedAt"],
        `${at}.publishedAt`,
      ),
    });
  });
  return items;
}
