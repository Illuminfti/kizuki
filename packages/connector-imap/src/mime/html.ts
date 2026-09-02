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
const DROPPED_OPEN = /<\s*(script|style)\b/gi;
const DROPPED_CLOSE = {
  script: /<\s*\/\s*script\s*>/gi,
  style: /<\s*\/\s*style\s*>/gi,
};

/**
 * A forward scan, not a paired pattern. One regex spanning an open and its
 * close backtracks to the end of the document for every open tag that has no
 * close, which is quadratic in the length of a message any stranger can send.
 * Each character here is looked at a fixed number of times instead.
 */
function stripDropped(html: string): string {
  DROPPED_OPEN.lastIndex = 0;
  let out = "";
  let cursor = 0;
  for (
    let open = DROPPED_OPEN.exec(html);
    open !== null;
    open = DROPPED_OPEN.exec(html)
  ) {
    const name = (open[1] ?? "").toLowerCase();
    const close = name === "style" ? DROPPED_CLOSE.style : DROPPED_CLOSE.script;
    close.lastIndex = DROPPED_OPEN.lastIndex;
    const end = close.exec(html);
    out += `${html.slice(cursor, open.index)} `;
    // An element nobody closed swallows the rest of the document, the way a
    // browser reads it; scanning on would put script source into capture.
    if (end === null) return out;
    cursor = end.index + end[0].length;
    DROPPED_OPEN.lastIndex = cursor;
  }
  return out + html.slice(cursor);
}

/**
 * A readable-text approximation, not a renderer: enough to make an HTML-only
 * message searchable without pulling a DOM into the tree.
 */
export function htmlToText(html: string): string {
  const withoutDropped = stripDropped(html);
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
