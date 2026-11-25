import type { Database } from "bun:sqlite";

/** Lower-case fragments that give a decision authority, grant or policy meaning. */
export const AUTHORITY_TERMS = ["owner", "agent", "assistant", "grant", "permission", "authoriz", "authoris", "access", "polic", "admin", "credential", "audit", "revok"] as const;
export const IDENTITY_PREDICATES = ["identity.same_as", "identity.handle_on"] as const;

/** Independent sources a model-read authority claim needs before it is served. */
export const AUTHORITY_CLAIM_MIN_ROOTS = 2;

const IDENTITY_SQL = IDENTITY_PREDICATES.map(predicate => `'${predicate}'`).join(",");
const OBJECT_TERMS_SQL = AUTHORITY_TERMS.map(term => `lower(json_extract(m.payload,'$.object.value')) LIKE '%${term}%'`).join(" OR ");
const BODY_TERMS_SQL = AUTHORITY_TERMS.map(term => `(lower(json_extract(s.admission,'$.rendering.body')) LIKE '%${term}%')`).join(" OR ");

export function hasAuthorityTerm(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTHORITY_TERMS.some((term) => lower.includes(term));
}

function authoritySemanticSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM claim_v2_semantics m WHERE m.claim_id = ${alias}.claim_id
      AND (m.predicate IN (${IDENTITY_SQL}) OR (m.predicate LIKE 'decision.%' AND m.object_kind = 'literal' AND (${OBJECT_TERMS_SQL}))))`;
}

/**
 * A model-read claim with identity, authority, grant or policy meaning, in its
 * literal or in the prose the page renders, is held, not deleted: it stays in
 * the ledger, is invisible to reads and canon, and is released by a second
 * independent source or by the owner. Two records of one enrolled source are one
 * root, because one attacker-controlled inbox can send both. The owner's own
 * correction is native support and never waits. It counts every support the
 * reader may use, not the subset a caller selected, so the answer does not
 * change with the question.
 */
export function heldUntilCorroborated(
  db: Database,
  claimId: string,
  permitted: { sql: string; bindings: (string | number)[] },
): boolean {
  const held = heldClaimSql("c", permitted);
  // Read one decision, not every admission body: repeated deliveries must not
  // turn the hold into an unbounded allocation. Reads and queues share one rule.
  return db.query(`SELECT 1 FROM claims c WHERE c.claim_id=? AND ${held.sql}`)
    .get(claimId, ...held.bindings) !== null;
}

/**
 * The same rule as a SQL condition over `claims` aliased `alias`, for queues
 * that must not fill with claims that cannot be served yet. `permitted` is the
 * reader's own support filter over `claim_v2_support s`, so the prefilter
 * counts what the read path counts. It is a prefilter: the read path applies
 * `heldUntilCorroborated` itself.
 */
export function heldClaimSql(alias: string, permitted: { sql: string; bindings: (string | number)[] }):
  { sql: string; bindings: (string | number)[] } {
  // Single correlated aggregate over permitted supports avoids triplicating the
  // support policy subquery while preserving exact zero-row aggregate semantics.
  return {
    sql: `EXISTS (SELECT count(*) FROM claim_v2_support s WHERE s.claim_id = ${alias}.claim_id AND ${permitted.sql}
      HAVING coalesce(max(CASE WHEN s.support_origin = 'native_owner' THEN 1 ELSE 0 END), 0) = 0
        AND count(DISTINCT s.source_key) < ${AUTHORITY_CLAIM_MIN_ROOTS}
        AND (coalesce(max(CASE WHEN ${BODY_TERMS_SQL} THEN 1 ELSE 0 END), 0) = 1 OR ${authoritySemanticSql(alias)}))`,
    bindings: [...permitted.bindings],
  };
}

/**
 * Equivalent to `EXISTS(permitted support) AND NOT heldClaimSql(alias, permitted)`
 * evaluated in a single correlated aggregate pass over `claim_v2_support`.
 */
export function permittedAndUnheldSql(alias: string, permitted: { sql: string; bindings: (string | number)[] }):
  { sql: string; bindings: (string | number)[] } {
  return {
    sql: `EXISTS (SELECT count(*) FROM claim_v2_support s WHERE s.claim_id = ${alias}.claim_id AND ${permitted.sql}
      HAVING count(*) > 0
        AND (max(CASE WHEN s.support_origin = 'native_owner' THEN 1 ELSE 0 END) = 1
          OR count(DISTINCT s.source_key) >= ${AUTHORITY_CLAIM_MIN_ROOTS}
          OR (max(CASE WHEN ${BODY_TERMS_SQL} THEN 1 ELSE 0 END) = 0 AND NOT ${authoritySemanticSql(alias)})))`,
    bindings: [...permitted.bindings],
  };
}
