/**
 * Pre-egress secret scrubber. It runs on the text of a model prompt after the
 * ledger has stored the original; only the outbound copy changes. It is a
 * heuristic backstop, not a guarantee: it recognizes the shapes below and
 * nothing else. Each match becomes `[redacted:<kind>]`.
 */

export const REDACTION_KINDS = ["pem", "jwt", "api_token", "bearer", "secret_assignment", "seed_phrase"] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/** One replaced span, in the coordinates of the original and of the scrubbed text. */
export interface Redaction {
  readonly kind: RedactionKind;
  readonly start: number;
  readonly end: number;
  readonly out_start: number;
  readonly out_end: number;
}

export interface ScrubbedText {
  readonly text: string;
  readonly redactions: readonly Redaction[];
}

type Span = { readonly kind: RedactionKind; readonly start: number; readonly end: number };

/**
 * Patterns are linear: each keyword or run start is scanned once, and a match
 * consumes what it scans, so a long identifier-like run cannot make a scan quadratic.
 */
const PEM = /-----BEGIN ([A-Z0-9 ]{1,40})-----[\s\S]*?(?:-----END \1-----|$)/g;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const API_TOKEN = /(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9]))/g;
const BEARER = /(Authorization["']?\s{0,3}[:=]\s{0,3}["']?Bearer\s+)([^\s"'<>,;]{6,})/gi;
/**
 * A secret keyword anywhere in a name, then `=`, then the value: a quoted value
 * through its closing quote or the end of the line, an unquoted one through the
 * next whitespace. The name's prefix does not matter, so a long name cannot hide it.
 */
const ASSIGNMENT = /(secret|token|passw(?:or)?d|api[_-]?key)[A-Za-z0-9_.-]{0,100}\s{0,3}=\s{0,3}(?:"([^"\n]{4,})"?|'([^'\n]{4,})'?|([^\s"']{4,}))/gid;
const SEP = "(?:,? ?\\r?\\n|, ?| )";
const WORD_RUN = new RegExp(`(?<![\\p{L}\\p{N}'’_-])[a-z]{3,8}(?:${SEP}[a-z]{3,8})*(?![\\p{L}\\p{N}'’_-])`, "gu");
const SEED_WINDOW = 12;

/** Common English function words that a mnemonic list does not contain; two of them mean prose. */
const PROSE_WORDS = new Set([
  "the", "and", "that", "with", "was", "are", "this", "from", "have", "not", "but", "you",
  "they", "will", "would", "which", "there", "been", "were", "what", "their", "then", "than",
]);

function* matches(text: string, pattern: RegExp): Generator<RegExpExecArray> {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    yield match;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
}

/**
 * A lowercase-word run of 12 or more words is a seed-phrase candidate. Every
 * 12-word window with fewer than two common function words counts, and the
 * union of those windows is redacted, so a phrase inside a sentence, joined by
 * commas or newlines, or one of 24 words is caught whole. A window is a 24-word
 * phrase's two halves, so no separate 24-word pass is needed. Prose function
 * words at the edge of the result are left out.
 */
function seedSpans(run: string, offset: number): Span[] {
  const words = [...run.matchAll(/[a-z]+/g)].map(word => ({ start: word.index, end: word.index + word[0].length, prose: PROSE_WORDS.has(word[0]) }));
  if (words.length < SEED_WINDOW) return [];
  const proseBefore = [0];
  for (const word of words) proseBefore.push(proseBefore[proseBefore.length - 1]! + (word.prose ? 1 : 0));
  const covered = new Array<boolean>(words.length).fill(false);
  for (let first = 0; first + SEED_WINDOW <= words.length; first += 1) {
    if (proseBefore[first + SEED_WINDOW]! - proseBefore[first]! >= 2) continue;
    for (let index = first; index < first + SEED_WINDOW; index += 1) covered[index] = true;
  }
  const found: Span[] = [];
  for (let index = 0; index < words.length;) {
    if (!covered[index]) { index += 1; continue; }
    let last = index;
    while (last + 1 < words.length && covered[last + 1]) last += 1;
    let from = index, to = last;
    while (from < to && words[from]!.prose && to - from + 1 > SEED_WINDOW) from += 1;
    while (to > from && words[to]!.prose && to - from + 1 > SEED_WINDOW) to -= 1;
    found.push({ kind: "seed_phrase", start: offset + words[from]!.start, end: offset + words[to]!.end });
    index = last + 1;
  }
  return found;
}

function spans(text: string): Span[] {
  const found: Span[] = [];
  for (const match of matches(text, PEM)) found.push({ kind: "pem", start: match.index, end: match.index + match[0].length });
  for (const match of matches(text, JWT)) found.push({ kind: "jwt", start: match.index, end: match.index + match[0].length });
  for (const match of matches(text, API_TOKEN)) found.push({ kind: "api_token", start: match.index, end: match.index + match[0].length });
  for (const match of matches(text, BEARER)) {
    const start = match.index + match[1]!.length;
    found.push({ kind: "bearer", start, end: start + match[2]!.length });
  }
  for (const match of matches(text, ASSIGNMENT)) {
    const which = [2, 3, 4].find(index => match[index] !== undefined)!;
    const [start, end] = match.indices![which]!;
    const value = match[which]!;
    if (match[1]!.toLowerCase() === "token" && value.length < 8 && /^\d+[,;.)\]}]*$/.test(value)) continue;
    found.push({ kind: "secret_assignment", start, end });
  }
  for (const match of matches(text, WORD_RUN)) found.push(...seedSpans(match[0], match.index));
  return found;
}

/** Earliest start wins, then the longer span, then the more specific kind. Overlaps merge into the earlier span. */
function disjoint(found: Span[]): Span[] {
  const order = (span: Span): number => REDACTION_KINDS.indexOf(span.kind);
  found.sort((a, b) => a.start - b.start || b.end - a.end || order(a) - order(b));
  const kept: Span[] = [];
  for (const span of found) {
    const last = kept[kept.length - 1];
    if (last === undefined || span.start >= last.end) kept.push(span);
    else if (span.end > last.end) kept[kept.length - 1] = { ...last, end: span.end };
  }
  return kept;
}

export function scrubText(text: string): ScrubbedText {
  const kept = disjoint(spans(text));
  if (kept.length === 0) return { text, redactions: [] };
  const redactions: Redaction[] = [];
  let out = "";
  let cursor = 0;
  for (const span of kept) {
    out += text.slice(cursor, span.start);
    const marker = `[redacted:${span.kind}]`;
    redactions.push({ kind: span.kind, start: span.start, end: span.end, out_start: out.length, out_end: out.length + marker.length });
    out += marker;
    cursor = span.end;
  }
  return { text: out + text.slice(cursor), redactions };
}

export type RedactionCounts = Partial<Record<RedactionKind, number>>;

/** Adds one text's redactions to a running per-kind count. */
export function tallyRedactions(counts: RedactionCounts, redactions: readonly Redaction[]): void {
  for (const item of redactions) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
}

/** Scrubs a text that carries no offsets and adds what it removed to a running count. */
export function scrubCounting(counts: RedactionCounts, text: string): string {
  const scrubbed = scrubText(text);
  tallyRedactions(counts, scrubbed.redactions);
  return scrubbed.text;
}

/**
 * Original offset to scrubbed offset. An offset inside a replaced span snaps to
 * the replacement's near edge for a range start and its far edge for a range end.
 */
export function toScrubbedOffset(redactions: readonly Redaction[], offset: number, edge: "start" | "end"): number {
  let shift = 0;
  for (const item of redactions) {
    if (offset <= item.start) break;
    if (offset >= item.end) { shift += (item.out_end - item.out_start) - (item.end - item.start); continue; }
    return edge === "start" ? item.out_start : item.out_end;
  }
  return offset + shift;
}

/** Scrubbed offset back to original offset; the inverse of `toScrubbedOffset` on the same terms. */
export function fromScrubbedOffset(redactions: readonly Redaction[], offset: number, edge: "start" | "end"): number {
  let shift = 0;
  for (const item of redactions) {
    if (offset <= item.out_start) break;
    if (offset >= item.out_end) { shift += (item.out_end - item.out_start) - (item.end - item.start); continue; }
    return edge === "start" ? item.start : item.end;
  }
  return offset - shift;
}
