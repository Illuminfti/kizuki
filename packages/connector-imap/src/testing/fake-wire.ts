import { parseMessage } from "../mime/parse";
import type { MimePart } from "../mime/parse";

const encoder = new TextEncoder();

/**
 * Responses are bytes, not strings: a literal announces a byte count, and a
 * message with an 8-bit body would desynchronise the reader if it were
 * round-tripped through a JS string on the way out.
 */
export const ascii = (text: string): Uint8Array => encoder.encode(text);

export function joined(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface Range {
  first: number;
  last: number;
}

export function parseRanges(set: string, uidnext: number): Range[] {
  const ranges: Range[] = [];
  for (const piece of set.split(",")) {
    const bounds = piece.split(":");
    const parse = (raw: string | undefined): number =>
      raw === "*" ? Math.max(1, uidnext - 1) : Number(raw ?? "0");
    if (bounds.length === 1) {
      const only = parse(bounds[0]);
      ranges.push({ first: only, last: only });
      continue;
    }
    const first = parse(bounds[0]);
    const last = parse(bounds[1]);
    ranges.push({ first: Math.min(first, last), last: Math.max(first, last) });
  }
  return ranges;
}

export function tokenize(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let depth = 0;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (quoted) {
      if (character === "\\") {
        current += line[index + 1] ?? "";
        index += 1;
        continue;
      }
      if (character === '"') {
        quoted = false;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === " " && depth === 0) {
      if (started || current.length > 0) args.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
  }
  if (started || current.length > 0) args.push(current);
  return args;
}

export function headerBytes(raw: Uint8Array): Uint8Array {
  for (let index = 0; index + 1 < raw.length; index += 1) {
    if (raw[index] !== 0x0a) continue;
    const previousIsCr = index > 0 && raw[index - 1] === 0x0d;
    const blank =
      (previousIsCr && raw[index - 2] === 0x0a) ||
      (!previousIsCr && raw[index - 1] === 0x0a);
    if (blank || index === 0) return raw.slice(0, index + 1);
  }
  return raw;
}

function quotedString(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function paramList(params: Record<string, string>): string {
  const entries = Object.entries(params);
  return entries.length === 0
    ? "NIL"
    : `(${entries.map(([key, value]) => `${quotedString(key)} ${quotedString(value)}`).join(" ")})`;
}

function dispositionText(part: MimePart): string {
  return part.disposition === null
    ? "NIL"
    : `(${quotedString(part.disposition.type)} ${paramList(part.disposition.params)})`;
}

/**
 * RFC 3501 section 7.4.2 puts the extension data after a different number of
 * fields for each shape of part, and the reader depends on that.
 */
function renderPart(part: MimePart): string {
  const { type, subtype, params } = part.contentType;
  if (part.children.length > 0) {
    return `(${part.children.map(renderPart).join("")} ${quotedString(subtype)} ${paramList(params)} ${dispositionText(part)})`;
  }
  const head = `${quotedString(type)} ${quotedString(subtype)} ${paramList(params)} NIL NIL "7bit" ${part.body.byteLength}`;
  if (type === "text") return `(${head} 1 NIL ${dispositionText(part)})`;
  if (type === "message" && subtype === "rfc822") {
    return `(${head} NIL NIL 1 NIL ${dispositionText(part)})`;
  }
  return `(${head} NIL ${dispositionText(part)})`;
}

/** The `BODYSTRUCTURE` a real server would send for these bytes. */
export function bodyStructure(raw: Uint8Array): string {
  return renderPart(parseMessage(raw).root);
}
