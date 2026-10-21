import { rawSubjectNamespace } from "../../contracts/claim-v2";
import { authorizedClaimSql } from "../policy-sql";
import { knownHeldSql, knownSupportSql, knownValidSql, WorldHistoryUnavailable } from "../known/cutoff";
import { anchorOf, type Collector } from "../pipeline/collect";
import { claimVisibleSql } from "../pipeline/frame";

/** Attributed statements and explicit context are person relations, not a consensus. */
export const personStatements: Collector = (frame, cluster, kind) => {
  if (kind.id !== "person") return [];
  const anchor = anchorOf(frame.ctx.db, cluster.anchor);
  if (anchor === null || anchor.kind !== "supplied") return [];
  const cutoff = frame.cutoff.kind === "current" ? undefined : frame.cutoff;
  const claim = authorizedClaimSql(frame.ctx);
  const endpoint = `EXISTS(SELECT 1 FROM json_each(json_array(
    json_extract(c.payload,'$.perspective.holder'),json_extract(c.payload,'$.perspective.speaker'),
    json_extract(c.payload,'$.perspective.addressee')) ) endpoint
    WHERE json_extract(endpoint.value,'$.kind')=? AND json_extract(endpoint.value,'$.id')=?
      AND coalesce(json_extract(endpoint.value,'$.namespace'),'')=?)
    OR EXISTS(SELECT 1 FROM json_each(c.payload,'$.context') endpoint
    WHERE json_extract(endpoint.value,'$.kind')=? AND json_extract(endpoint.value,'$.id')=?
      AND coalesce(json_extract(endpoint.value,'$.namespace'),'')=?)`;
  const bindings = [anchor.kind, anchor.id, rawSubjectNamespace(anchor), anchor.kind, anchor.id, rawSubjectNamespace(anchor)];
  const scope = (historical: boolean) => {
    const permitted = knownSupportSql(frame.ctx, historical ? cutoff : undefined);
    const held = knownHeldSql(frame.ctx, "base", historical ? cutoff : undefined);
    return { sql: `FROM claim_v2_semantics c JOIN claims base USING(claim_id)
      WHERE c.discriminator='assertion' AND ${historical ? claimVisibleSql(frame, "base") : "base.status<>'purged'"}
      AND (${endpoint}) AND ${claim.sql}
      AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql}) AND NOT ${held.sql}`,
      bindings: [...bindings, ...claim.bindings, ...permitted.bindings, ...held.bindings] };
  };
  if (cutoff !== undefined) {
    // Current permission cannot make erased older attribution look like absence.
    const current = scope(false);
    const unavailable = frame.ctx.db.query(`SELECT 1 ${current.sql} AND (
      NOT EXISTS(SELECT 1 FROM claim_history_coverage h WHERE h.claim_id=c.claim_id)
      OR EXISTS(SELECT 1 FROM claim_history_coverage h WHERE h.claim_id=c.claim_id AND h.coverage='baseline_only' AND h.complete_from_sequence>?)) LIMIT 1`)
      .get(...current.bindings, cutoff.sequence);
    if (unavailable !== null) throw new WorldHistoryUnavailable();
    if (frame.ctx.db.query(`SELECT 1 ${current.sql} AND EXISTS(SELECT 1 FROM claim_history_coverage h WHERE h.claim_id=c.claim_id AND h.coverage='baseline_only') LIMIT 1`).get(...current.bindings) !== null)
      frame.historyBaseline = true;
  }
  const selected = scope(true), valid = knownValidSql(frame.valid, cutoff);
  return frame.ctx.db.query<{ claim_id: string }, (string | number)[]>(`SELECT c.claim_id ${selected.sql} AND ${valid.sql} ORDER BY c.claim_id LIMIT 129`)
    .all(...selected.bindings, ...valid.bindings).map(row => row.claim_id);
};
