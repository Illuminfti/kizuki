import { rawSubjectNamespace, rawSubjectRefKey } from "../../contracts/claim-v2";
import type { ConceptLearning, Relation } from "../../contracts/concept-card";
import { authorizedClaimSql, authorizedSupportSql, validMeaningSql } from "../policy-sql";
import { verifyClaim } from "../pipeline/collect";
import { enrich, type Enricher } from "../pipeline/enrich";
import { claimVisibleSql } from "../pipeline/frame";
import { conflictEnricher, validOverlap } from "./conflict";
import { independenceEnricher } from "./independence";

/** Assistance is separate evidence about the exact actor and task, never a mastery upgrade. */
export const assistanceEnricher: Enricher = (frame, body) => {
  const facets = body.claims.filter(({ relation: r }) => /^learning\.(exposure|explanation|application|demonstration)$/.test(r.predicate));
  if (facets.length === 0) return { ...body, learning: [] };
  const permitted = authorizedSupportSql(frame.ctx), claim = authorizedClaimSql(frame.ctx), time = validMeaningSql(frame.valid);
  const candidates = frame.ctx.db.query<{ claim_id: string }, (string | number)[]>(
    `SELECT c.claim_id FROM claim_v2_semantics c JOIN claims base USING(claim_id)
     WHERE c.discriminator='assertion' AND c.predicate='learning.assistance'
       AND ${claimVisibleSql(frame, "base")} AND ${claim.sql} AND ${time.sql}
       AND EXISTS(SELECT 1 FROM json_each(?) task WHERE c.subject_kind=json_extract(task.value,'$.kind')
         AND c.subject_id=json_extract(task.value,'$.id') AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=json_extract(task.value,'$.namespace'))
       AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
     ORDER BY c.claim_id LIMIT 129`,
  ).all(...claim.bindings, ...time.bindings, JSON.stringify(facets.flatMap(({ eligible }) => eligible.semantic.context.map((ref) => ({ kind: ref.kind, id: ref.id, namespace: rawSubjectNamespace(ref) })))), ...permitted.bindings);
  frame.stats.rowsExamined += candidates.length;
  const overflow = candidates.length > 128;
  const eligible = candidates.slice(0, 128).flatMap((row) => { const item = verifyClaim(frame, row.claim_id); return item ? [item] : []; });
  const qualified = enrich(frame, eligible, [independenceEnricher], overflow);
  const learning: ConceptLearning[] = facets.map((facet) => {
    const actor = rawSubjectRefKey(facet.eligible.semantic.subject);
    const tasks = new Set(facet.eligible.semantic.context.map(rawSubjectRefKey));
    const related = qualified.claims.filter((candidate) => {
      const semantic = candidate.eligible.semantic;
      return tasks.has(rawSubjectRefKey(semantic.subject)) &&
        (semantic.context.some((ref) => rawSubjectRefKey(ref) === actor) ||
          [semantic.perspective.holder, semantic.perspective.speaker].some((ref) => ref !== null && rawSubjectRefKey(ref) === actor)) &&
        validOverlap(facet.relation.valid, candidate.relation.valid) !== false;
    });
    // Qualify conflicts within the displayed actor/task basis, so a different
    // actor's assistance does not become a contradiction about this actor.
    const evidence = conflictEnricher(frame, { ...qualified, claims: related }).claims.map((candidate) => candidate.relation);
    const values = new Set(evidence.filter((r) => r.polarity === "positive" && r.perspective.mode === "asserted" && r.object.kind === "vocabulary")
      .map((r) => r.object.kind === "vocabulary" ? r.object.id : ""));
    const uncertain = overflow || facet.relation.valid.kind === "unknown" || evidence.some((r) => r.valid.kind === "unknown" || r.polarity === "negative" || r.perspective.mode !== "asserted" || r.conflict === "present");
    const assistance: ConceptLearning["assistance"] = uncertain || values.size !== 1 ? "unknown" :
      values.has("learning/assisted") ? "assisted" : values.has("learning/unassisted") ? "unassisted" : "unknown";
    return { facet: facet.relation.predicate.slice(9) as ConceptLearning["facet"], assertion: facet.relation, assistance, assistanceEvidence: evidence };
  });
  return { ...body, learning, gaps: [...new Set([...body.gaps, ...(overflow ? ["traversal_limit" as const] : [])])] };
};
