const identifierSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const MARK = /\p{M}/u;
const FORMAT = /\p{Cf}/u;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const WHITE_SPACE = /\p{White_Space}/u;

/**
 * Identifiers keep their opaque source spelling. This only decides whether
 * that spelling has visible grapheme content that is safe to display and use
 * as an identity; it never normalizes or replaces source bytes.
 */
export function isVisibleIdentifier(value: string): boolean {
  if (value.trim() !== value || CONTROL_OR_LINE_SEPARATOR.test(value)) return false;
  // CGJ is a default-ignorable mark whose source spelling is visually
  // indistinguishable in identifiers, including when adjacent to visible text.
  if (value.includes("\u034f")) return false;
  // A cluster is usable when it contains visible source content. This admits
  // native emoji selectors, joins and tag sequences without rewriting them.
  // Most native source IDs are printable ASCII. Avoid allocating a grapheme
  // iterator at all for those, including the permitted large importer IDs.
  if (/^[\x20-\x7e]+$/.test(value)) return true;
  for (const { segment } of identifierSegmenter.segment(value)) {
    let whitespaceOnly = true;
    let visible = false;
    for (const ch of segment) {
      if (WHITE_SPACE.test(ch)) continue;
      whitespaceOnly = false;
      if (!MARK.test(ch) && !FORMAT.test(ch) && !DEFAULT_IGNORABLE.test(ch)) {
        visible = true;
        break;
      }
    }
    if (!whitespaceOnly && !visible) return false;
  }
  return true;
}

