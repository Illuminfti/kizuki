import { SENSITIVITY_ORDER } from "../agents";
import { LIVE_PREDICATE } from "../ledger/ledger";
import { sourceServingSql } from "../ledger/source-grants";
import { ceilingSql, instantBoundPair, instantPairSql } from "../query/sql";
import type { ServeContext } from "./types";

/** Candidate policy for legacy claims. Complete selected records still pass claimReader. */
export function authorizedClaimSql(ctx: ServeContext): { sql: string; bindings: (string | number)[] } {
  const grant = ctx.principal.grant;
  const clauses = [ceilingSql("claims.sensitivity")];
  const bindings: (string | number)[] = [SENSITIVITY_ORDER[grant.ceiling]];
  if (grant.subjects !== null) {
    clauses.push(`(claims.subject IN (SELECT value FROM json_each(?)) OR
      (claims.subject IS NULL AND EXISTS(SELECT 1 FROM json_each(claims.subjects) s
        WHERE s.value IN (SELECT value FROM json_each(?)))))`);
    bindings.push(JSON.stringify(grant.subjects), JSON.stringify(grant.subjects));
  }
  if (grant.types !== null) {
    clauses.push("json_extract(claims.frontmatter, '$.type') IN (SELECT value FROM json_each(?))");
    bindings.push(JSON.stringify(grant.types));
  }
  if (grant.since !== null) {
    clauses.push(`${instantPairSql("claims.valid_from")} >= (?,?)`);
    bindings.push(...instantBoundPair(grant.since, "since"));
  }
  if (grant.until !== null) {
    clauses.push(`${instantPairSql("claims.valid_from")} <= (?,?)`);
    bindings.push(...instantBoundPair(grant.until, "until"));
  }
  const source = sourceServingSql(ctx.db, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall" }, SENSITIVITY_ORDER[grant.ceiling]);
  clauses.push(`json_array_length(claims.provenance) BETWEEN 1 AND 64 AND
    NOT EXISTS(SELECT 1 FROM json_each(claims.provenance) p LEFT JOIN events ON events.event_id=p.value
      WHERE events.event_id IS NULL OR COALESCE((${LIVE_PREDICATE}${source === null ? "" : ` AND ${source.sql}`}),0)=0)`);
  if (source !== null) bindings.push(...source.bindings);
  return { sql: clauses.join(" AND "), bindings };
}
