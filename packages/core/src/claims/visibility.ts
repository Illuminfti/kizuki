import type { Database } from "bun:sqlite";
import type { Grant } from "../agents";
import type { Claim } from "../contracts/proposal";
import { sourceServingSql } from "../ledger/source-grants";
import { ceilingSql, instantBoundPair, instantPairSql, requireCeiling } from "../query/sql";

/** Candidate admission before materialization; the reader checks live evidence afterward. */
export interface ClaimVisibility {
  sql: string;
  bindings: (string | number)[];
  canRead(claim: Claim): boolean;
}

export function claimVisibilitySql(db: Database, grant: Grant, owner: boolean): Omit<ClaimVisibility, "canRead"> {
  const ceiling = requireCeiling(grant.ceiling);
  const clauses = [ceilingSql("claims.sensitivity")];
  const bindings: (string | number)[] = [ceiling];
  if (grant.types !== null) {
    clauses.push("json_extract(claims.frontmatter,'$.type') IN (SELECT value FROM json_each(?))");
    bindings.push(JSON.stringify(grant.types));
  }
  if (grant.subjects !== null) {
    clauses.push(`EXISTS (SELECT 1 FROM json_each(?) wanted WHERE
      (claims.subject IS NOT NULL AND wanted.value=claims.subject) OR
      (claims.subject IS NULL AND EXISTS (SELECT 1 FROM json_each(claims.subjects) WHERE value=wanted.value)))`);
    bindings.push(JSON.stringify(grant.subjects));
  }
  for (const [bound, comparison] of [[grant.since, ">="], [grant.until, "<="]] as const) {
    if (bound === null) continue;
    clauses.push(`${instantPairSql("claims.valid_from")} ${comparison} (?, ?)`);
    bindings.push(...instantBoundPair(bound, "claim read window"));
  }
  const source = sourceServingSql(db, { owner, purpose: "recall" }, ceiling);
  if (source !== null) {
    clauses.push(`NOT EXISTS (SELECT 1 FROM json_each(claims.provenance) evidence
      WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.event_id=evidence.value AND ${source.sql}))`);
    bindings.push(...source.bindings);
  }
  return { sql: clauses.join(" AND "), bindings };
}
