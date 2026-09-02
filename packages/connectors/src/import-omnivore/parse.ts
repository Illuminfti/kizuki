import { join } from "node:path";
import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isPlainObject } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import { KizukiError } from "../errors";
import {
  MAX_EXPORT_BYTES,
  MAX_RECORDS,
  MAX_RECORD_BYTES,
  compareStrings,
  errorMessage,
  isoToRfc3339,
  parseJsonArray,
  readBoundedUtf8File,
  statRegularFile,
} from "../util";

export const OMNIVORE_IMPORT_CONNECTOR_ID = "kizuki.import-omnivore" as const;

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

/** What the parser needs, so it runs from memory or from disk unchanged. */
export interface OmnivoreFiles {
  metadata: { name: string; text: string }[];
  highlight(slug: string): Promise<string | null>;
  content(slug: string): Promise<{ byte_size: number } | null>;
}

const METADATA_FILE = /^metadata_\d+_to_\d+\.json$/;

// A slug is captured text. Unless it is this shape it never reaches the
// filesystem, so no export can name a path outside its own folders.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function misconfigured(detail: string): KizukiError {
  return new KizukiError(
    "misconfigured",
    `${OMNIVORE_IMPORT_CONNECTOR_ID}: ${detail}`,
  );
}

/**
 * Every captured field is bounded on its own: an export is hostile input, and
 * a title alone must not be able to spend the whole record budget. The
 * position is named, never the value.
 */
function bounded(text: string, where: string): string {
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

/**
 * A slug is derived from an item title, so neither it nor a path built from
 * it may appear in a refusal. Only the reason travels out of the lookup; the
 * caller adds the item position, which is what §0.6 allows a message to name.
 */
function highlightsRefusal(error: unknown): KizukiError {
  const invalidEncoding =
    error instanceof KizukiError && error.code === "parse_error";
  return new KizukiError(
    invalidEncoding ? "parse_error" : "misconfigured",
    invalidEncoding
      ? "highlights file is not valid UTF-8"
      : "highlights file could not be read",
    { cause: error },
  );
}

async function highlightsOf(
  files: OmnivoreFiles,
  slug: string,
  at: string,
): Promise<string> {
  try {
    return (await files.highlight(slug))?.trimEnd() ?? "";
  } catch (error) {
    if (!(error instanceof KizukiError)) throw error;
    throw new KizukiError(
      error.code,
      `${OMNIVORE_IMPORT_CONNECTOR_ID}: ${at}: ${error.message}`,
      { cause: error },
    );
  }
}

/**
 * A doubled export must not collapse two entries into one record, so the
 * second and later entries carrying one provider id are numbered in export
 * order. An id that already ends in the suffix a repeat would take keeps its
 * own identity: the number moves on rather than renaming a record that exists.
 */
function omnivoreRecordIds(ids: readonly string[]): string[] {
  const taken = new Set(ids);
  const seen = new Map<string, number>();
  return ids.map((id) => {
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    if (count === 1) return id;
    let suffix = count;
    while (taken.has(`${id}#${suffix}`)) suffix += 1;
    const numbered = `${id}#${suffix}`;
    taken.add(numbered);
    return numbered;
  });
}

/**
 * Highlights are shared: every item naming one slug carries that file's text.
 * The metadata budget therefore does not bound what the batch weighs, so the
 * assembled records are counted on their own before any of them is returned.
 */
export async function omnivoreEvents(
  files: OmnivoreFiles,
  observed_at: string,
  maxBytes = MAX_EXPORT_BYTES,
): Promise<CaptureEventInput[]> {
  const items: { item: OmnivoreItem; at: string }[] = [];
  for (const file of files.metadata) {
    parseOmnivoreMetadata(file.text, file.name).forEach((item, index) => {
      items.push({ item, at: `${file.name} item ${index + 1}` });
    });
  }
  if (items.length > MAX_RECORDS) {
    throw new KizukiError(
      "parse_error",
      `export holds more than ${MAX_RECORDS} items`,
    );
  }

  const ids = omnivoreRecordIds(items.map(({ item }) => item.id));
  const events: CaptureEventInput[] = [];
  let textLeft = maxBytes;
  for (const [index, { item, at }] of items.entries()) {
    const highlights = await highlightsOf(files, item.slug, at);
    const content = await files.content(item.slug);
    // Each field is bounded on its own, so the assembled record is bounded
    // too — but a record is what the ledger stores, so it is checked as one.
    const text = bounded(
      [item.title, item.url, item.description, highlights]
        .filter((part) => part.length > 0)
        .join("\n\n"),
      at,
    );
    textLeft -= Buffer.byteLength(text, "utf8");
    if (textLeft < 0) {
      throw new KizukiError(
        "parse_error",
        `export holds more than ${maxBytes} bytes of item text`,
      );
    }
    events.push({
      schema: "kizuki.event/v1",
      connector_id: OMNIVORE_IMPORT_CONNECTOR_ID,
      source_record_id: ids[index] ?? item.id,
      kind: "bookmark",
      occurred_at: item.saved_at,
      observed_at,
      text,
      subjects: [{ subject_id: "omnivore:self", role: "from" }],
      sensitivity_hint: "personal",
      deleted: false,
      attachments:
        content === null
          ? []
          : [
              {
                attachment_id: "content",
                media_type: "text/html",
                filename: `content/${item.slug}.html`,
                byte_size: content.byte_size,
              },
            ],
      metadata: {
        title: item.title,
        url: item.url,
        author: item.author,
        state: item.state,
        labels: item.labels,
        published_at: item.published_at,
        has_highlights: highlights.length > 0,
        // Hashed for the same reason the WhatsApp media size is: the
        // attachment itself is not, so an export whose content folder was
        // missing would otherwise stay content-less on every later import.
        content_bytes: content === null ? null : content.byte_size,
      },
    });
  }
  return events;
}

export async function fsOmnivoreFiles(
  dir: string,
  maxBytes = MAX_EXPORT_BYTES,
): Promise<OmnivoreFiles> {
  if (dir.toLowerCase().endsWith(".zip")) {
    throw misconfigured(`unzip the export first: ${dir}`);
  }
  let info;
  try {
    info = await lstat(dir);
  } catch (error) {
    throw misconfigured(`cannot access ${dir}: ${errorMessage(error)}`);
  }
  if (!info.isDirectory()) {
    throw misconfigured(`not an export directory: ${dir}`);
  }
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A directory that cannot be listed is a configuration problem like any
    // other unreadable path, not an error only the filesystem understands.
    throw misconfigured(`cannot read ${dir}: ${errorMessage(error)}`);
  }
  const names = entries
    .filter((entry) => entry.isFile() && METADATA_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareStrings);
  if (names.length === 0) {
    throw misconfigured(`no metadata_*.json in ${dir}`);
  }
  // A directory entry carries its own type, so a symlink reads as a symlink
  // here and never as the directory it points at: an export whose
  // `highlights` is a link elsewhere has no highlights rather than a route
  // out of the export folder.
  const realDirectory = (name: string): string | null =>
    entries.some((entry) => entry.name === name && entry.isDirectory())
      ? join(dir, name)
      : null;
  const highlightsDir = realDirectory("highlights");
  const contentDir = realDirectory("content");

  const metadata = [];
  // One budget for the whole export: a per-file limit would let a folder of
  // maximal metadata files spend it once per file.
  let bytesLeft = maxBytes;
  for (const name of names) {
    const file = await readBoundedUtf8File(
      join(dir, name),
      OMNIVORE_IMPORT_CONNECTOR_ID,
      bytesLeft,
    );
    bytesLeft -= file.byte_size;
    metadata.push({ name, text: file.text });
  }
  // Many items may name one slug, and each of them would otherwise re-read
  // and re-charge the same file. A file is read once, costs the export budget
  // once, and every later item is served the text already in hand.
  const highlights = new Map<string, string | null>();
  const contents = new Map<string, { byte_size: number } | null>();

  return {
    metadata,
    highlight: async (slug) => {
      if (highlightsDir === null || !SLUG.test(slug)) return null;
      const cached = highlights.get(slug);
      if (cached !== undefined) return cached;
      const file = join(highlightsDir, `${slug}.md`);
      // Absence, a symlink and a directory are honestly "no highlights". A
      // file that is there but unreadable, oversize or not UTF-8 is a
      // refusal instead: an item stored without the owner's notes would be
      // indistinguishable from an item that never had any.
      const found = await statRegularFile(file);
      if (found === null) {
        highlights.set(slug, null);
        return null;
      }
      // Highlights come out of the same export as the metadata and are
      // charged to the same budget, so no number of items can spend it twice.
      const limit = Math.min(MAX_RECORD_BYTES, bytesLeft);
      if (found.byte_size > limit) {
        throw new KizukiError(
          "misconfigured",
          `highlights file exceeds the ${limit} byte import limit`,
        );
      }
      let read;
      try {
        read = await readBoundedUtf8File(
          file,
          OMNIVORE_IMPORT_CONNECTOR_ID,
          limit,
        );
      } catch (error) {
        throw highlightsRefusal(error);
      }
      bytesLeft -= read.byte_size;
      highlights.set(slug, read.text);
      return read.text;
    },
    content: async (slug) => {
      if (contentDir === null || !SLUG.test(slug)) return null;
      const cached = contents.get(slug);
      if (cached !== undefined) return cached;
      const found = await statRegularFile(join(contentDir, `${slug}.html`));
      contents.set(slug, found);
      return found;
    },
  };
}

export function mapOmnivoreFiles(
  files: Readonly<Record<string, string>>,
): OmnivoreFiles {
  return {
    metadata: Object.keys(files)
      .filter((name) => METADATA_FILE.test(name))
      .sort(compareStrings)
      .map((name) => ({ name, text: files[name] ?? "" })),
    highlight: async (slug) =>
      SLUG.test(slug) ? (files[`highlights/${slug}.md`] ?? null) : null,
    content: async (slug) => {
      if (!SLUG.test(slug)) return null;
      const html = files[`content/${slug}.html`];
      return html === undefined
        ? null
        : { byte_size: Buffer.byteLength(html, "utf8") };
    },
  };
}
