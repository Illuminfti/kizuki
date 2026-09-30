import { supportLineage } from "../lineage";
import type { Enricher } from "../pipeline/enrich";

export const independenceEnricher: Enricher = (frame, body) => {
  const byPredicate = new Map<string, ReturnType<typeof supportLineage>>();
  for (const predicate of new Set(body.claims.map((claim) => claim.relation.predicate))) {
    byPredicate.set(predicate, supportLineage(frame, body.claims.filter((claim) => claim.relation.predicate === predicate).flatMap((claim) => claim.eligible.supports)));
  }
  return { ...body, claims: body.claims.map((claim) => {
    const lineage = byPredicate.get(claim.relation.predicate)!;
    return { ...claim, relation: { ...claim.relation, assessments: claim.relation.assessments.map((assessment, i) => ({
      ...assessment, independence: lineage.independence.get(claim.eligible.supports[i]!.row.support_key) ?? "unknown",
    })) } };
  }) };
};
