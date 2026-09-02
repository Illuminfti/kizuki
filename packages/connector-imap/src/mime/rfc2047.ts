import { decodeBase64Text, decodeQuotedPrintableText } from "./transfer";
import { decodeCharset } from "./charset";

const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

export interface DecodedText {
  text: string;
  /** Charset labels this platform could not decode; surfaced in metadata. */
  fallbacks: string[];
}

/**
 * RFC 2047 encoded words. Adjacent words lose the whitespace between them
 * (RFC 2047 §6.2); a malformed word is left verbatim rather than dropped, so
 * nothing the sender wrote silently disappears.
 */
export function decodeEncodedWords(input: string): DecodedText {
  const fallbacks: string[] = [];
  let out = "";
  let cursor = 0;
  let previousWordEnd = -1;

  ENCODED_WORD.lastIndex = 0;
  for (
    let match = ENCODED_WORD.exec(input);
    match !== null;
    match = ENCODED_WORD.exec(input)
  ) {
    const [whole, charset = "", encoding = "", payload = ""] = match;
    const start = match.index;
    const between = input.slice(cursor, start);
    const adjacent = previousWordEnd === cursor && between.trim().length === 0;
    if (!adjacent) out += between;

    let bytes: Uint8Array | null;
    if (encoding.toLowerCase() === "b") {
      bytes = decodeBase64Text(payload);
    } else {
      bytes = decodeQuotedPrintableText(payload.replace(/_/g, " "), false);
    }
    if (bytes === null) {
      out += whole;
    } else {
      const decoded = decodeCharset(bytes, charset);
      out += decoded.text;
      if (decoded.fallback !== undefined && !fallbacks.includes(decoded.fallback)) {
        fallbacks.push(decoded.fallback);
      }
    }
    cursor = start + whole.length;
    previousWordEnd = cursor;
  }
  out += input.slice(cursor);
  return { text: out, fallbacks };
}
