import { join } from "node:path";
import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { CaptureEventInput } from "@kizuki/core";
import { KizukiError } from "../errors";
import { readBoundedUtf8File, statRegularFile } from "../read";
import {
  MAX_EXPORT_BYTES,
  MAX_RECORDS,
  MAX_RECORD_BYTES,
  compareStrings,
  errorMessage,
  numberRepeats,
} from "../util";
import { bounded, parseOmnivoreMetadata } from "./metadata";
import type { OmnivoreItem } from "./metadata";

export const OMNIVORE_IMPORT_CONNECTOR_ID = "kizuki.import-omnivore" as const;

/** A reading list is about the owner, not a secret, and not public either. */
const OMNIVORE_SENSITIVITY = "personal" as const;

export { parseOmnivoreMetadata } from "./metadata";
export type { OmnivoreItem } from "./metadata";

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

/** A folder of the export, and the identity it had when the scan found it. */
interface ExportFolder {
  path: string;
  dev: number;
  ino: number;
}

/**
 * A listing is a snapshot: `highlights` can become a link to somewhere else
 * between the scan and the read, and `O_NOFOLLOW` refuses only the last
 * component of a path, not a parent that has since become a link. The folder's
 * identity is therefore checked in the moment it is used, and again after the
 * child was read, so a folder swapped underneath an import yields nothing
 * rather than a route out of the export.
 */
async function inside<T>(
  folder: ExportFolder,
  body: () => Promise<T>,
): Promise<T | null> {
  if (!(await unchanged(folder))) return null;
  const value = await body();
  return (await unchanged(folder)) ? value : null;
}

async function unchanged(folder: ExportFolder): Promise<boolean> {
  try {
    const info = await lstat(folder.path);
    return (
      info.isDirectory() &&
      info.dev === folder.dev &&
      info.ino === folder.ino
    );
  } catch {
    return false;
  }
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

  const ids = numberRepeats(items.map(({ item }) => item.id));
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
      sensitivity_hint: OMNIVORE_SENSITIVITY,
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
  const realDirectory = async (name: string): Promise<ExportFolder | null> => {
    if (!entries.some((entry) => entry.name === name && entry.isDirectory())) {
      return null;
    }
    const path = join(dir, name);
    const info = await lstat(path).catch(() => null);
    return info !== null && info.isDirectory()
      ? { path, dev: info.dev, ino: info.ino }
      : null;
  };
  const highlightsDir = await realDirectory("highlights");
  const contentDir = await realDirectory("content");

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
      const text = await inside(highlightsDir, async () => {
        const file = join(highlightsDir.path, `${slug}.md`);
        // Absence, a symlink and a directory are honestly "no highlights". A
        // file that is there but unreadable, oversize or not UTF-8 is a
        // refusal instead: an item stored without the owner's notes would be
        // indistinguishable from an item that never had any.
        const found = await statRegularFile(file);
        if (found === null) return null;
        // Highlights come out of the same export as the metadata and are
        // charged to the same budget, so no number of items can spend it
        // twice.
        const limit = Math.min(MAX_RECORD_BYTES, bytesLeft);
        if (found.byte_size > limit) {
          throw new KizukiError(
            "misconfigured",
            `highlights file exceeds the ${limit} byte import limit`,
          );
        }
        try {
          return await readBoundedUtf8File(
            file,
            OMNIVORE_IMPORT_CONNECTOR_ID,
            limit,
          );
        } catch (error) {
          throw highlightsRefusal(error);
        }
      });
      if (text === null || text === undefined) {
        highlights.set(slug, null);
        return null;
      }
      bytesLeft -= text.byte_size;
      highlights.set(slug, text.text);
      return text.text;
    },
    content: async (slug) => {
      if (contentDir === null || !SLUG.test(slug)) return null;
      const cached = contents.get(slug);
      if (cached !== undefined) return cached;
      const found =
        (await inside(contentDir, () =>
          statRegularFile(join(contentDir.path, `${slug}.html`)),
        )) ?? null;
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
