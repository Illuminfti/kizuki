/**
 * The scalar half of the wiki frontmatter reader: quoting, comments, flow
 * collections, block scalars, and the refusals that name a YAML construct the
 * subset does not cover. Nothing here reaches outside one line except a block
 * scalar, which is why it holds the shared reader cursor.
 */

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export const MAX_FRONTMATTER_KEYS = 500;
export const MAX_FRONTMATTER_DEPTH = 8;

export interface Reader {
  lines: string[];
  index: number;
  keys: number;
  problems: string[];
}

export class Unparsable extends Error {
  constructor(rule: string) {
    super(rule);
    this.name = "Unparsable";
  }
}

export function indentOf(line: string): number {
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
export function peek(reader: Reader): number {
  let index = reader.index;
  while (
    index < reader.lines.length &&
    isSkippable(reader.lines[index] as string)
  ) {
    index += 1;
  }
  return index < reader.lines.length ? index : -1;
}

export function stripComment(raw: string): string {
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

export function refuseSpecial(content: string): void {
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

export function parseScalar(raw: string): unknown {
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

export type Chomp = "clip" | "strip" | "keep";

export function blockHeader(
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

export function readBlockScalar(
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

