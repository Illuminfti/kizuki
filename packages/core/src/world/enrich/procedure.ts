import { sha256Hex } from "../../util/hash";
import { rawSubjectRefKey } from "../../contracts/claim-v2";
import { getClaim } from "../../claims/store";
import { resolveWorldClaim } from "../references";
import { readOutcomes } from "../outcomes";
import type { Enricher } from "../pipeline/enrich";
/** Outcomes may change usefulness and qualify observation attribution, never truth assessments. */
export const procedureEnricher: Enricher = (frame, body) => {
  const classification = body.claims.find(({ eligible: e }) => e.semantic.predicate === "world.kind" && e.semantic.object.kind === "vocabulary" && ["world/procedure", "world/skill"].includes(e.semantic.object.ref.id));
  if (classification === undefined) return body;
  if (frame.cutoff.kind !== "current" || frame.valid.kind !== "all") return { ...body, outcomeUsefulness: { status: "unknown", reason: "history" } };
  const card = readOutcomes(frame, classification.eligible.semantic.subject.id, sha256Hex(rawSubjectRefKey(classification.eligible.semantic.subject)));
  const resolved = card.evaluations.filter(e => e.result !== "unknown");
  const observedEvents = new Set(resolved.flatMap(e => e.observations.flatMap(ref => {
    const id = resolveWorldClaim(frame.ctx.db, frame.ns, ref.token);
    return id === null ? [] : getClaim(frame.ctx.db, id)?.provenance ?? [];
  })));
  const independentSkillClaims = body.claims.filter(({ eligible }) => eligible.semantic.predicate === "skill.evidence" &&
    eligible.semantic.object.kind === "vocabulary" && eligible.semantic.object.ref.id === "skill/observed_outcome" &&
    eligible.supports.some(support => support.events.some(event => observedEvents.has(event.event_id))))
    .map(item => item.relation.claim.token);
  // Keep unresolved/confounded attempts beside comparable results; never hide their cost.
  return { ...body, independentSkillClaims, outcomeUsefulness: resolved.length === 0 ? { status: "unknown", reason: "no_outcome_evidence" } : { status: "observed", evaluations: card.evaluations } };
};
