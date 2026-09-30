import type { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER, type Grant } from "../agents";
import { AUTHORITY_TIERS } from "../contracts/proposal";
import { LIVE_PREDICATE } from "../ledger/ledger";
import { sourceServingSql, type SourceReadScope } from "../ledger/source-grants";
import { ceilingSql, instantBoundPair, instantPairSql } from "../query/sql";

export interface ClaimReadScope {
  grant: Grant;
  source: SourceReadScope;
}

/**
 * Push claim and total-provenance policy into the cursor before any window or
 * work counter. The claim reader still validates each selected full record.
 * Source text need not clear the claim's ceiling: owner declassification may
 * release a claim without releasing its source text.
 */
export function claimReadSql(
  db: Database,
  scope: ClaimReadScope,
  alias = "claims",
): { sql: string; bindings: (string | number)[] } {
  const { grant, source: sourceScope } = scope;
  const clauses = [
    ceilingSql("claims.sensitivity"),
    "claims.taint IN ('clean','quoted')",
    `claims.authority IN (${Object.keys(AUTHORITY_TIERS).map(tier => `'${tier}'`).join(",")})`,
    "claims.confidence BETWEEN 0 AND 1",
    `(claims.status='live' AND claims.retracted_at IS NULL AND claims.superseded_by IS NULL
      OR claims.status='superseded' AND claims.retracted_at IS NOT NULL
        AND claims.superseded_by IS NOT NULL AND length(claims.superseded_by)>0
        AND claims.superseded_by<>claims.claim_id)`,
    "CASE WHEN json_valid(claims.frontmatter) THEN json_type(claims.frontmatter)='object' ELSE 0 END",
    "CASE WHEN json_valid(claims.subjects) THEN json_type(claims.subjects)='array' ELSE 0 END",
    "NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(claims.subjects) THEN claims.subjects ELSE '[]' END) subject WHERE subject.type<>'text')",
  ];
  const bindings: (string | number)[] = [SENSITIVITY_ORDER[grant.ceiling]];
  if (grant.types !== null) {
    clauses.push("json_extract(CASE WHEN json_valid(claims.frontmatter) THEN claims.frontmatter ELSE '{}' END,'$.type') IN (SELECT value FROM json_each(?))");
    bindings.push(JSON.stringify(grant.types));
  }
  if (grant.subjects !== null) {
    clauses.push(`(claims.subject IS NOT NULL AND claims.subject IN (SELECT value FROM json_each(?))
      OR claims.subject IS NULL AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(claims.subjects) THEN claims.subjects ELSE '[]' END) subject
        WHERE subject.value IN (SELECT value FROM json_each(?))))`);
    const subjects = JSON.stringify(grant.subjects);
    bindings.push(subjects, subjects);
  }
  if (grant.since !== null) {
    clauses.push(`${instantPairSql("claims.valid_from")} >= (?,?)`);
    bindings.push(...instantBoundPair(grant.since, "since"));
  }
  if (grant.until !== null) {
    clauses.push(`${instantPairSql("claims.valid_from")} <= (?,?)`);
    bindings.push(...instantBoundPair(grant.until, "until"));
  }
  const source = sourceServingSql(db, sourceScope, SENSITIVITY_ORDER[grant.ceiling]);
  // The CASE keeps malformed hidden JSON out of json_each, regardless of
  // SQLite's choice of predicate evaluation order.
  const provenance = "CASE WHEN json_valid(claims.provenance) THEN claims.provenance ELSE '[]' END";
  clauses.push(`json_type(${provenance})='array'`);
  clauses.push(`json_array_length(${provenance}) BETWEEN 1 AND 64`);
  clauses.push(`NOT EXISTS(SELECT 1 FROM json_each(${provenance}) evidence
    WHERE evidence.type<>'text' OR length(evidence.value) NOT BETWEEN 1 AND 128 OR NOT EXISTS(
      SELECT 1 FROM events WHERE events.event_id=evidence.value
        AND events.sensitivity_hint IN ('public','personal','private')
        AND ${LIVE_PREDICATE}${source === null ? "" : ` AND ${source.sql}`}
    ))`);
  if (source !== null) bindings.push(...source.bindings);
  return {
    sql: clauses.map(clause => `(${clause})`).join(" AND ").replaceAll("claims.", `${alias}.`),
    bindings,
  };
}
