import type { ServeContext } from "../serving/types";
import type { Database } from "bun:sqlite";
import type { Eligible } from "./pipeline/eligible";
import { authorizedSupportSql } from "./policy-sql";
import { issueWorldRef, type WorldNamespace } from "./references";

/** Complete authorized evidence used by a projection, including evidence omitted from its wire body. */
export interface WorldDependencies {
  readonly claims: Set<string>;
  readonly supports: Set<string>;
  readonly events: Set<string>;
}

export function worldDependencies(): WorldDependencies {
  return { claims: new Set(), supports: new Set(), events: new Set() };
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

/** Always one aggregate row, whether hidden source policy moved or not. No hidden support is read. */
export function worldDependenciesAuthorized(ctx: ServeContext, deps: WorldDependencies): boolean {
  const permitted = authorizedSupportSql(ctx);
  const row = ctx.db.query<{ n: number }, (string | number)[]>(`
    SELECT count(*) AS n FROM claim_v2_support s
    WHERE s.support_key IN (SELECT value FROM json_each(?)) AND ${permitted.sql}
  `).get(JSON.stringify([...deps.supports]), ...permitted.bindings);
  return row?.n === deps.supports.size;
}
