import { sanitizeLine } from "../legacy/coerce";

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
export const MAX_FRONTMATTER_KEYS = 500;
export const MAX_FRONTMATTER_DEPTH = 8;

const OPEN_FENCE = /^---[ \t]*(?:\r?\n|$)/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const KEY = /^[^\s:#][^:]*$/;

class Unparsable extends Error {
  constructor(rule: string) {
    super(rule);
    this.name = "Unparsable";
  }
}

interface Reader {
  lines: string[];
  index: number;
  keys: number;
  problems: string[];
}

function indentOf(line: string): number {
  let indent = 0;
  while (indent < line.length) {
    const character = line[indent];
    if (character === " ") {
      indent += 1;
      continue;
    }
    if (character === "\t") throw new Unparsable("tab in indentation");
    break;
  }
  return indent;
}

function isSkippable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}

/** Index of the next line that carries structure, or -1 at the end. */
function peek(reader: Reader): number {
  let index = reader.index;
  while (
    index < reader.lines.length &&
    isSkippable(reader.lines[index] as string)
  ) {
    index += 1;
  }
  return index < reader.lines.length ? index : -1;
}

function stripComment(raw: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const character = raw[i];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    // YAML only starts a comment after whitespace, so `a#b` stays one scalar.
    if (character === "#" && i > 0 && /\s/.test(raw[i - 1] as string)) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function refuseSpecial(content: string): void {
  if (content.startsWith("&"))
    throw new Unparsable("anchors are not supported");
  if (content.startsWith("*"))
    throw new Unparsable("aliases are not supported");
  if (content.startsWith("!")) throw new Unparsable("tags are not supported");
  if (content.startsWith("%"))
    throw new Unparsable("directives are not supported");
  if (content === "?" || content.startsWith("? ")) {
    throw new Unparsable("complex keys are not supported");
  }
}

function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < inner.length; i += 1) {
    const character = inner[i];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[" || character === "{") {
      throw new Unparsable("nested flow collections are not supported");
    }
    if (character === ",") {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

function parseQuoted(value: string): string | undefined {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (!value.endsWith("'") || value.length < 2) return undefined;
  const inner = value.slice(1, -1);
  let parsed = "";
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === "'") {
      if (inner[i + 1] !== "'") return undefined;
      i += 1;
    }
    parsed += inner[i];
  }
  return parsed;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.length === 0 || value === "~" || value.toLowerCase() === "null") {
    return null;
  }
  refuseSpecial(value);
  if (value.startsWith('"') || value.startsWith("'")) {
    // An unterminated quote is a plain scalar here rather than a refusal: it
    // is the single most common hand-editing slip in a wiki.
    return parseQuoted(value) ?? value;
  }
  if (value.startsWith("[")) {
    if (!value.endsWith("]"))
      throw new Unparsable("multi-line flow is not supported");
    const inner = value.slice(1, -1).trim();
    return inner.length === 0
      ? []
      : splitFlow(inner).map((item) => parseScalar(item));
  }
  if (value.startsWith("{")) {
    if (!value.endsWith("}"))
      throw new Unparsable("multi-line flow is not supported");
    const inner = value.slice(1, -1).trim();
    const mapping: Record<string, unknown> = {};
    if (inner.length === 0) return mapping;
    for (const pair of splitFlow(inner)) {
      const separator = pair.indexOf(":");
      if (separator <= 0)
        throw new Unparsable("flow mapping needs key: value pairs");
      mapping[pair.slice(0, separator).trim()] = parseScalar(
        pair.slice(separator + 1),
      );
    }
    return mapping;
  }
  const lower = value.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (NUMBER.test(value)) return Number(value);
  return value;
}

type Chomp = "clip" | "strip" | "keep";

function blockHeader(
  value: string,
): { style: "literal" | "folded"; chomp: Chomp } | null {
  const style =
    value[0] === "|" ? "literal" : value[0] === ">" ? "folded" : null;
  if (style === null || value.length > 2) return null;
  const suffix = value[1];
  if (suffix === undefined) return { style, chomp: "clip" };
  if (suffix === "-") return { style, chomp: "strip" };
  if (suffix === "+") return { style, chomp: "keep" };
  return null;
}

function fold(lines: string[]): string {
  let folded = "";
  let breaks = 0;
  for (const line of lines) {
    if (line.length === 0) {
      breaks += 1;
      continue;
    }
    if (folded.length > 0) folded += breaks === 0 ? " " : "\n".repeat(breaks);
    folded += line;
    breaks = 0;
  }
  return folded;
}

function readBlockScalar(
  reader: Reader,
  parentIndent: number,
  header: { style: "literal" | "folded"; chomp: Chomp },
): string {
  const raw: string[] = [];
  while (reader.index < reader.lines.length) {
    const line = reader.lines[reader.index] as string;
    if (line.trim().length > 0 && indentOf(line) <= parentIndent) break;
    raw.push(line);
    reader.index += 1;
  }
  const first = raw.find((line) => line.trim().length > 0);
  if (first === undefined)
    return header.chomp === "keep" ? "\n".repeat(raw.length) : "";
  const contentIndent = indentOf(first);
  const dedented = raw.map((line) =>
    line.trim().length === 0 ? "" : line.slice(contentIndent),
  );

  let end = dedented.length;
  while (end > 0 && dedented[end - 1] === "") end -= 1;
  const body = dedented.slice(0, end);
  const trailing = dedented.length - end;
  const core = header.style === "literal" ? body.join("\n") : fold(body);
  if (header.chomp === "strip") return core;
  if (header.chomp === "keep") return core + "\n".repeat(trailing + 1);
  return `${core}\n`;
}

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
