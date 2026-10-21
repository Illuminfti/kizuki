import type { Enricher } from "../pipeline/enrich";
import { consolidationBasis } from "../consolidation/basis";
import { issueWorldRef } from "../references";

/** Exact basis only. A broader stored result has no observable effect on this read. */
export const summaryEnricher: Enricher = (frame, body) => {
  if (body.consolidation === undefined) return body;
  const { cluster, kind } = body.consolidation;
  const basis = consolidationBasis(cluster, kind, body.claims.map((claim) => claim.eligible), body.overflow === true);
  const pending = () => ({ ...body, gaps: [...body.gaps, "pending_consolidation" as const] });
  if (basis === null) return pending();
  const now = new Date().toISOString();
  const row = frame.ctx.db.query<{ summary: string | null; completed_at: string }, [string, string]>(
    "SELECT summary,completed_at FROM world_consolidation WHERE basis_digest=? AND status='complete' AND expires_at>?",
  ).get(basis.digest, now);
  frame.stats.rowsExamined += row === null ? 0 : 1;
  if (row !== null && (frame.cutoff.kind === "current" || row.completed_at <= frame.cutoff.at)) {
    return { ...body, summary: row.summary === null ? null : { text: row.summary,
      admissions: basis.supports.map((support) => issueWorldRef(frame.ctx.db, frame.ns, "admission", support.row.support_key)) } };
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
    .get(basis.anchor, basis.kind, now, basis.digest, JSON.stringify(basis.members), JSON.stringify(basis.supports.map((s) => s.row.support_key)), JSON.stringify(basis.supports.map((s) => s.row.support_key)));
  return stale === null ? pending() : { ...body, gaps: [...body.gaps, "stale_dependencies" as const] };
};
