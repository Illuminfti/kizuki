import type { Enricher } from "../pipeline/enrich";
import { WorldProjectionBudgetError } from "../pipeline/frame";
import { consolidationBasis, type ConsolidationBasis } from "../consolidation/basis";
import { issueWorldRef } from "../references";

/** Exact basis only. A broader stored result has no observable effect on this read. */
export const summaryEnricher: Enricher = (frame, body) => {
  if (body.consolidation === undefined) return body;
  const { cluster, kind } = body.consolidation;
  const pending = () => ({ ...body, gaps: [...body.gaps, "pending_consolidation" as const] });
  let basis: ConsolidationBasis | null;
  try { basis = consolidationBasis(frame, cluster, kind, body.claims.map((claim) => claim.eligible), body.overflow === true); }
  catch (error) {
    if (!(error instanceof WorldProjectionBudgetError)) throw error;
    return pending();
  }
  if (basis === null) return pending();
  const now = new Date().toISOString();
  const row = frame.ctx.db.query<{ summary: string | null; completed_at: string; response_hash: string; expires_at: string }, [string, string]>(
    "SELECT summary,completed_at,response_hash,expires_at FROM world_consolidation WHERE basis_digest=? AND status='complete' AND expires_at>?",
  ).get(basis.digest, now);
  frame.stats.rowsExamined += row === null ? 0 : 1;
  const admitted = row !== null && (frame.cutoff.kind === "current" ||
    (frame.cutoff.consolidations === undefined ? row.completed_at <= frame.cutoff.at :
      frame.cutoff.consolidations.some((pin) => pin.basisDigest === basis.digest && pin.responseHash === row.response_hash &&
        pin.completedAt === row.completed_at && pin.expiresAt === row.expires_at)));
  if (row !== null && admitted) {
    frame.dependencies?.consolidations.set(basis.digest, { responseHash: row.response_hash, completedAt: row.completed_at, expiresAt: row.expires_at });
    return { ...body, summary: row.summary === null ? null : { text: row.summary,
      admissions: basis.pins.map((pin) => issueWorldRef(frame.ctx.db, frame.ns, "admission", pin.key)) } };
  }
  // Historical reads never borrow a future or inexact basis.
  if (frame.cutoff.kind !== "current") return pending();
  // Strict subsets can explain staleness without consulting or counting any
  // row whose evidence or identity members are outside this reader's basis.
  const stale = frame.ctx.db.query<{ found: number }, string[]>(`SELECT 1 AS found FROM world_consolidation c
    WHERE c.handle_id=? AND c.kind=? AND c.status='complete' AND c.expires_at>? AND c.basis_digest<>?
      AND NOT EXISTS(SELECT 1 FROM json_each(c.members) m WHERE m.value NOT IN (SELECT value FROM json_each(?)))
      AND EXISTS(SELECT 1 FROM world_consolidation_basis b WHERE b.basis_digest=c.basis_digest)
      AND NOT EXISTS(SELECT 1 FROM world_consolidation_basis b WHERE b.basis_digest=c.basis_digest AND b.support_key NOT IN (SELECT value FROM json_each(?)))
      AND (SELECT count(*) FROM world_consolidation_basis b WHERE b.basis_digest=c.basis_digest)<json_array_length(?) LIMIT 1`)
    .get(basis.anchor, basis.kind, now, basis.digest, JSON.stringify(basis.members), JSON.stringify(basis.pins.map((pin) => pin.key)), JSON.stringify(basis.pins.map((pin) => pin.key)));
  frame.stats.rowsExamined += stale === null ? 0 : 1;
  return stale === null ? pending() : { ...body, gaps: [...body.gaps, "stale_dependencies" as const] };
};
