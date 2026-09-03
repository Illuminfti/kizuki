export const MAX_HEADER_BYTES = 65_536;
export const MAX_HEADER_FIELDS = 200;

export interface HeaderField {
  /** Lowercased; repeated fields are kept in wire order. */
  name: string;
  value: string;
}

export interface ParsedHeaders {
  fields: HeaderField[];
  truncated: boolean;
  /** Offset of the first body byte, or the input length when there is no body. */
  bodyOffset: number;
}

function findHeaderEnd(bytes: Uint8Array): { end: number; bodyOffset: number } {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const atStart = index === 0;
    const previousIsCr = index > 0 && bytes[index - 1] === 0x0d;
    const blank =
      atStart ||
      (previousIsCr && index === 1) ||
      (previousIsCr && bytes[index - 2] === 0x0a) ||
      (!previousIsCr && bytes[index - 1] === 0x0a);
    if (blank) {
      const end = previousIsCr ? index - 1 : index;
      return { end: Math.max(0, end - 1), bodyOffset: index + 1 };
    }
  }
  return { end: bytes.length, bodyOffset: bytes.length };
}

/**
 * Header bytes are ASCII by RFC 5322; anything else is decoded latin1 so a
 * non-conforming server cannot make the split throw. Encoded words are
 * handled a layer up.
 */
export function parseHeaders(bytes: Uint8Array): ParsedHeaders {
  const { end, bodyOffset } = findHeaderEnd(bytes);
  const limit = Math.min(end, MAX_HEADER_BYTES);
  let text = "";
  for (let index = 0; index < limit; index += 1) {
    text += String.fromCharCode(bytes[index] ?? 0);
  }
  let truncated = end > MAX_HEADER_BYTES;

  const unfolded: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
      continue;
    }
    unfolded.push(line);
  }

  const fields: HeaderField[] = [];
  for (const line of unfolded) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    if (fields.length >= MAX_HEADER_FIELDS) {
      truncated = true;
      break;
    }
    fields.push({
      name: line.slice(0, separator).trim().toLowerCase(),
      value: line.slice(separator + 1).trim(),
    });
  }
  return { fields, truncated, bodyOffset };
}

export function headerValue(
  fields: HeaderField[],
  name: string,
): string | undefined {
  return fields.find((field) => field.name === name)?.value;
}

export function headerValues(fields: HeaderField[], name: string): string[] {
  return fields.filter((field) => field.name === name).map((field) => field.value);
}
