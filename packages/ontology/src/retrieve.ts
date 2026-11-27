import { findConnectingPaths } from "./join-paths";
import type { JoinPath } from "./join-paths";
import type { OntologyStore } from "./store";
import { isOntologySensitivity, normalizeTermKey } from "./types";
import type {
  OntologyMetric,
  OntologyRelation,
  OntologySensitivity,
  OntologyTerm,
} from "./types";

export type OntologyRetrievePurpose =
  | "information"
  | "relations"
  | "metrics"
  | "all";

export interface RetrieveOptions {
  readonly purpose?: OntologyRetrievePurpose | undefined;
  readonly maxChars?: number | undefined;
  readonly fullHits?: number | undefined;
  /**
   * Fail-closed default: `"public"`. Callers with higher authority must pass
   * their explicit ceiling (`"personal"` or `"private"`).
   */
  readonly sensitivityCeiling?: OntologySensitivity | undefined;
  readonly allowedSubjects?: readonly string[] | null | undefined;
  readonly limit?: number | undefined;
  readonly maxJoinHops?: number | undefined;
}

export interface ScoredOntologyTerm {
  readonly term: OntologyTerm;
  readonly score: number;
  readonly tier: "full" | "summary";
}

export interface OntologyRetrieveResult {
  readonly query: string;
  readonly purpose: OntologyRetrievePurpose;
  readonly sensitivityCeiling: OntologySensitivity;
  readonly terms: ScoredOntologyTerm[];
  readonly relations: OntologyRelation[];
  readonly joinPaths: JoinPath[];
  readonly metrics: OntologyMetric[];
  readonly rendered: string;
  readonly truncated: boolean;
  readonly totalChars: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function scoreTermAgainstQuery(term: OntologyTerm, query: string): number {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return 1.0;
  }
  const qLower = trimmed.toLowerCase();
  const qNorm = normalizeTermKey(trimmed);
  const qTokens = tokenize(trimmed);

  if (term.normalizedKey === qNorm || term.canonicalName.toLowerCase() === qLower) {
    return 1.0;
  }
  if (
    term.synonyms.some(
      (s) => s.toLowerCase() === qLower || normalizeTermKey(s) === qNorm,
    )
  ) {
    return 0.95;
  }
  if (term.canonicalName.toLowerCase().includes(qLower)) {
    return 0.88;
  }
  if (term.synonyms.some((s) => s.toLowerCase().includes(qLower))) {
    return 0.84;
  }
  if (term.domain.toLowerCase() === qLower) {
    return 0.8;
  }

  if (qTokens.length === 0) return 0;

  const nameTokens = new Set(tokenize(`${term.canonicalName} ${term.synonyms.join(" ")}`));
  const attrTokens = new Set(
    tokenize(term.attributes.map((a) => `${a.name} ${a.description ?? ""}`).join(" ")),
  );
  const descTokens = new Set(tokenize(`${term.description} ${term.domain} ${term.kind}`));

  let nameHits = 0;
  let attrHits = 0;
  let descHits = 0;
  for (const tok of qTokens) {
    if (nameTokens.has(tok)) nameHits += 1;
    else if (attrTokens.has(tok)) attrHits += 1;
    else if (descTokens.has(tok)) descHits += 1;
  }

  const totalHits = nameHits + attrHits + descHits;
  if (totalHits === 0) return 0;

  const weighted = (nameHits * 1.0 + attrHits * 0.7 + descHits * 0.45) / qTokens.length;
  return Number(Math.min(0.82, weighted).toFixed(4));
}

function scoreMetricAgainstQuery(metric: OntologyMetric, query: string): number {
  const trimmed = query.trim();
  if (trimmed.length === 0) return 1.0;
  const qLower = trimmed.toLowerCase();
  const qNorm = normalizeTermKey(trimmed);
  const nameNorm = normalizeTermKey(metric.name);
  if (nameNorm === qNorm || metric.name.toLowerCase() === qLower) return 1.0;
  if (metric.name.toLowerCase().includes(qLower)) return 0.85;
  const qTokens = tokenize(trimmed);
  if (qTokens.length === 0) return 0;
  const mTokens = new Set(
    tokenize(`${metric.name.replace(/_/g, " ")} ${metric.description} ${metric.grain}`),
  );
  let hits = 0;
  for (const tok of qTokens) {
    if (mTokens.has(tok)) hits += 1;
  }
  return hits === 0 ? 0 : Number((0.75 * (hits / qTokens.length)).toFixed(4));
}

function renderFullTerm(
  term: OntologyTerm,
  relations: readonly OntologyRelation[],
  termMap: ReadonlyMap<string, OntologyTerm>,
): string {
  const lines: string[] = [];
  const familySuffix = term.familyId !== null ? ` family=${term.familyId}` : "";
  lines.push(
    `### ${term.canonicalName} [${term.certification}] (${term.kind}, domain=${term.domain}, sensitivity=${term.sensitivity}${familySuffix})`,
  );
  if (term.description.length > 0) {
    lines.push(`Description: ${term.description}`);
  }
  if (term.synonyms.length > 0) {
    lines.push(`Synonyms: ${term.synonyms.join(", ")}`);
  }
  if (term.attributes.length > 0) {
    const attrText = term.attributes
      .map((a) => {
        const vals =
          a.values !== undefined && a.values.length > 0
            ? `=${a.values.slice(0, 3).join("|")}`
            : "";
        return `${a.name}${vals}`;
      })
      .join(", ");
    lines.push(`Attributes: ${attrText}`);
  }
  const incident = relations.filter(
    (r) => r.sourceTermId === term.termId || r.targetTermId === term.termId,
  );
  if (incident.length > 0) {
    const relText = incident
      .slice(0, 8)
      .map((r) => {
        const defaultTag = r.isDefaultJoin ? "*" : "";
        if (r.sourceTermId === term.termId) {
          const dstName = termMap.get(r.targetTermId)?.canonicalName ?? r.targetTermId;
          return `--[${r.relationKind}${defaultTag}]--> ${dstName} (ev=${r.evidenceCount})`;
        }
        const srcName = termMap.get(r.sourceTermId)?.canonicalName ?? r.sourceTermId;
        return `<--[${r.relationKind}${defaultTag}]-- ${srcName} (ev=${r.evidenceCount})`;
      })
      .join("; ");
    lines.push(`Relations: ${relText}`);
  }
  if (term.provenance.length > 0) {
    lines.push(`Provenance: ${term.provenance.slice(0, 6).join(", ")}`);
  }
  return lines.join("\n");
}

function renderCompactTerm(term: OntologyTerm): string {
  const desc =
    term.description.length > 90
      ? `${term.description.slice(0, 87).trimEnd()}...`
      : term.description;
  const suffix = desc.length > 0 ? `: ${desc}` : "";
  return `- [${term.certification}] ${term.canonicalName} (${term.domain}/${term.kind}, ev=${term.evidenceCount})${suffix}`;
}

function renderMetricLine(metric: OntologyMetric): string {
  return `- [${metric.certification}] ${metric.name} (grain=${metric.grain}): ${metric.description} | expr: ${metric.expression}`;
}

/**
 * Two-tier grounded semantic retrieval over the local SQLite ontology store.
 *
 * Ranks certified matches ahead of draft matches, renders top `fullHits` with
 * full metadata/attributes/relations/provenance and remaining matches as
 * compact 1-line summaries strictly within `maxChars`, plus data-confirmed
 * `joinPaths` connecting returned terms.
 */
export function retrieveOntology(
  store: OntologyStore,
  query: string,
  opts: RetrieveOptions = {},
): OntologyRetrieveResult {
  const purpose: OntologyRetrievePurpose = opts.purpose ?? "all";
  const maxChars = Math.max(64, Math.floor(opts.maxChars ?? 4000));
  const fullHits = Math.max(0, Math.floor(opts.fullHits ?? 2));
  const limit = Math.max(1, Math.floor(opts.limit ?? 20));
  const sensitivityCeiling: OntologySensitivity =
    opts.sensitivityCeiling ?? "public";
  if (!isOntologySensitivity(sensitivityCeiling)) {
    throw new Error(`Invalid sensitivityCeiling: ${String(sensitivityCeiling)}`);
  }

  const scope = {
    sensitivityCeiling,
    allowedSubjects: opts.allowedSubjects,
  };

  const visibleTerms = store.listTerms(scope);
  const visibleRelations = store.listRelations(scope);
  const visibleMetrics = store.listMetrics(scope);

  const termMap = new Map<string, OntologyTerm>();
  for (const t of visibleTerms) termMap.set(t.termId, t);

  // Rank matched terms with certified strictly ahead of draft.
  const matchedTerms = visibleTerms
    .map((term) => ({ term, score: scoreTermAgainstQuery(term, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      const certA = a.term.certification === "certified" ? 0 : 1;
      const certB = b.term.certification === "certified" ? 0 : 1;
      if (certA !== certB) return certA - certB;
      if (a.score !== b.score) return b.score - a.score;
      if (a.term.evidenceCount !== b.term.evidenceCount) {
        return b.term.evidenceCount - a.term.evidenceCount;
      }
      return a.term.normalizedKey.localeCompare(b.term.normalizedKey);
    })
    .slice(0, limit);

  const scoredTerms: ScoredOntologyTerm[] = matchedTerms.map((entry, idx) => ({
    term: entry.term,
    score: entry.score,
    tier: idx < fullHits ? "full" : "summary",
  }));

  const returnedTermIds = scoredTerms.map((s) => s.term.termId);
  const returnedTermIdSet = new Set(returnedTermIds);

  const relevantRelations = visibleRelations.filter(
    (rel) =>
      returnedTermIdSet.has(rel.sourceTermId) ||
      returnedTermIdSet.has(rel.targetTermId),
  );

  const joinPaths = findConnectingPaths(visibleRelations, returnedTermIds, {
    sensitivityCeiling,
    termMap,
    allowedSubjects: opts.allowedSubjects,
    maxHops: opts.maxJoinHops ?? 6,
  });

  // Rank matched metrics with certified ahead of draft.
  const rankedMetrics = visibleMetrics
    .map((metric) => {
      let score = scoreMetricAgainstQuery(metric, query);
      if (metric.termId !== null && returnedTermIdSet.has(metric.termId)) {
        score = Math.max(score, 0.75);
      }
      return { metric, score };
    })
    .filter((entry) =>
      purpose === "metrics" || query.trim().length === 0
        ? entry.score > 0 || query.trim().length === 0
        : entry.score > 0,
    )
    .sort((a, b) => {
      const certA = a.metric.certification === "certified" ? 0 : 1;
      const certB = b.metric.certification === "certified" ? 0 : 1;
      if (certA !== certB) return certA - certB;
      if (a.score !== b.score) return b.score - a.score;
      return a.metric.name.localeCompare(b.metric.name);
    })
    .map((entry) => entry.metric);

  // Assemble two-tier rendered text strictly within `maxChars`.
  const sections: string[] = [];
  const header = `Ontology Retrieval (purpose=${purpose}, ceiling=${sensitivityCeiling}, terms=${scoredTerms.length}, metrics=${rankedMetrics.length})`;
  sections.push(header);

  if (purpose === "information" || purpose === "all") {
    const fullEntries = scoredTerms.filter((s) => s.tier === "full");
    const compactEntries = scoredTerms.filter((s) => s.tier === "summary");

    if (fullEntries.length > 0) {
      sections.push("## Full Terms");
      for (const entry of fullEntries) {
        sections.push(renderFullTerm(entry.term, relevantRelations, termMap));
      }
    }
    if (compactEntries.length > 0) {
      sections.push("## Compact Terms");
      for (const entry of compactEntries) {
        sections.push(renderCompactTerm(entry.term));
      }
    }
  }

  if (purpose === "relations" || purpose === "all") {
    if (joinPaths.length > 0) {
      sections.push("## Join Paths");
      for (const jp of joinPaths) {
        sections.push(
          `- (${jp.hops} hop${jp.hops === 1 ? "" : "s"}, ev=${jp.totalEvidence}) ${jp.pathString}`,
        );
      }
    } else if (purpose === "relations" && relevantRelations.length > 0) {
      sections.push("## Relations");
      for (const rel of relevantRelations.slice(0, 12)) {
        const src = termMap.get(rel.sourceTermId)?.canonicalName ?? rel.sourceTermId;
        const dst = termMap.get(rel.targetTermId)?.canonicalName ?? rel.targetTermId;
        sections.push(
          `- ${src} --[${rel.relationKind}${rel.isDefaultJoin ? "*" : ""}]--> ${dst} (ev=${rel.evidenceCount})`,
        );
      }
    }
  }

  if (purpose === "metrics" || purpose === "all") {
    if (rankedMetrics.length > 0) {
      sections.push("## Metrics");
      for (const metric of rankedMetrics) {
        sections.push(renderMetricLine(metric));
      }
    }
  }

  // Fit sections strictly within `maxChars`.
  let rendered = "";
  let truncated = false;
  for (const chunk of sections) {
    const candidate = rendered.length === 0 ? chunk : `${rendered}\n${chunk}`;
    if (candidate.length <= maxChars) {
      rendered = candidate;
    } else {
      truncated = true;
      const remaining = maxChars - rendered.length;
      if (remaining > 16) {
        const sep = rendered.length === 0 ? "" : "\n";
        const sliceLen = Math.max(0, remaining - sep.length - 3);
        if (sliceLen > 0) {
          rendered = `${rendered}${sep}${chunk.slice(0, sliceLen).trimEnd()}...`;
        }
      }
      break;
    }
  }

  if (rendered.length > maxChars) {
    rendered = rendered.slice(0, Math.max(0, maxChars - 3)) + "...";
    truncated = true;
  }

  return {
    query,
    purpose,
    sensitivityCeiling,
    terms: scoredTerms,
    relations: relevantRelations,
    joinPaths,
    metrics: rankedMetrics,
    rendered,
    truncated,
    totalChars: rendered.length,
  };
}
