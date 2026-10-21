import type { ServeContext } from "../serving/types";
import type { Database } from "bun:sqlite";
import type { Eligible } from "./pipeline/eligible";
import { authorizedClaimSql, authorizedSupportSql } from "./policy-sql";
import { issueWorldRef, type WorldNamespace } from "./references";
import { sourceCoverage, type SourceCoverageGap } from "./coverage";
import { heldClaimSql } from "./corroboration";

/** Complete authorized evidence used by a projection, including evidence omitted from its wire body. */
export interface WorldDependencies {
  readonly claims: Set<string>;
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

/** Revalidate live, unheld claims, support consent and coverage; hidden state contributes no returned rows. */
export function worldDependenciesCurrent(ctx: ServeContext, deps: WorldDependencies): boolean {
  const claims = authorizedClaimSql(ctx);
  const permitted = authorizedSupportSql(ctx);
  const held = heldClaimSql("base", permitted);
  const live = ctx.db.query<{ n: number }, (string | number)[]>(`
    SELECT count(*) AS n FROM claims base
    WHERE base.claim_id IN (SELECT value FROM json_each(?)) AND base.status='live' AND ${claims.sql} AND NOT ${held.sql}
  `).get(JSON.stringify([...deps.claims]), ...claims.bindings, ...held.bindings);
  if (live?.n !== deps.claims.size) return false;
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
