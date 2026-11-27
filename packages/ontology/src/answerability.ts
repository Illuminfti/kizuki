import { findConnectingPaths } from "./join-paths";
import type { JoinPath } from "./join-paths";
import type { OntologyStore } from "./store";
import {
  isOntologySensitivity,
  normalizeTermKey,
} from "./types";
import type {
  OntologyCertification,
  OntologyMetric,
  OntologySensitivity,
  OntologyTerm,
  OntologyTermFamily,
} from "./types";

export type AnswerabilityVerdict = "answerable" | "partial" | "unanswerable";

export type ConceptMatchKind =
  | "exact_canonical"
  | "exact_synonym"
  | "family_prefix"
  | "token_overlap"
  | "metric_match";

export interface ResolvedOntologyConcept {
  readonly queryConcept: string;
  readonly termId: string;
  readonly canonicalName: string;
  readonly matchedBy: ConceptMatchKind;
  readonly certification: OntologyCertification;
  readonly score: number;
  readonly domain: string;
  readonly sensitivity: OntologySensitivity;
}

export interface OntologyCoverageReport {
  readonly question: string;
  readonly sensitivityCeiling: OntologySensitivity;
  readonly candidates: string[];
  readonly coverage: number;
  readonly verdict: AnswerabilityVerdict;
  readonly resolved: ResolvedOntologyConcept[];
  readonly missing: string[];
  readonly joinPaths: JoinPath[];
  readonly suggestedMetrics: OntologyMetric[];
  readonly clarification: string | null;
}

export interface AnswerabilityOptions {
  /**
   * Fail-closed default: `"public"`. Callers acting for a privileged owner or
   * scoped agent must pass their explicit grant ceiling.
   */
  readonly sensitivityCeiling?: OntologySensitivity | undefined;
  readonly allowedSubjects?: readonly string[] | null | undefined;
  readonly maxJoinHops?: number | undefined;
  readonly minTokenOverlap?: number | undefined;
}

const QUESTION_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "above",
  "across",
  "after",
  "all",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "between",
  "both",
  "but",
  "by",
  "can",
  "check",
  "compare",
  "connected",
  "connects",
  "could",
  "count",
  "current",
  "currently",
  "describe",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "during",
  "each",
  "explain",
  "find",
  "for",
  "from",
  "get",
  "give",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "include",
  "into",
  "is",
  "it",
  "its",
  "know",
  "last",
  "link",
  "linked",
  "links",
  "list",
  "many",
  "may",
  "me",
  "might",
  "more",
  "most",
  "much",
  "my",
  "need",
  "no",
  "not",
  "now",
  "number",
  "of",
  "on",
  "one",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "please",
  "relate",
  "related",
  "relates",
  "relationship",
  "relationships",
  "same",
  "see",
  "she",
  "should",
  "show",
  "some",
  "status",
  "still",
  "such",
  "summarize",
  "summary",
  "tell",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "today",
  "total",
  "under",
  "up",
  "us",
  "use",
  "used",
  "using",
  "value",
  "values",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "within",
  "without",
  "work",
  "works",
  "would",
  "you",
  "your",
]);

function tokenizeForMatching(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length > 0 && !QUESTION_STOPWORDS.has(tok));
}

function tokenOverlapScore(queryTokens: readonly string[], targetTokens: readonly string[]): number {
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0;
  const qSet = new Set(queryTokens);
  const tSet = new Set(targetTokens);
  let hits = 0;
  for (const tok of qSet) {
    if (tSet.has(tok)) hits += 1;
  }
  if (hits === 0) return 0;
  const containment = hits / Math.min(qSet.size, tSet.size);
  const jaccard = hits / (qSet.size + tSet.size - hits);
  return 0.6 * containment + 0.4 * jaccard;
}

interface TextSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function spansOverlap(a: TextSpan, b: TextSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

function findPhraseOccurrences(haystackLower: string, phraseLower: string): Array<[number, number]> {
  const results: Array<[number, number]> = [];
  if (phraseLower.length < 2) return results;
  let fromIndex = 0;
  while (fromIndex < haystackLower.length) {
    const idx = haystackLower.indexOf(phraseLower, fromIndex);
    if (idx === -1) break;
    const before = idx > 0 ? haystackLower[idx - 1] ?? " " : " ";
    const after =
      idx + phraseLower.length < haystackLower.length
        ? haystackLower[idx + phraseLower.length] ?? " "
        : " ";
    const boundaryBefore = !/[a-z0-9_]/.test(before);
    const boundaryAfter = !/[a-z0-9_]/.test(after);
    if (boundaryBefore && boundaryAfter) {
      results.push([idx, idx + phraseLower.length]);
    }
    fromIndex = idx + phraseLower.length;
  }
  return results;
}

/**
 * Extracts candidate semantic concepts from a natural-language question:
 * 1. Quoted phrases (`"..."` or `'...'`).
 * 2. Longest visible known ontology phrases (strictly from already-scoped
 *    visible terms/metrics so restricted entries can never leak).
 * 3. Technical identifiers (`OLD_ROOMS`, `person:ada`, `v2_billing`, `camelCase`).
 * 4. Capitalized entity phrases (`Project Apollo`, `Ada Lovelace`).
 * 5. Remaining meaningful non-stopword content phrases/unigrams.
 */
export function extractQuestionConcepts(
  question: string,
  visibleLexicon: readonly string[] = [],
): string[] {
  const trimmed = question.trim();
  if (trimmed.length === 0) return [];

  const chosenSpans: TextSpan[] = [];
  const addSpanIfFree = (start: number, end: number, rawText: string): void => {
    const cleaned = rawText.trim().replace(/^["'`.,;:!?()[\]]+|["'`.,;:!?()[\]]+$/g, "");
    if (cleaned.length < 2) return;
    const lower = cleaned.toLowerCase();
    if (QUESTION_STOPWORDS.has(lower)) return;
    const candidate: TextSpan = { start, end, text: cleaned };
    for (const existing of chosenSpans) {
      if (spansOverlap(existing, candidate)) return;
    }
    chosenSpans.push(candidate);
  };

  // 1. Quoted phrases
  const quoteRe = /"([^"]{2,})"|'([^']{2,})'/g;
  for (const match of trimmed.matchAll(quoteRe)) {
    const inner = match[1] ?? match[2];
    if (inner !== undefined && match.index !== undefined) {
      addSpanIfFree(match.index, match.index + match[0].length, inner);
    }
  }

  // 2. Visible lexicon longest-match scan (canonical names, synonyms, metrics)
  const lowerQuestion = trimmed.toLowerCase();
  const sortedLexicon = [...new Set(visibleLexicon)]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2 && !QUESTION_STOPWORDS.has(entry.toLowerCase()))
    .sort((a, b) => b.length - a.length);

  for (const phrase of sortedLexicon) {
    const phraseLower = phrase.toLowerCase();
    for (const [start, end] of findPhraseOccurrences(lowerQuestion, phraseLower)) {
      addSpanIfFree(start, end, trimmed.slice(start, end));
    }
  }

  // 3. Technical identifiers (underscores, colons, digits, internal camelCase)
  const techRe = /\b[A-Za-z][A-Za-z0-9]*(?:[_:-][A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;
  for (const match of trimmed.matchAll(techRe)) {
    if (match.index !== undefined) {
      addSpanIfFree(match.index, match.index + match[0].length, match[0]);
    }
  }

  // 4. Capitalized multi-word entity phrases (ignoring sentence-leading stopword)
  const capPhraseRe = /\b([A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)+)\b/g;
  for (const match of trimmed.matchAll(capPhraseRe)) {
    const full = match[1];
    if (full === undefined || match.index === undefined) continue;
    const words = full.split(/\s+/);
    let offset = 0;
    while (words.length > 1) {
      const head = words[0];
      if (head !== undefined && QUESTION_STOPWORDS.has(head.toLowerCase())) {
        offset += head.length + 1;
        words.shift();
      } else {
        break;
      }
    }
    const candidate = words.join(" ");
    if (candidate.length >= 2) {
      addSpanIfFree(
        match.index + offset,
        match.index + offset + candidate.length,
        candidate,
      );
    }
  }

  // 5. Remaining meaningful content words (unmatched spans)
  const wordRe = /[A-Za-z0-9][A-Za-z0-9_-]*/g;
  for (const match of trimmed.matchAll(wordRe)) {
    const word = match[0];
    if (match.index === undefined) continue;
    if (word.length < 2) continue;
    if (QUESTION_STOPWORDS.has(word.toLowerCase())) continue;
    if (/^\d+$/.test(word)) continue;
    addSpanIfFree(match.index, match.index + word.length, word);
  }

  chosenSpans.sort((a, b) => a.start - b.start);

  // Deduplicate by normalized key while keeping original order.
  const seenKeys = new Set<string>();
  const concepts: string[] = [];
  for (const span of chosenSpans) {
    const norm = normalizeTermKey(span.text);
    if (norm.length === 0 || seenKeys.has(norm)) continue;
    seenKeys.add(norm);
    concepts.push(span.text);
  }
  return concepts;
}

interface CandidateResolution {
  readonly term?: OntologyTerm | undefined;
  readonly metric?: OntologyMetric | undefined;
  readonly matchedBy: ConceptMatchKind;
  readonly score: number;
}

function resolveConcept(
  concept: string,
  terms: readonly OntologyTerm[],
  metrics: readonly OntologyMetric[],
  familiesById: ReadonlyMap<string, OntologyTermFamily>,
  minTokenOverlap: number,
): CandidateResolution | null {
  const normConcept = normalizeTermKey(concept);
  const conceptLower = concept.trim().toLowerCase();
  const conceptTokens = tokenizeForMatching(concept);

  let best: CandidateResolution | null = null;
  const consider = (candidate: CandidateResolution): void => {
    if (best === null) {
      best = candidate;
      return;
    }
    if (candidate.score !== best.score) {
      if (candidate.score > best.score) best = candidate;
      return;
    }
    // Tie-break: prefer certified terms over draft terms.
    const candCert =
      (candidate.term?.certification ?? candidate.metric?.certification) ===
      "certified"
        ? 1
        : 0;
    const bestCert =
      (best.term?.certification ?? best.metric?.certification) === "certified"
        ? 1
        : 0;
    if (candCert !== bestCert) {
      if (candCert > bestCert) best = candidate;
      return;
    }
    const candEv = candidate.term?.evidenceCount ?? 0;
    const bestEv = best.term?.evidenceCount ?? 0;
    if (candEv > bestEv) best = candidate;
  };

  for (const term of terms) {
    if (
      term.normalizedKey === normConcept ||
      term.canonicalName.toLowerCase() === conceptLower
    ) {
      consider({ term, matchedBy: "exact_canonical", score: 1.0 });
      continue;
    }

    const synonymHit = term.synonyms.some(
      (syn) =>
        syn.toLowerCase() === conceptLower || normalizeTermKey(syn) === normConcept,
    );
    if (synonymHit) {
      consider({ term, matchedBy: "exact_synonym", score: 0.95 });
      continue;
    }

    if (term.familyId !== null) {
      const family = familiesById.get(term.familyId);
      if (family !== undefined) {
        const baseName = family.members[term.termId];
        if (
          family.prefix.toLowerCase() === conceptLower ||
          (baseName !== undefined &&
            normalizeTermKey(baseName) === normConcept)
        ) {
          consider({ term, matchedBy: "family_prefix", score: 0.85 });
          continue;
        }
      }
    }

    const termTokens = tokenizeForMatching(
      [term.canonicalName, ...term.synonyms, term.domain].join(" "),
    );
    const overlap = tokenOverlapScore(conceptTokens, termTokens);
    if (overlap >= minTokenOverlap) {
      consider({
        term,
        matchedBy: "token_overlap",
        score: Number((0.5 + 0.34 * overlap).toFixed(4)),
      });
    }
  }

  for (const metric of metrics) {
    const metricNorm = normalizeTermKey(metric.name);
    if (metricNorm === normConcept || metric.name.toLowerCase() === conceptLower) {
      consider({ metric, matchedBy: "metric_match", score: 0.96 });
      continue;
    }
    const metricTokens = tokenizeForMatching(
      `${metric.name.replace(/_/g, " ")} ${metric.description}`,
    );
    const overlap = tokenOverlapScore(conceptTokens, metricTokens);
    if (overlap >= Math.max(minTokenOverlap, 0.6)) {
      consider({
        metric,
        matchedBy: "metric_match",
        score: Number((0.5 + 0.3 * overlap).toFixed(4)),
      });
    }
  }

  return best;
}

/**
 * Pre-flight answerability and semantic coverage grader.
 *
 * Extracts semantic concepts from `question`, resolves them against compiled
 * terms and metrics strictly within `sensitivityCeiling` (fail-closed default:
 * `"public"`) and optional `allowedSubjects`, finds data-confirmed join paths
 * connecting resolved terms, and generates an actionable clarification prompt
 * whenever coverage is below 1.0.
 */
export function checkAnswerable(
  store: OntologyStore,
  question: string,
  opts: AnswerabilityOptions = {},
): OntologyCoverageReport {
  const sensitivityCeiling: OntologySensitivity =
    opts.sensitivityCeiling ?? "public";
  if (!isOntologySensitivity(sensitivityCeiling)) {
    throw new Error(`Invalid sensitivityCeiling: ${String(sensitivityCeiling)}`);
  }
  const minTokenOverlap = opts.minTokenOverlap ?? 0.5;
  const scope = {
    sensitivityCeiling,
    allowedSubjects: opts.allowedSubjects,
  };

  // Load strictly scoped visible ontology elements (fail-closed!).
  const visibleTerms = store.listTerms(scope);
  const visibleMetrics = store.listMetrics(scope);
  const visibleRelations = store.listRelations(scope);
  const termMap = new Map<string, OntologyTerm>();
  const lexicon: string[] = [];

  for (const term of visibleTerms) {
    termMap.set(term.termId, term);
    lexicon.push(term.canonicalName);
    for (const syn of term.synonyms) lexicon.push(syn);
  }
  for (const metric of visibleMetrics) {
    lexicon.push(metric.name);
    lexicon.push(metric.name.replace(/_/g, " "));
  }

  const familiesById = new Map<string, OntologyTermFamily>();
  for (const fam of store.listTermFamilies()) {
    familiesById.set(fam.familyId, fam);
  }

  const candidates = extractQuestionConcepts(question, lexicon);
  const resolved: ResolvedOntologyConcept[] = [];
  const missing: string[] = [];
  const suggestedMetricsById = new Map<string, OntologyMetric>();

  for (const concept of candidates) {
    const match = resolveConcept(
      concept,
      visibleTerms,
      visibleMetrics,
      familiesById,
      minTokenOverlap,
    );
    if (match === null) {
      missing.push(concept);
      continue;
    }

    if (match.term !== undefined) {
      resolved.push({
        queryConcept: concept,
        termId: match.term.termId,
        canonicalName: match.term.canonicalName,
        matchedBy: match.matchedBy,
        certification: match.term.certification,
        score: match.score,
        domain: match.term.domain,
        sensitivity: match.term.sensitivity,
      });
    } else if (match.metric !== undefined) {
      suggestedMetricsById.set(match.metric.metricId, match.metric);
      resolved.push({
        queryConcept: concept,
        termId: match.metric.termId ?? match.metric.metricId,
        canonicalName: match.metric.name,
        matchedBy: "metric_match",
        certification: match.metric.certification,
        score: match.score,
        domain: match.metric.grain,
        sensitivity: match.metric.sensitivity,
      });
    }
  }

  // Suggest metrics attached to resolved terms or matching question tokens.
  const resolvedTermIds = [
    ...new Set(
      resolved
        .filter((r) => termMap.has(r.termId))
        .map((r) => r.termId),
    ),
  ];
  const questionTokens = tokenizeForMatching(question);
  for (const metric of visibleMetrics) {
    if (metric.termId !== null && resolvedTermIds.includes(metric.termId)) {
      suggestedMetricsById.set(metric.metricId, metric);
      continue;
    }
    const metricTokens = tokenizeForMatching(metric.name.replace(/_/g, " "));
    if (tokenOverlapScore(questionTokens, metricTokens) >= 0.5) {
      suggestedMetricsById.set(metric.metricId, metric);
    }
  }

  const joinPaths = findConnectingPaths(visibleRelations, resolvedTermIds, {
    sensitivityCeiling,
    termMap,
    allowedSubjects: opts.allowedSubjects,
    maxHops: opts.maxJoinHops ?? 6,
  });

  const coverage =
    candidates.length === 0
      ? 0
      : Number((resolved.length / candidates.length).toFixed(4));

  const verdict: AnswerabilityVerdict =
    candidates.length > 0 && coverage >= 0.85
      ? "answerable"
      : coverage > 0
        ? "partial"
        : "unanswerable";

  let clarification: string | null = null;
  if (candidates.length === 0) {
    clarification =
      "No domain concepts were detected in the question. Specify the entity, project, or metric you want to inspect.";
  } else if (coverage < 1.0) {
    const missingList = missing.map((m) => `"${m}"`).join(", ");
    if (resolved.length === 0) {
      clarification = `None of the requested concepts (${missingList}) exist in the visible ontology at sensitivity ceiling "${sensitivityCeiling}". Confirm the term names, certify synonyms, or broaden scope.`;
    } else {
      const knownList = resolved.map((r) => r.canonicalName).join(", ");
      clarification = `Found ${knownList}, but could not resolve ${missingList} in the visible ontology at sensitivity ceiling "${sensitivityCeiling}". Clarify or map these terms before answering.`;
    }
  }

  return {
    question,
    sensitivityCeiling,
    candidates,
    coverage,
    verdict,
    resolved,
    missing,
    joinPaths,
    suggestedMetrics: [...suggestedMetricsById.values()],
    clarification,
  };
}
