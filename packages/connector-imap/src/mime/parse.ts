import { decodeCharset } from "./charset";
import { headerValue, parseHeaders } from "./headers";
import type { HeaderField, ParsedHeaders } from "./headers";
import { decodeTransfer } from "./transfer";
import { decodeEncodedWords } from "./rfc2047";

export const MAX_MIME_DEPTH = 10;
export const MAX_MIME_PARTS = 200;

export interface ContentType {
  type: string;
  subtype: string;
  params: Record<string, string>;
}

export interface ContentDisposition {
  type: string;
  params: Record<string, string>;
}

export interface MimePart {
  /** MIME section path: `""` for the message itself, then `"1"`, `"1.2"`. */
  path: string;
  headers: HeaderField[];
  contentType: ContentType;
  disposition: ContentDisposition | null;
  /** Transfer-decoded bytes; empty for a multipart container. */
  body: Uint8Array;
  /** Set when the declared transfer encoding did not decode cleanly. */
  transferFallback?: string;
  children: MimePart[];
}

export interface ParsedMessage {
  root: MimePart;
  headers: HeaderField[];
  headersTruncated: boolean;
}

function splitParams(value: string): { head: string; params: Record<string, string> } {
  const raw: Record<string, string> = {};
  let head = "";
  let current = "";
  let quoted = false;
  const pieces: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character === '"') {
      quoted = !quoted;
      current += character;
      continue;
    }
    if (character === ";" && !quoted) {
      pieces.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  pieces.push(current);
  head = (pieces.shift() ?? "").trim();

  for (const piece of pieces) {
    const separator = piece.indexOf("=");
    if (separator === -1) continue;
    const name = piece.slice(0, separator).trim().toLowerCase();
    let text = piece.slice(separator + 1).trim();
    if (text.startsWith('"')) {
      text = text.slice(1, text.endsWith('"') ? -1 : undefined).replace(/\\(.)/g, "$1");
    }
    if (name.length > 0) raw[name] = text;
  }
  return { head, params: raw };
}

/** Reassembles RFC 2231 `name*0*=…` continuations and percent-decodes them. */
export function normalizeParams(raw: Record<string, string>): Record<string, string> {
  const continuations = new Map<string, { index: number; value: string; extended: boolean }[]>();
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const match = /^([^*]+)\*(\d+)(\*)?$/.exec(key);
    if (match !== null) {
      const base = match[1] ?? "";
      const list = continuations.get(base) ?? [];
      list.push({
        index: Number(match[2] ?? "0"),
        value,
        extended: match[3] === "*",
      });
      continuations.set(base, list);
      continue;
    }
    if (key.endsWith("*")) {
      params[key.slice(0, -1)] = decodeExtended(value);
      continue;
    }
    params[key] = value;
  }
  for (const [base, pieces] of continuations) {
    params[base] = decodeContinued(pieces);
  }
  return params;
}

function decodeExtended(value: string): string {
  return decodeContinued([{ index: 0, value, extended: true }]);
}

/**
 * RFC 2231: one continued value, one charset from the first encoded
 * segment, octets reassembled before decoding. Unencoded pieces are
 * literal, including a percent sign.
 */
function decodeContinued(
  pieces: { index: number; value: string; extended: boolean }[],
): string {
  pieces.sort((a, b) => a.index - b.index);
  if (!pieces.some((piece) => piece.extended)) {
    return pieces.map((piece) => piece.value).join("");
  }
  let charset = "";
  let seenExtended = false;
  const bytes: number[] = [];
  for (const piece of pieces) {
    if (!piece.extended) {
      appendRawBytes(bytes, piece.value);
      continue;
    }
    let payload = piece.value;
    if (!seenExtended) {
      const parts = piece.value.split("'");
      if (parts.length >= 3) {
        charset = parts[0] ?? "";
        payload = parts.slice(2).join("'");
      }
      seenExtended = true;
    }
    appendPercentDecoded(bytes, payload);
  }
  return decodeCharset(Uint8Array.from(bytes), charset).text;
}

function appendRawBytes(bytes: number[], text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    bytes.push((text[index] ?? "").charCodeAt(0) & 0xff);
  }
}

function appendPercentDecoded(bytes: number[], payload: string): void {
  for (let index = 0; index < payload.length; index += 1) {
    const character = payload[index] ?? "";
    if (character === "%" && index + 2 < payload.length) {
      const code = Number.parseInt(payload.slice(index + 1, index + 3), 16);
      if (Number.isFinite(code)) {
        bytes.push(code);
        index += 2;
        continue;
      }
    }
    bytes.push(character.charCodeAt(0) & 0xff);
  }
}

export function parseContentType(value: string | undefined): ContentType {
  if (value === undefined || value.trim().length === 0) {
    return { type: "text", subtype: "plain", params: {} };
  }
  const { head, params } = splitParams(value);
  const slash = head.indexOf("/");
  if (slash <= 0) {
    return { type: "text", subtype: "plain", params: normalizeParams(params) };
  }
  return {
    type: head.slice(0, slash).trim().toLowerCase(),
    subtype: head.slice(slash + 1).trim().toLowerCase(),
    params: normalizeParams(params),
  };
}

export function parseDisposition(
  value: string | undefined,
): ContentDisposition | null {
  if (value === undefined || value.trim().length === 0) return null;
  const { head, params } = splitParams(value);
  return { type: head.toLowerCase(), params: normalizeParams(params) };
}

function indexOfSequence(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
): number {
  outer: for (let index = from; index + needle.length <= haystack.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function atLineStart(bytes: Uint8Array, index: number): boolean {
  return index === 0 || bytes[index - 1] === 0x0a;
}

/**
 * RFC 2046: a delimiter line ends after the boundary, apart from the closing
 * `--` and transport padding. Without this check a nested boundary that merely
 * extends the outer one (`b` and `b1`) splits the message in the wrong places,
 * and every attachment ref below it names the wrong MIME section.
 */
function endsDelimiter(bytes: Uint8Array, index: number): boolean {
  let cursor = index;
  if (bytes[cursor] === 0x2d && bytes[cursor + 1] === 0x2d) cursor += 2;
  while (bytes[cursor] === 0x20 || bytes[cursor] === 0x09) cursor += 1;
  return (
    cursor >= bytes.length || bytes[cursor] === 0x0d || bytes[cursor] === 0x0a
  );
}

function splitMultipart(body: Uint8Array, boundary: string): Uint8Array[] {
  const marker = new TextEncoder().encode(`--${boundary}`);
  const segments: Uint8Array[] = [];
  let contentStart = -1;
  let cursor = 0;
  while (cursor < body.length) {
    const found = indexOfSequence(body, marker, cursor);
    if (found === -1) break;
    if (!atLineStart(body, found) || !endsDelimiter(body, found + marker.length)) {
      cursor = found + 1;
      continue;
    }
    if (contentStart !== -1) {
      let end = found;
      if (end > 0 && body[end - 1] === 0x0a) end -= 1;
      if (end > 0 && body[end - 1] === 0x0d) end -= 1;
      segments.push(body.slice(contentStart, Math.max(contentStart, end)));
    }
    const afterMarker = found + marker.length;
    if (body[afterMarker] === 0x2d && body[afterMarker + 1] === 0x2d) break;
    let lineEnd = afterMarker;
    while (lineEnd < body.length && body[lineEnd] !== 0x0a) lineEnd += 1;
    contentStart = lineEnd + 1;
    cursor = contentStart;
  }
  return segments;
}

interface WalkBudget {
  parts: number;
}

function buildPart(
  bytes: Uint8Array,
  path: string,
  depth: number,
  budget: WalkBudget,
  parsed: ParsedHeaders = parseHeaders(bytes),
): MimePart {
  const contentType = parseContentType(headerValue(parsed.fields, "content-type"));
  const disposition = parseDisposition(
    headerValue(parsed.fields, "content-disposition"),
  );
  const rawBody = bytes.slice(parsed.bodyOffset);
  const part: MimePart = {
    path,
    headers: parsed.fields,
    contentType,
    disposition,
    body: new Uint8Array(),
    children: [],
  };

  const boundary = contentType.params["boundary"];
  if (
    contentType.type === "multipart" &&
    boundary !== undefined &&
    boundary.length > 0 &&
    depth < MAX_MIME_DEPTH
  ) {
    const segments = splitMultipart(rawBody, boundary);
    segments.forEach((segment, index) => {
      if (budget.parts >= MAX_MIME_PARTS) return;
      budget.parts += 1;
      const childPath = path.length === 0 ? `${index + 1}` : `${path}.${index + 1}`;
      part.children.push(buildPart(segment, childPath, depth + 1, budget));
    });
    return part;
  }

  // `message/rfc822` is captured as an attachment ref, never recursed into:
  // the enclosed message is not a record the owner's mailbox indexed.
  const decoded = decodeTransfer(
    headerValue(parsed.fields, "content-transfer-encoding"),
    rawBody,
  );
  part.body = decoded.bytes;
  if (decoded.fallback !== undefined) part.transferFallback = decoded.fallback;
  return part;
}

export function parseMessage(bytes: Uint8Array): ParsedMessage {
  const parsed = parseHeaders(bytes);
  const root = buildPart(bytes, "", 0, { parts: 0 }, parsed);
  return {
    root,
    headers: parsed.fields,
    headersTruncated: parsed.truncated,
  };
}

/** Decodes a leaf's bytes with its declared charset, recording any fallback. */
export function partText(
  part: MimePart,
  fallbacks: string[],
): string {
  const decoded = decodeCharset(part.body, part.contentType.params["charset"] ?? "utf-8");
  if (decoded.fallback !== undefined && !fallbacks.includes(decoded.fallback)) {
    fallbacks.push(decoded.fallback);
  }
  return decoded.text;
}

export function decodeHeaderText(value: string, fallbacks: string[]): string {
  const decoded = decodeEncodedWords(value);
  for (const fallback of decoded.fallbacks) {
    if (!fallbacks.includes(fallback)) fallbacks.push(fallback);
  }
  return decoded.text;
}
