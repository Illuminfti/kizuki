/**
 * Shared credential scrubber for model prompts, serving and session capture.
 * It is a heuristic backstop: recognized shapes become `[redacted:<kind>]`.
 * Offset maps keep model anchors bound to the original evidence.
 */

export const REDACTION_KINDS = ["pem", "jwt", "api_token", "bearer", "authorization", "url_credentials", "secret_assignment", "seed_phrase", "control"] as const;
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

type Span = {
  readonly kind: RedactionKind;
  readonly start: number;
  readonly end: number;
  /** Include the detector's prefix when testing already-sanitized ranges. */
  readonly contextStart?: number;
  readonly contextEnd?: number;
};

/**
 * Patterns are linear: each keyword or run start is scanned once, and a match
 * consumes what it scans, so a long identifier-like run cannot make a scan quadratic.
 */
const PEM_HEADER = /-----BEGIN[ \t\r\n]+([A-Z0-9 \t\r\n>]{1,60})-----/g;
const PEM_DELIMITER = /-----(BEGIN|END)[ \t\r\n]+([A-Z0-9 \t\r\n>]{1,60})-----/g;
const PEM_BODY_LINE = /(?:[ \t]*>[ \t]*)?[A-Za-z0-9+/=]+(?:[ \t]*\r?\n|[ \t]*$|(?=[ \t]+\())/y;
const PEM_METADATA_LINE = /(?:[ \t]*>[ \t]*)?(?:(?:Proc-Type|DEK-Info):[^\r\n]*(?:\r?\n|$)|[ \t]*\r?\n)/y;
const PEM_END = /(?:[ \t]*>[ \t]*)?-----END[ \t\r\n]+([A-Z0-9 \t\r\n>]{1,60})-----/y;
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const API_TOKEN = /(?:kzk_[0-9A-HJKMNP-TV-Z]{52}|kzs_[A-Za-z0-9_-]{43}|sk-[A-Za-z0-9_-]{20,}|[sr]k_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9]))/g;
const WRAPPED_TOKEN = /(kzk_|kzs_|sk-|[sr]k_live_|gh[pousr]_|github_pat_|glpat-|npm_|xox[abposr]-|xapp-|AIza|AKIA|ASIA)([A-Za-z0-9_-]{0,256})[ \t]{0,16}\r?\n[ \t]{0,16}([A-Za-z0-9_-]+)/g;
const BEARER = /(\bBearer\s+)([^\s"'<>,;]{16,})/gi;
const AUTH_BEARER = /(\bAuthorization["']?\s{0,1024}[:=]\s{0,1024}["']?Bearer\s+)([^\s"'<>,;]+)/gi;
const AUTHORIZATION = /(\bAuthorization["']?\s{0,1024}[:=]\s{0,1024}["']?(?:Basic|Token)\s+)([^\s"'<>,;]+)/gi;
const AUTH_RAW = /(\bAuthorization["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Token)\b)([^\s"'<>,;]+)/gi;
const URL_CREDENTIALS = /[A-Za-z][A-Za-z0-9+.-]{0,63}:\/\/([^\s\/:@]+(?::[^\s\/@]*)?|:[^\s\/@]+)@/gd;
/**
 * A secret keyword anywhere in a name, then `=` or `:`, then the value: a quoted value
 * through its closing quote or the end of the line, an unquoted one through the
 * next whitespace. The name's prefix does not matter, so a long name cannot hide it.
 */
const ASSIGNMENT = /(secret|token|passw(?:or)?d|api[ _-]?key|private[ _-]?key|credential)[A-Za-z0-9_.-]{0,100}["']?\s*[=:]\s*(?:"((?:\\[^\n]|[^"\\\n])+)"?|'((?:\\[^\n]|[^'\\\n])+)'?|([^\s"']+))/gid;
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

/** A YAML block scalar ends at the first nonblank line below its body indent. */
function yamlBlockEnd(text: string, field: number, valueEnd: number, indicator: string): number {
  const newline = /^[ \t]*\r?\n/.exec(text.slice(valueEnd));
  if (newline === null) return valueEnd;
  const lineStart = text.lastIndexOf("\n", field - 1) + 1;
  const fieldIndent = /^[ \t]*/.exec(text.slice(lineStart, field))![0].length;
  let cursor = valueEnd + newline[0].length;
  const explicitIndent = /[1-9]/.exec(indicator);
  let bodyIndent = explicitIndent === null ? undefined : fieldIndent + Number(explicitIndent[0]);
  let end = valueEnd;
  while (cursor < text.length) {
    const next = text.indexOf("\n", cursor);
    const lineEnd = next < 0 ? text.length : next;
    const line = text.slice(cursor, lineEnd).replace(/\r$/, "");
    if (line.trim() !== "") {
      const indent = /^[ \t]*/.exec(line)![0].length;
      bodyIndent ??= indent;
      if (bodyIndent <= fieldIndent || indent < bodyIndent) break;
    }
    end = cursor + line.length;
    cursor = lineEnd + 1;
  }
  return end;
}

/** Markdown quote prefixes may split a PEM label across captured lines. */
function pemLabel(label: string): string {
  return label.replace(/[>\s]+/g, " ").trim();
}

function spans(text: string): Span[] {
  const found: Span[] = [];
  // A single delimiter scan handles complete blocks with legacy metadata.
  // Reset at a new header so repeated incomplete headers never rescan a suffix.
  let opened: { start: number; label: string } | undefined;
  for (const match of matches(text, PEM_DELIMITER)) {
    const label = pemLabel(match[2]!);
    if (match[1] === "BEGIN") opened = { start: match.index, label };
    else if (opened !== undefined && opened.label === label) {
      found.push({ kind: "pem", start: opened.start, end: match.index + match[0].length });
      opened = undefined;
    }
  }
  for (const match of matches(text, PEM_HEADER)) {
    let end = match.index + match[0].length;
    const newline = /^[ \t]*\r?\n/.exec(text.slice(end, end + 32));
    if (newline !== null) {
      let cursor = end + newline[0].length;
      for (;;) {
        PEM_BODY_LINE.lastIndex = cursor;
        PEM_METADATA_LINE.lastIndex = cursor;
        const body = PEM_BODY_LINE.exec(text) ?? PEM_METADATA_LINE.exec(text);
        if (body === null) break;
        end = cursor + body[0].length;
        cursor = end;
      }
      PEM_END.lastIndex = cursor;
      const closing = PEM_END.exec(text);
      if (closing !== null && pemLabel(closing[1]!) === pemLabel(match[1]!)) {
        end = cursor + closing[0].length;
      }
    }
    found.push({ kind: "pem", start: match.index, end });
  }
  for (const match of matches(text, JWT)) found.push({ kind: "jwt", start: match.index, end: match.index + match[0].length });
  for (const match of matches(text, API_TOKEN)) found.push({ kind: "api_token", start: match.index, end: match.index + match[0].length });
  // An independently recognizable credential on the next line is not a
  // continuation. Reuse detected starts rather than scanning each suffix again.
  const credentialStarts = new Set(found.map((span) => span.start));
  for (const match of matches(text, WRAPPED_TOKEN)) {
    // A following assignment is a sibling field, not the key's continuation.
    if (/^[ \t]*[:=]/.test(text.slice(match.index + match[0].length))) continue;
    // Fixed-length tokens cannot need another line once complete. For variable
    // tokens, withhold a standalone fragment of any length, or a long fragment
    // followed by prose. A short word within a following sentence is preserved.
    const first = match[1]! + match[2]!;
    const standalone = /^[ \t]*(?:\r?\n|$)/.test(text.slice(match.index + match[0].length));
    const continuationStart = match.index + match[0].length - match[3]!.length;
    if ([...matches(first, API_TOKEN)].length > 0 &&
        (credentialStarts.has(continuationStart) || /^(?:kzk_|kzs_|AKIA|ASIA)$/.test(match[1]!) ||
         (!standalone && match[3]!.length < 16))) continue;
    // Validate the joined shape with the same pattern, rather than a second token catalogue.
    const joined = first + match[3]!;
    if ([...matches(joined, API_TOKEN)].length > 0) {
      found.push({ kind: "api_token", start: match.index, end: match.index + match[0].length });
    }
  }
  for (const pattern of [BEARER, AUTH_BEARER]) for (const match of matches(text, pattern)) {
      if (/^\[redacted:[a-z_]+\]$/.test(match[2]!)) continue;
      const start = match.index + match[1]!.length;
      found.push({ kind: "bearer", start, end: start + match[2]!.length, contextStart: match.index });
    }
  for (const pattern of [AUTHORIZATION, AUTH_RAW]) for (const match of matches(text, pattern)) {
    if (/^\[redacted:[a-z_]+\]$/.test(match[2]!)) continue;
    const start = match.index + match[1]!.length;
    found.push({ kind: "authorization", start, end: start + match[2]!.length, contextStart: match.index });
  }
  for (const match of matches(text, URL_CREDENTIALS)) {
    if (/^\[redacted:[a-z_]+\]$/.test(match[1]!)) continue;
    const [start, end] = match.indices![1]!;
    found.push({ kind: "url_credentials", start, end, contextStart: match.index, contextEnd: match.index + match[0].length });
  }
  let blockEnd = 0;
  for (const match of /[:=]/.test(text) ? matches(text, ASSIGNMENT) : []) {
    // A block's payload is already covered; nested key-looking lines must not
    // repeatedly scan the same suffix.
    if (match.index < blockEnd) continue;
    const which = [2, 3, 4].find(index => match[index] !== undefined)!;
    const [start, end] = match.indices![which]!;
    const value = match[which]!;
    // A bare shell variable reference is not its resolved secret. In YAML,
    // however, '$' is ordinary literal text and must not bypass redaction.
    const separator = text.slice(match.index, start);
    if ((which === 4 && separator.includes("=") && /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(value)) ||
        /^\[redacted:[a-z_]+\]$/.test(value)) continue;
    const prefix = /[A-Za-z0-9_.-]*$/.exec(text.slice(Math.max(0, match.index - 100), match.index))![0];
    const name = (prefix + match[0].slice(0, match[0].search(/["'\s=:]/))).toLowerCase();
    if (name === "token" && which === 4 && /:\s*\S+$/.test(match[0]) && /^(?:string|number|boolean|undefined|null)[,;.)\]}]*$/.test(value)) continue;
    if (/^(?:max_tokens|tokens|token_count|input_tokens|output_tokens)$/.test(name) && value.length < 8 && /^\d+[,;.)\]}]*$/.test(value)) continue;
    if (which === 4 && /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/.test(value) && match[0].includes(":")) {
      blockEnd = yamlBlockEnd(text, match.index, end, value);
      found.push({ kind: "secret_assignment", start, end: blockEnd, contextStart: match.index });
    } else found.push({ kind: "secret_assignment", start, end, contextStart: match.index });
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

/** Invisible format characters cannot split a credential or carry hidden instructions. */
const INVISIBLE = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

export function stripInvisibleText(text: string): string {
  return text.replace(INVISIBLE, "");
}

const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\u0007|\u001b\\|$)|[@-Z\\-_])/g;
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Shared capture/serving sanitation. Tabs and newlines remain readable. */
export function sanitizeCapturedText(text: string): string {
  return stripInvisibleText(text.replace(ANSI, "").replace(CONTROLS, ""))
    .replace(/[\u2028\u2029]/g, "\n");
}

/** Opening angle brackets are inert, including unfinished or re-flowed tags. */
export function neutralizeControlTags(text: string): string {
  return text.replace(/</g, "&lt;");
}

/** Cut before patterns run, backing off a token split at the scan boundary. */
export function boundScrubText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const space = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"), cut.lastIndexOf("\t"));
  // An uninterrupted run without credential punctuation is safe to cut. Runs
  // with it are withheld: a URL's closing '@', for example, may lie past the cap.
  let kept = space < 0 ? /[-=:\/%_]/.test(cut) ? "" : cut : cut.slice(0, space);
  // A wrapped key's first line may end just before the partial second line.
  // Withhold that run too rather than exposing a reconstructable prefix.
  if (space >= 0 && /\n[ \t]*$/.test(cut.slice(0, space + 1))) {
    const trimmed = kept.trimEnd();
    const tail = /\S+$/.exec(trimmed);
    if (tail !== null && /[-=:\/%_]/.test(tail[0])) kept = trimmed.slice(0, tail.index);
  }
  return { text: kept.replace(/[\uD800-\uDBFF]$/, ""), truncated: true };
}

/** Percent escapes are decoded for matching only; source offsets remain exact. */
function matchingView(text: string): { text: string; starts: number[]; ends: number[]; removed: Span[] } | undefined {
  if (!/%[0-9a-f]{2}/i.test(text) && stripInvisibleText(text) === text) return undefined;
  const starts: number[] = [], ends: number[] = [], removed: Span[] = [];
  let view = "";
  for (let index = 0; index < text.length;) {
    let char = String.fromCodePoint(text.codePointAt(index)!);
    let consumed = char.length;
    const escape = /^%([0-9a-f]{2})/i.exec(text.slice(index, index + 3));
    if (escape !== null) {
      const byte = parseInt(escape[1]!, 16);
      const bytes = byte < 0x80 ? 1 : byte >= 0xc2 && byte < 0xe0 ? 2 : byte >= 0xe0 && byte < 0xf0 ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0;
      if (bytes > 0) {
        try {
          char = decodeURIComponent(text.slice(index, index + bytes * 3));
          consumed = bytes * 3;
        } catch { /* Malformed encoding remains ordinary captured text. */ }
      }
    }
    if (stripInvisibleText(char) === "") removed.push({ kind: "control", start: index, end: index + consumed });
    else {
      view += char;
      for (let part = 0; part < char.length; part += 1) {
        starts.push(index);
        ends.push(index + consumed);
      }
    }
    index += consumed;
  }
  return { text: view, starts, ends, removed };
}

export function scrubText(
  text: string,
  exactSecrets: readonly string[] = [],
  credentialShapes = true,
  sanitizedRanges: readonly { start: number; end: number }[] = [],
): ScrubbedText {
  const view = matchingView(text);
  const matched = view?.text ?? text;
  const found = credentialShapes ? spans(matched) : [];
  for (const originalSecret of exactSecrets) {
    const secret = matchingView(originalSecret)?.text ?? originalSecret;
    if (secret.length === 0) continue;
    for (let start = matched.indexOf(secret); start !== -1; start = matched.indexOf(secret, start + secret.length)) {
      found.push({ kind: "api_token", start, end: start + secret.length });
    }
  }
  // Decoding may introduce URL delimiters inside encoded userinfo. Preserve
  // matches in both representations, then merge their overlapping spans once.
  const original: Span[] = view === undefined ? found : [
    ...(credentialShapes ? spans(text) : []),
    ...found.map((span) => ({
      ...span, start: view.starts[span.start]!, end: view.ends[span.end - 1]!,
      contextStart: view.starts[span.contextStart ?? span.start]!,
      contextEnd: view.ends[(span.contextEnd ?? span.end) - 1]!,
    })),
  ];
  // Assembly may create a new credential across fields. Only a detector fully
  // contained in one sanitized field is inert, including its name/header.
  const introduced = original.filter((span) => !sanitizedRanges.some((range) =>
    range.start <= (span.contextStart ?? span.start) && range.end >= (span.contextEnd ?? span.end)));
  const kept = disjoint([...introduced, ...(view?.removed ?? [])]);
  if (kept.length === 0) return { text, redactions: [] };
  const redactions: Redaction[] = [];
  let out = "";
  let cursor = 0;
  for (const span of kept) {
    out += text.slice(cursor, span.start);
    const marker = span.kind === "control" ? "" : `[redacted:${span.kind}]`;
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
