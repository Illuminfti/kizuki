import { compareRfc3339 } from "../../agents/time";
import { rawSubjectRefKey } from "../../contracts/claim-v2";
import { isSingleValuedConflictSpec } from "../../contracts/world-kinds";
import { activeWorldRegistry } from "../../contracts/world-vocabulary";
import { sourceCoverage } from "../coverage";
import type { Enricher } from "../pipeline/enrich";
import type { Relation } from "../../contracts/concept-card";
import { isSingleValuedPredicate } from "../../claims/predicates";

/** Half-open valid intervals; unknown validity cannot prove absence. */
export function validOverlap(a: Relation["valid"], b: Relation["valid"]): boolean | null {
  if (a.kind === "unknown" || b.kind === "unknown") return null;
  return (b.until === null || compareRfc3339(a.from, "from", b.until, "until") < 0) &&
    (a.until === null || compareRfc3339(b.from, "from", a.until, "until") < 0);
}

/**
 * Whether `predicate` is declared single-valued for read-time conflict detection
 * in the active world vocabulary specs (`conflictCardinality: "single"`) or the
 * legacy predicate registry.
 */
export function isSingleValuedWorldPredicate(predicate: string): boolean {
  return isSingleValuedConflictSpec(activeWorldRegistry().spec(predicate)) || isSingleValuedPredicate(predicate);
}

export const conflictEnricher: Enricher = (frame, body) => {
  const complete = !body.overflow && body.gaps.length === 0 && sourceCoverage(frame.ctx).length === 0;
  return { ...body, claims: body.claims.map((claim) => {
    const a = claim.relation;
    let conflict: Relation["conflict"] = complete ? "none_observed" : "unknown";
    for (const other of body.claims) {
      const b = other.relation;
      if (other === claim || a.predicate !== b.predicate || rawSubjectRefKey(claim.eligible.semantic.subject) !== rawSubjectRefKey(other.eligible.semantic.subject)) continue;
      const sameObject = JSON.stringify(a.object) === JSON.stringify(b.object);
      const negatesSameValue = a.polarity !== b.polarity && sameObject;
      const competingValues = a.polarity === "positive" && b.polarity === "positive" &&
        isSingleValuedWorldPredicate(a.predicate) && !sameObject;
      if (!negatesSameValue && !competingValues) continue;
      const overlap = validOverlap(a.valid, b.valid);
      // Claim-v2 unknown validity conservatively overlaps a matching conflict scope.
      if (overlap !== false) { conflict = "present"; break; }
    }
    return { ...claim, relation: { ...a, conflict } };
  }) };
};
