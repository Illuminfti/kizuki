import { rawSubjectNamespace } from "../../contracts/claim-v2";
import { authorizedClaimSql } from "../policy-sql";
import { knownPermittedAndUnheldSql, knownValidSql, WorldHistoryUnavailable } from "../known/cutoff";
import { anchorOf, type Collector } from "../pipeline/collect";
import { claimVisibleSql, MAX_CARD_RELATIONS, type ReadFrame } from "../pipeline/frame";

/**
 * Shared bounded collector query over `claim_v2_semantics` for endpoint-linked
 * assertions (perspective attribution or explicit context). Enforces history
 * coverage under current permission and records overflow on `frame` whenever
 * SQL hits `MAX_CARD_RELATIONS + 1`.
 */
export function collectEndpointStatements(
  frame: ReadFrame,
  endpointSql: string,
  endpointBindings: readonly (string | number)[],
): string[] {
  const cutoff = frame.cutoff.kind === "current" ? undefined : frame.cutoff;
  const claim = authorizedClaimSql(frame.ctx);
  const scope = (historical: boolean) => {
    const admitted = knownPermittedAndUnheldSql(frame.ctx, "base", historical ? cutoff : undefined);
    return {
      sql: `FROM claim_v2_semantics c JOIN claims base USING(claim_id)
      WHERE c.discriminator='assertion' AND ${historical ? claimVisibleSql(frame, "base") : "base.status<>'purged'"}
      AND (${endpointSql}) AND ${claim.sql}
      AND ${admitted.sql}`,
      bindings: [...endpointBindings, ...claim.bindings, ...admitted.bindings],
    };
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
  const rows = frame.ctx.db
    .query<{ claim_id: string }, (string | number)[]>(
      `SELECT c.claim_id ${selected.sql} AND ${valid.sql} ORDER BY c.claim_id LIMIT ${MAX_CARD_RELATIONS + 1}`,
    )
    .all(...selected.bindings, ...valid.bindings);
  if (rows.length > MAX_CARD_RELATIONS) frame.collectorOverflow = true;
  return rows.map((row) => row.claim_id);
}

/** Attributed statements and explicit context are person relations, not a consensus. */
export const personStatements: Collector = (frame, cluster, kind) => {
  if (kind.id !== "person") return [];
  const anchor = anchorOf(frame.ctx.db, cluster.anchor);
  if (anchor === null || anchor.kind !== "supplied") return [];
  const endpoint = `EXISTS(SELECT 1 FROM json_each(json_array(
    json_extract(c.payload,'$.perspective.holder'),json_extract(c.payload,'$.perspective.speaker'),
    json_extract(c.payload,'$.perspective.addressee')) ) endpoint
    WHERE json_extract(endpoint.value,'$.kind')=? AND json_extract(endpoint.value,'$.id')=?
      AND coalesce(json_extract(endpoint.value,'$.namespace'),'')=?)
    OR EXISTS(SELECT 1 FROM json_each(c.payload,'$.context') endpoint
    WHERE json_extract(endpoint.value,'$.kind')=? AND json_extract(endpoint.value,'$.id')=?
      AND coalesce(json_extract(endpoint.value,'$.namespace'),'')=?)`;
  const bindings = [anchor.kind, anchor.id, rawSubjectNamespace(anchor), anchor.kind, anchor.id, rawSubjectNamespace(anchor)];
  return collectEndpointStatements(frame, endpoint, bindings);
};
