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

const PROXIMITY_WINDOW = 10;
const MAX_COHERENCE_PAIRS = 48;
const DOUBLED_CONSONANT = /([bdfgmnprt])\1$/;
const CVC_DOUBLING = /^[a-z][aeiou][bdfgmnprt]$/;
const CVC_SILENT_E = /^[a-z][aeiou][bcdfghjklmnpqrstvz]$/;
const SIBILANT = /(?:[sxz]|ch|sh)$/;

export interface RelaxedQuery {
  /** FTS5 OR expression over the content terms. */
  fts: string;
  /** One FTS5 term expression per distinct content word. */
  terms: string[];
  /** Distinct content terms a candidate must contain. */
  required: number;
  /**
   * Optional per-document coherence filter for partial-coverage hits
   * (`covered.terms < terms.length`): requires either a title match or at
   * least one pair of distinct query terms within `PROXIMITY_WINDOW` tokens.
   */
  coherence: string | null;
}

interface TermSpec {
  expr: string;
  atoms: string[];
}

function words(raw: string): string[] {
  return raw.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [];
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
 * Exact morphological inflections for a 3-letter root, avoiding short-prefix
 * wildcards that over-match unrelated words (e.g. `"cat"*` -> `"category"`).
 */
function shortRootSpec(base: string): TermSpec {
  let forms: string[];
  if (base.endsWith("e")) {
    const stem = base.slice(0, -1);
    forms = [base, `${base}s`, `${base}d`, `${stem}ing`, `${base}r`, `${base}rs`];
  } else if (CVC_DOUBLING.test(base)) {
    const c = base[base.length - 1] as string;
    forms = [base, `${base}s`, `${base}${c}ed`, `${base}${c}ing`, `${base}${c}er`, `${base}${c}ers`];
  } else if (SIBILANT.test(base)) {
    forms = [base, `${base}es`, `${base}ed`, `${base}ing`, `${base}er`, `${base}ers`];
  } else {
    forms = [base, `${base}s`, `${base}ed`, `${base}ing`, `${base}er`, `${base}ers`];
  }
  const atoms = [...new Set(forms)].map((form) => `"${form}"`);
  return { expr: `(${atoms.join(" OR ")})`, atoms };
}

function prefixSpec(stem: string, fallback: string): TermSpec {
  const prefix = stem.length >= 4;
  const atom = `"${prefix ? stem : fallback}"${prefix ? "*" : ""}`;
  return { expr: atom, atoms: [atom] };
}

/**
 * One FTS5 term for a content word. Inflected words match by stem prefix or
 * exact short-root inflection set, so "decide" finds "decided" and "owns"
 * finds "owner" without broadening short roots into unrelated prefixes.
 */
function termSpec(word: string): TermSpec {
  // The noun does not share the verb's stem: a decision note still answers
  // "what did we decide?". Count these variants as one content term.
  if (/^(?:decid(?:e|ed|ing)|decisions?)$/.test(word)) {
    const atoms = ['"decid"*', '"decision"*'];
    return { expr: `(${atoms.join(" OR ")})`, atoms };
  }
  if (!/^[\p{L}\p{M}]+$/u.test(word)) {
    return prefixSpec(word, word);
  }
  // Consonant + ies/ied -> y (e.g. "supplies" -> "suppli"* OR "supply"*).
  if (/[^aeiou]ie[sd]$/.test(word) && word.length >= 6) {
    const stemI = word.slice(0, -2);
    const stemY = `${word.slice(0, -3)}y`;
    const atoms = [`"${stemI}"*`, `"${stemY}"*`];
    return { expr: `(${atoms.join(" OR ")})`, atoms };
  }
  // Progressive and past tense (-ing, -ed): handle doubled consonants and
  // silent-e 3-letter roots as well as 4+ letter stems.
  for (const suffix of ["ing", "ed"] as const) {
    if (!word.endsWith(suffix)) continue;
    const base = word.slice(0, -suffix.length);
    if (DOUBLED_CONSONANT.test(base) && base.length >= 4) {
      const undoubled = base.slice(0, -1);
      return undoubled.length >= 4 ? prefixSpec(undoubled, word) : shortRootSpec(undoubled);
    }
    if (base.length >= 4) {
      const stem = base.endsWith("e") && base.length > 4 ? base.slice(0, -1) : base;
      return prefixSpec(stem, word);
    }
    if (base.length === 3) {
      if (CVC_SILENT_E.test(base)) {
        const atoms = [`"${base}e"*`, `"${base}ing"`];
        return { expr: `(${atoms.join(" OR ")})`, atoms };
      }
      return shortRootSpec(base);
    }
  }
  // Plural / 3rd-person singular (-es, -s).
  if (word.endsWith("es")) {
    const base = word.slice(0, -2);
    if (base.length >= 4) {
      const stem = base.endsWith("e") && base.length > 4 ? base.slice(0, -1) : base;
      return prefixSpec(stem, word);
    }
    if (base.length === 3 && SIBILANT.test(base)) {
      return shortRootSpec(base);
    }
  }
  if (word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) {
    const base = word.slice(0, -1);
    if (base.length >= 4) {
      const stem = base.endsWith("e") && base.length > 4 ? base.slice(0, -1) : base;
      return prefixSpec(stem, word);
    }
    if (base.length === 3) {
      return shortRootSpec(base);
    }
  }
  const stem = word.endsWith("e") && word.length > 4 ? word.slice(0, -1) : word;
  return prefixSpec(stem, word);
}

function coherenceQuery(specs: readonly TermSpec[], fts: string, required: number): string | null {
  if (specs.length < 2 || required >= specs.length) return null;
  const pairs: string[] = [];
  for (let i = 0; i < specs.length; i += 1) {
    for (let j = i + 1; j < specs.length; j += 1) {
      for (const a of specs[i]!.atoms) {
        for (const b of specs[j]!.atoms) {
          pairs.push(`NEAR(${a} ${b}, ${PROXIMITY_WINDOW})`);
          if (pairs.length > MAX_COHERENCE_PAIRS) break;
        }
        if (pairs.length > MAX_COHERENCE_PAIRS) break;
      }
      if (pairs.length > MAX_COHERENCE_PAIRS) break;
    }
    if (pairs.length > MAX_COHERENCE_PAIRS) break;
  }
  if (pairs.length > MAX_COHERENCE_PAIRS) {
    pairs.length = 0;
    for (let i = 0; i < specs.length; i += 1) {
      for (let j = i + 1; j < specs.length; j += 1) {
        pairs.push(`NEAR(${specs[i]!.atoms[0]} ${specs[j]!.atoms[0]}, ${PROXIMITY_WINDOW})`);
      }
    }
  }
  return `title : (${fts}) OR ${pairs.join(" OR ")}`;
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
  const seen = new Set<string>();
  const specs: TermSpec[] = [];
  for (const word of content) {
    const spec = termSpec(word);
    if (seen.has(spec.expr)) continue;
    seen.add(spec.expr);
    specs.push(spec);
  }
  const terms = specs.map((spec) => spec.expr);
  const fts = terms.join(" OR ");
  const required = Math.ceil(terms.length * MIN_TERM_COVERAGE);
  return {
    fts,
    terms,
    required,
    coherence: coherenceQuery(specs, fts, required),
  };
}
