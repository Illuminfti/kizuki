import { sanitizeLine } from "../legacy/coerce";
import {
  MAX_FRONTMATTER_DEPTH,
  MAX_FRONTMATTER_KEYS,
  Unparsable,
  blockHeader,
  indentOf,
  parseScalar,
  peek,
  readBlockScalar,
  refuseSpecial,
  stripComment,
} from "./yaml-subset";
import type { Reader } from "./yaml-subset";

/**
 * A bounded, tolerant reader for the YAML dialect a markdown wiki actually
 * emits. It is deliberately not a YAML implementation: anything outside the
 * documented subset is reported as `unparsed` with the rule that fired, which
 * the migration report has to say anyway. Hostile input must never throw, so
 * every refusal travels as a value.
 */

export interface LegacyFrontmatter {
  status: "parsed" | "absent" | "unparsed";
  data: Record<string, unknown>;
  /** Text after the closing fence; the whole file when there is no block. */
  body: string;
  /** Rules that fired, never field values. */
  problems: string[];
}

export const MAX_FRONTMATTER_BYTES = 64 * 1024;
export { MAX_FRONTMATTER_DEPTH, MAX_FRONTMATTER_KEYS } from "./yaml-subset";

const OPEN_FENCE = /^---[ \t]*(?:\r?\n|$)/;
const KEY = /^[^\s:#][^:]*$/;

function countKey(reader: Reader): void {
  reader.keys += 1;
  if (reader.keys > MAX_FRONTMATTER_KEYS) {
    throw new Unparsable(`more than ${MAX_FRONTMATTER_KEYS} keys`);
  }
}

function startsSequence(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

function parseMapping(
  reader: Reader,
  indent: number,
  depth: number,
): Record<string, unknown> {
  if (depth > MAX_FRONTMATTER_DEPTH) {
    throw new Unparsable(`nesting deeper than ${MAX_FRONTMATTER_DEPTH}`);
  }
  const data: Record<string, unknown> = {};
  for (;;) {
    const at = peek(reader);
    if (at === -1) break;
    const line = reader.lines[at] as string;
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) throw new Unparsable("unexpected indentation");
    const content = line.slice(lineIndent);
    if (startsSequence(content)) break;
    refuseSpecial(content);

    const separator = stripComment(content).indexOf(":");
    if (separator <= 0) throw new Unparsable("expected a key: value line");
    const key = content.slice(0, separator).trim();
    if (!KEY.test(key)) throw new Unparsable("unusable key");
    countKey(reader);
    reader.index = at + 1;

    const value = parseValue(
      reader,
      content.slice(separator + 1),
      indent,
      depth,
    );
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      reader.problems.push(
        `duplicate key ${JSON.stringify(sanitizeLine(key, 120))}`,
      );
      continue;
    }
    Object.defineProperty(data, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return data;
}

function parseSequence(
  reader: Reader,
  indent: number,
  depth: number,
): unknown[] {
  if (depth > MAX_FRONTMATTER_DEPTH) {
    throw new Unparsable(`nesting deeper than ${MAX_FRONTMATTER_DEPTH}`);
  }
  const items: unknown[] = [];
  for (;;) {
    const at = peek(reader);
    if (at === -1) break;
    const line = reader.lines[at] as string;
    const lineIndent = indentOf(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) throw new Unparsable("unexpected indentation");
    const content = line.slice(lineIndent);
    if (!startsSequence(content)) break;
    reader.index = at + 1;

    const rest = content === "-" ? "" : content.slice(2);
    const itemIndent = indent + 2;
    if (rest.trim().length === 0) {
      items.push(parseNested(reader, indent, depth));
      continue;
    }
    refuseSpecial(rest.trim());
    const separator = stripComment(rest).indexOf(":");
    if (separator > 0 && KEY.test(rest.slice(0, separator).trim())) {
      // `- key: value` opens a mapping whose later keys line up under `key`.
      const key = rest.slice(0, separator).trim();
      countKey(reader);
      const first = parseValue(
        reader,
        rest.slice(separator + 1),
        itemIndent,
        depth,
      );
      const mapping = parseMapping(reader, itemIndent, depth + 1);
      items.push({ [key]: first, ...mapping });
      continue;
    }
    items.push(parseScalar(rest));
  }
  return items;
}

/** The block that belongs to a key or sequence item with no inline value. */
function parseNested(reader: Reader, indent: number, depth: number): unknown {
  const at = peek(reader);
  if (at === -1) return null;
  const line = reader.lines[at] as string;
  const lineIndent = indentOf(line);
  const content = line.slice(lineIndent);
  if (lineIndent > indent) {
    return startsSequence(content)
      ? parseSequence(reader, lineIndent, depth + 1)
      : parseMapping(reader, lineIndent, depth + 1);
  }
  // A sequence may also sit at the parent's own column, which is how most
  // hand-written wiki frontmatter lists tags.
  if (lineIndent === indent && startsSequence(content)) {
    return parseSequence(reader, indent, depth + 1);
  }
  return null;
}

function parseValue(
  reader: Reader,
  rawValue: string,
  indent: number,
  depth: number,
): unknown {
  const value = stripComment(rawValue).trim();
  const header = blockHeader(value);
  if (header !== null) return readBlockScalar(reader, indent, header);
  if (value.length === 0) return parseNested(reader, indent, depth);
  return parseScalar(value);
}

interface Block {
  text: string;
  body: string;
  closer: "---" | "...";
}

function splitBlock(text: string): Block | null {
  const opening = OPEN_FENCE.exec(text);
  if (opening === null) return null;
  const remainder = text.slice(opening[0].length);
  const fence = /^(---|\.\.\.)\r?(?:\n|$)/m.exec(remainder);
  if (fence === null) return null;
  return {
    text: remainder.slice(0, fence.index),
    body: remainder.slice(fence.index + fence[0].length),
    closer: fence[1] as "---" | "...",
  };
}

function blockLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function unparsed(rule: string, body: string): LegacyFrontmatter {
  return { status: "unparsed", data: {}, body, problems: [rule] };
}

export function parseLegacyFrontmatter(markdown: string): LegacyFrontmatter {
  const text = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  if (!OPEN_FENCE.test(text)) {
    return { status: "absent", data: {}, body: text, problems: [] };
  }
  const block = splitBlock(text);
  if (block === null) return unparsed("no closing fence", text);
  if (Buffer.byteLength(block.text, "utf8") > MAX_FRONTMATTER_BYTES) {
    return unparsed("frontmatter exceeds 64 KiB", block.body);
  }
  if (block.closer === "..." && /^\s*---\r?(\n|$)/.test(block.body)) {
    return unparsed("a second document", block.body);
  }

  const reader: Reader = {
    // A block always ends with a newline; the empty tail that split leaves
    // behind is punctuation, not a blank line a block scalar should keep.
    lines: blockLines(block.text),
    index: 0,
    keys: 0,
    problems: [],
  };
  try {
    const data = parseMapping(reader, 0, 1);
    if (peek(reader) !== -1) throw new Unparsable("unexpected content");
    return {
      status: "parsed",
      data,
      body: block.body,
      problems: reader.problems,
    };
  } catch (error) {
    // Any refusal, named or not, is a report line rather than a crash: the
    // caller still imports the page with the body it could read.
    return unparsed(
      error instanceof Unparsable ? error.message : "unreadable frontmatter",
      block.body,
    );
  }
}
