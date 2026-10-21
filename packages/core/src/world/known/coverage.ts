import type { ServeContext } from "../../serving/types";
import { rawSubjectNamespace } from "../../contracts/claim-v2";
import { authorizedClaimSql } from "../policy-sql";
import { heldClaimSql } from "../corroboration";
import { anchorOf } from "../pipeline/collect";
import { knownSupportSql, WorldHistoryUnavailable, type KnownCutoff } from "./cutoff";

export function scopedKnownClaims(ctx: ServeContext, handle: string) {
  const anchor = anchorOf(ctx.db, handle);
  if (anchor === null) return null;
  const claim = authorizedClaimSql(ctx), permitted = knownSupportSql(ctx), held = heldClaimSql("base", permitted);
  return { sql: `FROM claim_v2_semantics c JOIN claims base USING(claim_id)
    WHERE base.status<>'purged' AND c.discriminator='assertion' AND ${claim.sql}
    AND ((c.subject_kind=? AND c.subject_id=? AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=?)
      OR (json_extract(c.payload,'$.object.ref.kind')=? AND json_extract(c.payload,'$.object.ref.id')=? AND coalesce(json_extract(c.payload,'$.object.ref.namespace'),'')=?))
    AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql}) AND NOT ${held.sql}`,
    bindings: [...claim.bindings, anchor.kind, anchor.id, rawSubjectNamespace(anchor), anchor.kind, anchor.id, rawSubjectNamespace(anchor), ...permitted.bindings, ...held.bindings] };
}
/** Complete later admissions prove absence. Baselines cannot prove an earlier past. */
export function checkKnownCoverage(ctx: ServeContext, handle: string, cutoff: KnownCutoff): boolean {
  const scope = scopedKnownClaims(ctx, handle);
  if (scope === null) return false;
  const gap = ctx.db.query(`SELECT 1 ${scope.sql} AND (
    NOT EXISTS(SELECT 1 FROM claim_history_coverage kc WHERE kc.claim_id=c.claim_id)
    OR EXISTS(SELECT 1 FROM claim_history_coverage kc WHERE kc.claim_id=c.claim_id AND kc.coverage='baseline_only' AND kc.complete_from_sequence>?)) LIMIT 1`)
    .get(...scope.bindings, cutoff.sequence);
  if (gap !== null) throw new WorldHistoryUnavailable();
  return ctx.db.query(`SELECT 1 ${scope.sql} AND EXISTS(SELECT 1 FROM claim_history_coverage kc WHERE kc.claim_id=c.claim_id AND kc.coverage='baseline_only') LIMIT 1`).get(...scope.bindings) !== null;
}
