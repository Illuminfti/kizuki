import type { ServeContext } from "../serving/types";
import type { Database } from "bun:sqlite";
import type { Eligible } from "./pipeline/eligible";
import { authorizedClaimSql } from "./policy-sql";
import { knownSupportSql, knownHeldSql, cutoffSequence, type KnownCutoff } from "./known/cutoff";
import { issueWorldRef, type WorldNamespace } from "./references";
import { sourceCoverage, type SourceCoverageGap } from "./coverage";

/** Complete authorized evidence used by a projection, including evidence omitted from its wire body. */
export interface WorldDependencies {
  readonly claims: Set<string>;
  cutoff?: KnownCutoff;
  readonly supports: Set<string>;
  readonly events: Set<string>;
  /** Authorized sources and the completeness/backlog gaps observed during assembly. */
  coverage: { readonly sources: readonly string[]; readonly gaps: readonly SourceCoverageGap[] } | null;
}

export function worldDependencies(): WorldDependencies {
  return { claims: new Set(), supports: new Set(), events: new Set(), coverage: null };
}

export function recordWorldDependencies(deps: WorldDependencies, item: Eligible): void {
  deps.claims.add(item.claimId);
  for (const support of item.supports) {
    deps.supports.add(support.row.support_key);
    for (const event of support.events) deps.events.add(event.event_id);
  }
}

/** Bind the complete evidence closure to the existing erasure cascades, without adding another cache table. */
export function dependencyRefs(db: Database, ns: WorldNamespace, deps: WorldDependencies): string[] {
  return [
    ...[...deps.claims].map((id) => issueWorldRef(db, ns, "claim", id).token),
    ...[...deps.supports].map((id) => issueWorldRef(db, ns, "admission", id).token),
    ...[...deps.events].map((id) => issueWorldRef(db, ns, "event_version", id).token),
  ];
}

/** Revalidate support consent and authorized source coverage; hidden state contributes no returned rows. */
export function worldDependenciesCurrent(ctx: ServeContext, deps: WorldDependencies): boolean {
  const permitted = knownSupportSql(ctx, deps.cutoff);
  const claim = authorizedClaimSql(ctx), held = knownHeldSql(ctx, "base", deps.cutoff);
  const retained = deps.cutoff === undefined ? "base.status='live'" : `base.status<>'purged' AND EXISTS(SELECT 1 FROM claim_lifecycle_history kh WHERE kh.claim_id=base.claim_id AND kh.sequence<=${cutoffSequence(deps.cutoff)})`;
  const claims = ctx.db.query<{ n: number }, (string | number)[]>(`SELECT count(*) AS n FROM claims base WHERE base.claim_id IN (SELECT value FROM json_each(?))
    AND ${retained} AND ${claim.sql} AND NOT ${held.sql}`)
    .get(JSON.stringify([...deps.claims]), ...claim.bindings, ...held.bindings);
  if (claims?.n !== deps.claims.size) return false;
  const row = ctx.db.query<{ n: number }, (string | number)[]>(`
    SELECT count(*) AS n FROM claim_v2_support s
    WHERE s.support_key IN (SELECT value FROM json_each(?)) AND ${permitted.sql}
  `).get(JSON.stringify([...deps.supports]), ...permitted.bindings);
  if (row?.n !== deps.supports.size) return false;
  if (deps.coverage === null) return true;
  const current = worldDependencies();
  sourceCoverage(ctx, current);
  return JSON.stringify(current.coverage) === JSON.stringify(deps.coverage);
}
