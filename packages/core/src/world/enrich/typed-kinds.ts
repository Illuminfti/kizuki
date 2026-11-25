import type { Enricher } from "../pipeline/enrich";

/**
 * Pipeline enricher enforcing read-time kind grounding invariants across all
 * ten world kinds without mutating or reordering claims. Specifically guards
 * restored or legacy person classifications whose subject is not a structured
 * supplied endpoint by marking coverage incomplete.
 */
export const kindQualificationEnricher: Enricher = (_frame, body) => {
  const personClassification = body.claims.find(({ eligible: e }) =>
    e.semantic.predicate === "world.kind" &&
    e.semantic.polarity === "positive" &&
    e.semantic.perspective.mode === "asserted" &&
    e.semantic.object.kind === "vocabulary" &&
    e.semantic.object.ref.id === "world/person");
  if (
    personClassification !== undefined &&
    personClassification.eligible.semantic.subject.kind !== "supplied" &&
    !body.gaps.includes("coverage")
  ) {
    return { ...body, gaps: [...body.gaps, "coverage"] };
  }
  return body;
};
