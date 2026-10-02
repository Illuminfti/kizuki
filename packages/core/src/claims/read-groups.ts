import type { Database } from "bun:sqlite";
import type { Claim } from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import { instantSecondSql, instantNanoSql } from "../query/sql";
import { PREDICATE_REGISTRY } from "./predicates";
import { claimReadSql, type ClaimReadScope } from "./read-scope";
import { listClaims } from "./store";

/** Limits apply per readable key, never to an unrelated vault-wide prefix. */
const MAX_GROUP_CLAIMS = 10_000;
const MAX_GROUP_BYTES = 8 * 1024 * 1024;
const MAX_GROUPS = 1_000;

export interface ClaimGroupOptions {
  subject?: string;
  canRead?: (claim: Claim) => boolean;
  scope?: ClaimReadScope;
}

/** Complete readable histories of candidate keys, newest key first. */
export function* readClaimGroups(
  db: Database,
  opts: ClaimGroupOptions,
  kind: "conflicts" | "gaps",
): Generator<Claim[]> {
  if (!tableExists(db, "claims")) return;
  const clauses = [
    "claims.claim_key IS NOT NULL",
    kind === "conflicts" ? "claims.status='live'" : "claims.status IN ('live','superseded')",
  ];
  const bindings: (string | number)[] = [];
  if (kind === "gaps") {
    const singles = PREDICATE_REGISTRY
      .filter(spec => spec.cardinality === "single")
      .map(spec => spec.id);
    clauses.push("claims.predicate IN (SELECT value FROM json_each(?))");
    bindings.push(JSON.stringify(singles));
  }
  if (opts.subject !== undefined) {
    clauses.push("claims.subject=?");
    bindings.push(opts.subject);
  }
  if (opts.scope !== undefined) {
    const permitted = claimReadSql(db, opts.scope);
    clauses.push(permitted.sql);
    bindings.push(...permitted.bindings);
  }
  const statement = db.prepare<{ claim_key: string }, (string | number)[]>(`
    WITH readable AS (
      SELECT claims.claim_key,
        ${instantSecondSql("claims.asserted_at")} AS asserted_second,
        ${instantNanoSql("claims.asserted_at")} AS asserted_nano,
        length(CAST(claims.body AS BLOB))+length(CAST(coalesce(claims.object,'') AS BLOB))+
          length(CAST(claims.frontmatter AS BLOB))+length(CAST(claims.provenance AS BLOB))+length(CAST(claims.subjects AS BLOB)) AS bytes
      FROM claims WHERE ${clauses.join(" AND ")}
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY claim_key ORDER BY asserted_second DESC, asserted_nano DESC) AS recency
      FROM readable
    )
    SELECT claim_key FROM ranked
    GROUP BY claim_key HAVING count(*) BETWEEN 2 AND ${MAX_GROUP_CLAIMS} AND sum(bytes)<=${MAX_GROUP_BYTES}
    ORDER BY max(CASE WHEN recency=1 THEN asserted_second END) DESC,
      max(CASE WHEN recency=1 THEN asserted_nano END) DESC, claim_key`);
  let groups = 0;
  try {
    for (const row of statement.iterate(...bindings)) {
      // SQL withholds oversized histories whole, before any rows are decoded.
      const claims = listClaims(db, {
        claim_key: row.claim_key,
        limit: MAX_GROUP_CLAIMS + 1,
        ...(opts.subject === undefined ? {} : { subject: opts.subject }),
        ...(kind === "conflicts" ? { status: "live" as const } : {}),
        ...(opts.scope === undefined ? {} : { scope: opts.scope }),
        filter: claim => (claim.status === "live" || claim.status === "superseded") && (opts.canRead?.(claim) ?? true),
      });
      if (claims.length < 2 || claims.length > MAX_GROUP_CLAIMS) continue;
      yield claims;
      if (++groups === MAX_GROUPS) break;
    }
  } finally {
    statement.finalize();
  }
}
