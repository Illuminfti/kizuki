const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

/** A code point `String.fromCodePoint` accepts and that is not a lone surrogate. */
function isScalarValue(code: number): boolean {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return false;
  return code < 0xd800 || code > 0xdfff;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    // Own-property only: an object literal answers `constructor` and `toString`
    // with function source, which a hostile message would inject into capture.
    const named = Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : undefined;
    if (named !== undefined) return named;
    // A malformed or out-of-range reference stays verbatim rather than throwing:
    // one hostile message must not abort the capture of everything around it.
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return isScalarValue(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return isScalarValue(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

const BLOCK_END = /<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi;
const LINE_BREAK = /<\s*br\s*\/?\s*>/gi;
const DROPPED = /<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

/**
 * A readable-text approximation, not a renderer: enough to make an HTML-only
 * message searchable without pulling a DOM into the tree.
 */
export function htmlToText(html: string): string {
  const withoutDropped = html.replace(DROPPED, " ");
  const withBreaks = withoutDropped
    .replace(LINE_BREAK, "\n")
    .replace(BLOCK_END, "\n");
  const stripped = withBreaks.replace(/<[^>]*>/g, "");
  return decodeEntities(stripped)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
