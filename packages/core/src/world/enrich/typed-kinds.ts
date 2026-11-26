import type { Enricher } from "../pipeline/enrich";

/**
 * Read-time grounding guard for `world/person` cards: when a restored or legacy
 * person classification has a non-supplied subject, `personStatements` skips
 * perspective and context collection, so this enricher records a `coverage` gap
 * without mutating or reordering claims.
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
