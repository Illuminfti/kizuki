/**
 * Question relaxation. FTS5 ANDs every token, so "what did we decide about the
 * launch" needs a page that literally contains "what", "did" and "the". A
 * question-shaped query that finds almost nothing literally is retried as an
 * OR of its content words; the caller then keeps only candidates that carry
 * enough of them, which is what lets an unanswerable question return nothing.
 */

/** A literal query with fewer matches than this is retried relaxed. */
export const RELAX_BELOW_MATCHES = 3;
const MIN_QUESTION_WORDS = 3;
const MAX_CONTENT_TERMS = 12;
/** Share of the distinct content terms a relaxed candidate must contain. */
const MIN_TERM_COVERAGE = 0.6;

const STOPWORDS = new Set(
  (
    "a an the and or but if of to in on at by for with about from into over after before during as " +
    "is are was were be been being am do does did done doing have has had having " +
    "i me my we our us you your he she it its they them their this that these those there here " +
    "what which who whom whose when where why how can could should would will shall may might must " +
    "not no yes than then so just also very any some all each other such " +
    "tell please give show find list explain"
  ).split(" "),
);

const QUESTION_LEAD =
  /^(what|whats|who|whom|whose|when|where|why|how|which|did|does|do|is|are|was|were|can|could|should|would|will|has|have|had|tell|find|show|list|explain|give)$/;

const INFLECTIONS = ["ing", "ed", "es", "s"] as const;

export interface RelaxedQuery {
  /** FTS5 OR expression over the content terms. */
  fts: string;
  /** One FTS5 term expression per distinct content word. */
  terms: string[];
  /** Distinct content terms a candidate must contain. */
  required: number;
}

function words(raw: string): string[] {
  return raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** True for a bare question or instruction of three or more words. */
export function isQuestionQuery(raw: string): boolean {
  // A quote or wildcard is the caller asking for the literal query.
  if (/["*]/.test(raw)) return false;
  const spoken = words(raw);
  if (spoken.length < MIN_QUESTION_WORDS) return false;
  return raw.trimEnd().endsWith("?") || QUESTION_LEAD.test(spoken[0] as string);
}

/**
 * One FTS5 term for a content word. Inflected words match by stem prefix, so
 * "decide" also finds "decided" and "deciding"; short words stay exact.
 */
function termExpression(word: string): string {
  // The noun does not share the verb's stem: a decision note still answers
  // "what did we decide?". Count these variants as one content term.
  if (/^(?:decid(?:e|ed|ing)|decisions?)$/.test(word)) {
    return '("decid"* OR "decision"*)';
  }
  let stem = word;
  if (/^\p{L}+$/u.test(word)) {
    for (const suffix of INFLECTIONS) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
        stem = word.slice(0, -suffix.length);
        break;
      }
    }
    if (stem.endsWith("e") && stem.length > 4) stem = stem.slice(0, -1);
  }
  const prefix = stem.length >= 4;
  return `"${prefix ? stem : word}"${prefix ? "*" : ""}`;
}

/**
 * The relaxed form of a question-shaped query, or null when the query is not
 * a question, carries no content word, or asks for a literal match.
 */
export function toRelaxedFtsQuery(raw: string): RelaxedQuery | null {
  if (!isQuestionQuery(raw)) return null;
  const content = [
    ...new Set(words(raw).filter((word) => word.length > 1 && !STOPWORDS.has(word))),
  ];
  // Do not turn a long, specific question into an unrelated broad prefix.
  if (content.length === 0 || content.length > MAX_CONTENT_TERMS) return null;
  const terms = [...new Set(content.map(termExpression))];
  return {
    fts: terms.join(" OR "),
    terms,
    required: Math.ceil(terms.length * MIN_TERM_COVERAGE),
  };
}
