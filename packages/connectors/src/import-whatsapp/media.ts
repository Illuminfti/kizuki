import { join } from "node:path";
import { statRegularFile } from "../read";
import { safeFilename } from "../util";

/**
 * Media in a chat export is a line of text plus, for a "with media" export,
 * a file beside the chat. The importer references it and never opens it.
 */

export type MediaLookup = (
  filename: string,
) => Promise<{ byte_size: number } | null>;

export interface MediaRef {
  kind: "file" | "omitted";
  filename: string | null;
}

// Matched by shape, not by phrase: the parenthetical and the angle-bracket
// wording are localized, and there is no list of the translations.
const IOS_ATTACHED = /^<[^<>:]{1,40}:\s*([^\s<>/\\]+\.[A-Za-z0-9]{1,5})>$/;
const ANDROID_ATTACHED = /^([^\s<>/\\]+\.[A-Za-z0-9]{1,5})\s\([^()]{1,40}\)$/;
const OMITTED_BRACKETED = /^<[^<>]{1,40}>$/;
const OMITTED_SUFFIXED = /^\S{1,20} omitted$/;

const LEADING_MARKS = /^[\u200e\u200f]+/;

export function detectMedia(text: string): MediaRef | null {
  const first = (text.split("\n")[0] ?? "").replace(LEADING_MARKS, "").trim();
  const attached = IOS_ATTACHED.exec(first) ?? ANDROID_ATTACHED.exec(first);
  if (attached !== null) {
    return { kind: "file", filename: attached[1] ?? null };
  }
  if (OMITTED_BRACKETED.test(first) || OMITTED_SUFFIXED.test(first)) {
    return { kind: "omitted", filename: null };
  }
  return null;
}

/** Sizes a file beside the chat, and only ever a bare name beside the chat. */
export function fsMediaLookup(mediaDir: string): MediaLookup {
  return async (filename) => {
    const safe = safeFilename(filename);
    if (safe === null) return null;
    return statRegularFile(join(mediaDir, safe));
  };
}

/** The in-memory equivalent, for fixtures and tests: no filesystem at all. */
export function mapMediaLookup(
  files: Readonly<Record<string, string>>,
): MediaLookup {
  return async (filename) => {
    const content = files[filename];
    return content === undefined
      ? null
      : { byte_size: Buffer.byteLength(content, "utf8") };
  };
}
