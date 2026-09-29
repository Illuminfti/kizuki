/**
 * Transcript text is attacker-controlled and the ledger is append-only, so
 * every string is made inert and scrubbed of secrets before it is emitted.
 */

export const MAX_TEXT_BYTES = 32 * 1024;
/**
 * Redaction cost is bounded by cutting text here before any pattern runs. The
 * final cut is 32 KiB, so this leaves room for redaction to shorten the text.
 */
export const MAX_SCAN_CHARS = 128 * 1024;

const ANSI =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]{0,256}(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const BIDI = new RegExp(String.raw`[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]`, "g");
/** Zero-width characters split tokens past the patterns; tag characters hide ASCII. */
const INVISIBLE = new RegExp(String.raw`[\u200b-\u200d\u2060\ufeff\u{e0000}-\u{e007f}]`, "gu");
const LINE_SEPARATORS = new RegExp(String.raw`[\u2028\u2029]`, "g");

const LONE_SURROGATE = new RegExp(
  String.raw`[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]`,
  "g",
);

const ANY_SURROGATE = new RegExp(String.raw`[\ud800-\udfff]`);

/** Replaces unpaired surrogates, which no UTF-8 encoding can carry. */
export function wellFormed(text: string): string {
  // The pairing check is slow on megabytes and almost never needed.
  return ANY_SURROGATE.test(text) ? text.replace(LONE_SURROGATE, "\ufffd") : text;
}

export interface Sanitized {
  text: string;
  changed: boolean;
}

/** Drops terminal escapes, control characters, bidi controls and invisible characters. */
export function sanitize(input: string): Sanitized {
  const text = wellFormed(
    input
      .replace(ANSI, "")
      .replace(CONTROLS, "")
      .replace(BIDI, "")
      .replace(INVISIBLE, "")
      .replace(LINE_SEPARATORS, "\n"),
  );
  return { text, changed: text !== input };
}

export type Redactions = Record<string, number>;

const NOT_A_VALUE = /^(?:\$|\[redacted:)/;

/** A pattern with a substring the text must hold before the pattern is worth running. */
const PATTERNS: readonly (readonly [kind: string, pattern: RegExp, needs?: string])[] = [
  [
    "pem",
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  ],
  [
    "authorization",
    /\bAuthorization\s*[:=]\s*(?:(?:Bearer|Basic|Token)\s+)?[^\s"',;]+/gi,
  ],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,}/g, "eyJ"],
  ["sk", /\bsk-[A-Za-z0-9_-]{20,}/g],
  ["github", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["slack", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["aws", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["url_credentials", /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g, "://"],
];

/**
 * `NAME=value` and `"name": "value"` for names that say secret, token,
 * password, key or credential. An unquoted `:` value must contain a digit so
 * prose such as `token: string` survives.
 */
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]{0,48}(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]{0,48})(["']?[ \t]*[=:][ \t]*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;)\]}]{6,})/gi;

const SECRET_WORD = /secret|token|passw|api[_-]?key|private[_-]?key|credential/i;

/**
 * Cuts to `MAX_SCAN_CHARS`, then back to the last whitespace so a secret cut
 * in half at the boundary does not survive as an unredacted prefix.
 */
export function boundScan(input: string): { text: string; truncated: boolean } {
  if (input.length <= MAX_SCAN_CHARS) return { text: input, truncated: false };
  const cut = input.slice(0, MAX_SCAN_CHARS);
  const space = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"), cut.lastIndexOf("\t"));
  const kept = space > MAX_SCAN_CHARS - 4096 ? cut.slice(0, space) : cut.slice(0, MAX_SCAN_CHARS - 4096);
  return { text: wellFormed(kept), truncated: true };
}

/** Every pattern is linear or bounded, and the input is cut first, so cost does not grow with line size. */
export function redact(input: string): { text: string; redactions: Redactions } {
  const redactions: Redactions = {};
  const count = (kind: string): string => {
    redactions[kind] = (redactions[kind] ?? 0) + 1;
    return `[redacted:${kind}]`;
  };
  let text = boundScan(input).text;
  for (const [kind, pattern, needs] of PATTERNS) {
    if (needs === undefined || text.includes(needs)) text = text.replace(pattern, () => count(kind));
  }
  if (SECRET_WORD.test(text)) {
    text = text.replace(ASSIGNMENT, (match, name: string, separator: string, value: string) => {
      if (NOT_A_VALUE.test(value)) return match;
      const quoted = value.startsWith('"') || value.startsWith("'");
      if (!quoted && separator.includes(":") && !/\d/.test(value)) return match;
      return `${name}${separator}${count("assignment")}`;
    });
  }
  return { text, redactions };
}

/** Cuts at a UTF-8 byte bound without splitting a character. */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  const cut = bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
  return { text: cut, truncated: true };
}
