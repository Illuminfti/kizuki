const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function hexValue(character: string): number {
  const code = character.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

/** Returns null rather than throwing: a malformed word is kept verbatim. */
export function decodeBase64Text(text: string): Uint8Array | null {
  const compact = text.replace(/[\r\n\t ]/g, "");
  const payload = compact.replace(/=+$/, "");
  // A quantum of one character carries six bits and encodes no byte at all.
  // Accepting it decoded a truncated word to nothing, and an encoded word
  // that decodes to nothing disappears from the header it was written in.
  if (payload.length % 4 === 1) return null;
  const out: number[] = [];
  let bits = 0;
  let accumulator = 0;
  for (const character of payload) {
    const value = BASE64_ALPHABET.indexOf(character);
    if (value === -1) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * `softBreaks` is off inside an encoded word, where a trailing `=` is a
 * malformation rather than a line continuation.
 */
export function decodeQuotedPrintableText(
  text: string,
  softBreaks = true,
): Uint8Array | null {
  const out: number[] = [];
  const lines = softBreaks ? text.split("\n") : [text];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    let line = lines[lineIndex] ?? "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    let soft = false;
    if (softBreaks) {
      const trimmed = line.replace(/[\t ]+$/, "");
      if (trimmed.endsWith("=")) {
        soft = true;
        line = trimmed.slice(0, -1);
      } else {
        line = trimmed;
      }
    }
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index] ?? "";
      if (character !== "=") {
        out.push(character.charCodeAt(0) & 0xff);
        continue;
      }
      const high = hexValue(line[index + 1] ?? "");
      const low = hexValue(line[index + 2] ?? "");
      if (high === -1 || low === -1) {
        if (!softBreaks) return null;
        out.push(0x3d);
        continue;
      }
      out.push(high * 16 + low);
      index += 2;
    }
    if (!soft && lineIndex < lines.length - 1) {
      out.push(0x0d, 0x0a);
    }
  }
  return Uint8Array.from(out);
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/**
 * RFC 2045 section 6.8 tells a decoder to ignore characters outside the
 * alphabet, which is how a body with one stray character stays readable.
 */
function decodeBase64Lenient(text: string): Uint8Array {
  return decodeBase64Text(text.replace(/[^A-Za-z0-9+/]/g, "")) ?? new Uint8Array();
}

export interface DecodedBody {
  bytes: Uint8Array;
  /** The encoding whose decode failed, so an odd body is explained. */
  fallback?: string;
}

export function decodeTransfer(
  encoding: string | undefined,
  body: Uint8Array,
): DecodedBody {
  const name = (encoding ?? "7bit").trim().toLowerCase();
  if (name === "base64") {
    const text = latin1(body);
    const strict = decodeBase64Text(text);
    if (strict !== null) return { bytes: strict };
    // An empty result means the body was never base64; the raw bytes at least
    // show the owner what arrived instead of an unexplained blank message.
    const lenient = decodeBase64Lenient(text);
    return {
      bytes: lenient.byteLength > 0 ? lenient : body,
      fallback: "base64",
    };
  }
  if (name === "quoted-printable") {
    // The soft-break form has no failure case; the raw body satisfies the type.
    return { bytes: decodeQuotedPrintableText(latin1(body)) ?? body };
  }
  return { bytes: body };
}
