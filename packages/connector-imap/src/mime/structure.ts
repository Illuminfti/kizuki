import { tokenText } from "../imap/tokenizer";
import type { Token } from "../imap/tokenizer";
import { MAX_MIME_DEPTH, MAX_MIME_PARTS } from "./parse";
import type { ContentDisposition, ContentType } from "./parse";

/**
 * One leaf of a `BODYSTRUCTURE` reply. A message too large to fetch in full
 * still has to yield its attachment references, and this is the only view of
 * its parts a header-only capture gets.
 */
export interface StructurePart {
  path: string;
  contentType: ContentType;
  disposition: ContentDisposition | null;
}

function pairs(token: Token | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (token?.kind !== "list") return out;
  for (let index = 0; index + 1 < token.items.length; index += 2) {
    const key = tokenText(token.items[index]).toLowerCase();
    if (key.length > 0) out[key] = tokenText(token.items[index + 1]);
  }
  return out;
}

function dispositionOf(token: Token | undefined): ContentDisposition | null {
  if (token?.kind !== "list") return null;
  const type = tokenText(token.items[0]).toLowerCase();
  if (type.length === 0) return null;
  return { type, params: pairs(token.items[1]) };
}

/**
 * RFC 3501 section 7.4.2 fixes where the disposition sits, and it sits after a
 * different number of fields for each shape of part. A server that stops short
 * of the extension data simply has none, and the `name` parameter still names
 * the attachment.
 */
function singlePartDisposition(items: Token[]): ContentDisposition | null {
  const type = tokenText(items[0]).toLowerCase();
  const subtype = tokenText(items[1]).toLowerCase();
  const index =
    type === "message" && subtype === "rfc822"
      ? 11
      : type === "text"
        ? 9
        : 8;
  return dispositionOf(items[index]);
}

function childPath(path: string, index: number): string {
  return path.length === 0 ? String(index) : `${path}.${index}`;
}

function walk(
  token: Token,
  path: string,
  depth: number,
  into: StructurePart[],
): void {
  if (token.kind !== "list") return;
  if (depth > MAX_MIME_DEPTH || into.length >= MAX_MIME_PARTS) return;
  const items = token.items;
  if (items[0]?.kind === "list") {
    let count = 0;
    while (items[count]?.kind === "list") count += 1;
    for (let child = 0; child < count; child += 1) {
      const item = items[child];
      if (item === undefined) continue;
      walk(item, childPath(path, child + 1), depth + 1, into);
    }
    return;
  }
  const type = tokenText(items[0]).toLowerCase();
  const subtype = tokenText(items[1]).toLowerCase();
  // An enclosed message is a leaf here for the same reason it is one in the
  // full parse: it is captured as an attachment, never recursed into.
  into.push({
    // A single-part message is section 1 in IMAP terms, not the empty path.
    path: path.length === 0 ? "1" : path,
    contentType: { type, subtype, params: pairs(items[2]) },
    disposition: singlePartDisposition(items),
  });
}

export function structureParts(token: Token): StructurePart[] {
  const parts: StructurePart[] = [];
  walk(token, "", 0, parts);
  return parts;
}
