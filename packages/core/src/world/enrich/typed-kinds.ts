import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import type { CardBody, Enricher } from "../pipeline/enrich";

export interface KindQualificationSummary {
  readonly kind: string | null;
  readonly vocabularyId: string | null;
  readonly qualified: boolean;
  readonly claimCount: number;
  readonly conflictCount: number;
  readonly independentAssessments: number;
  readonly dependentAssessments: number;
  readonly requiresSuppliedSubject: boolean;
  readonly suppliedSubjectValid: boolean;
}

/**
 * Inspects an enriched `CardBody` for kind-level epistemic qualification across
 * all ten world kinds without mutating or reordering claims.
 */
export function summarizeKindQualification(body: CardBody): KindQualificationSummary {
  const classification = body.claims.find(({ eligible: e }) =>
    e.semantic.predicate === "world.kind" &&
    e.semantic.polarity === "positive" &&
    e.semantic.perspective.mode === "asserted" &&
    e.semantic.object.kind === "vocabulary");
  const vocabularyId = classification?.eligible.semantic.object.kind === "vocabulary"
    ? classification.eligible.semantic.object.ref.id
    : null;
  const spec = vocabularyId === null ? undefined : activeWorldRegistry().kindByVocabularyId(vocabularyId);
  const kind = spec?.id ?? null;
  let conflictCount = 0;
  let independentAssessments = 0;
  let dependentAssessments = 0;
  for (const { relation } of body.claims) {
    if (relation.conflict === "present") conflictCount += 1;
    for (const assessment of relation.assessments) {
      if (assessment.independence === "independent") independentAssessments += 1;
      else if (assessment.independence === "dependent") dependentAssessments += 1;
    }
  }
  const requiresSuppliedSubject = kind === "person";
  const suppliedSubjectValid = !requiresSuppliedSubject ||
    classification?.eligible.semantic.subject.kind === "supplied";
  return {
    kind,
    vocabularyId,
    qualified: kind !== null && suppliedSubjectValid,
    claimCount: body.claims.length,
    conflictCount,
    independentAssessments,
    dependentAssessments,
    requiresSuppliedSubject,
    suppliedSubjectValid,
  };
}

/**
 * Pipeline-compatible qualification enricher across all ten world kinds.
 * Preserves claim order and count strictly while enforcing person grounding
 * invariants on already-collected card bodies.
 */
export const kindQualificationEnricher: Enricher = (_frame, body) => {
  const summary = summarizeKindQualification(body);
  if (summary.requiresSuppliedSubject && !summary.suppliedSubjectValid && !body.gaps.includes("coverage")) {
    return { ...body, gaps: [...body.gaps, "coverage"] };
  }
  return body;
};
