import type { Database } from "bun:sqlite";
import type { ClaimV2Assertion } from "../contracts/claim-v2";
import { AUTHORITY_TIERS, type AuthorityTier } from "../contracts/proposal";

/** Lower-case fragments that give a decision authority, grant or policy meaning. */
const AUTHORITY_TERMS = ["owner", "agent", "assistant", "grant", "permission", "authoriz", "authoris", "access", "polic", "admin", "credential", "audit", "revok"] as const;
const IDENTITY_PREDICATES = ["identity.same_as", "identity.handle_on"] as const;

/**
 * Claims whose meaning is identity, authority, grant or policy. A model may
 * read one out of captured text, but nothing it read alone is allowed to become
 * such a fact: they wait for two independent witnesses or the owner.
 */
export function hasAuthorityMeaning(semantic: ClaimV2Assertion): boolean {
  if ((IDENTITY_PREDICATES as readonly string[]).includes(semantic.predicate)) return true;
  if (!semantic.predicate.startsWith("decision.") || semantic.object.kind !== "literal") return false;
  const value = semantic.object.value.toLowerCase();
  return AUTHORITY_TERMS.some(term => value.includes(term));
}

/**
 * The page text is model prose whatever the literal says, so a body that talks
 * about who may do what carries the same meaning as an authority decision.
 * Authority terms are conservative: false positives stay held until corroborated.
 */
export function bodyHasAuthorityMeaning(body: string): boolean {
  const lower = body.toLowerCase();
  return AUTHORITY_TERMS.some(term => lower.includes(term));
}

/** Independent sources a model-read authority claim needs before it is served. */
export const AUTHORITY_CLAIM_MIN_ROOTS = 2;

function renderedBody(admission: string): string {
  try {
    const body = (JSON.parse(admission) as { rendering?: { body?: unknown } }).rendering?.body;
    return typeof body === "string" ? body : "";
  } catch { return ""; }
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
  authority: AuthorityTier,
  semantic: ClaimV2Assertion,
  permitted: { sql: string; bindings: (string | number)[] },
): boolean {
  if (AUTHORITY_TIERS[authority] > AUTHORITY_TIERS.model_inference) return false;
  const supports = db.query<{ source_key: string; support_origin: string; admission: string }, (string | number)[]>(
    `SELECT s.source_key, s.support_origin, s.admission FROM claim_v2_support s WHERE s.claim_id=? AND ${permitted.sql}`,
  ).all(claimId, ...permitted.bindings);
  if (!hasAuthorityMeaning(semantic) && !supports.some(support => bodyHasAuthorityMeaning(renderedBody(support.admission)))) return false;
  return !releasedBySupports(supports);
}

/** True when the owner stands behind the claim, or at least two distinct sources do. */
export function releasedBySupports(supports: readonly { source_key: string; support_origin: string }[]): boolean {
  if (supports.some(support => support.support_origin === "native_owner")) return true;
  return new Set(supports.map(support => support.source_key)).size >= AUTHORITY_CLAIM_MIN_ROOTS;
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
  const identity = IDENTITY_PREDICATES.map(predicate => `'${predicate}'`).join(",");
  const terms = AUTHORITY_TERMS.map(term => `lower(json_extract(m.payload,'$.object.value')) LIKE '%${term}%'`).join(" OR ");
  const bodyTerms = AUTHORITY_TERMS.map(term => `(lower(json_extract(s.admission,'$.rendering.body')) LIKE '%${term}%')`).join(" OR ");
  const scoped = permitted.sql;
  return {
    sql: `(${alias}.authority = 'model_inference'
    AND (EXISTS (SELECT 1 FROM claim_v2_semantics m WHERE m.claim_id = ${alias}.claim_id
        AND (m.predicate IN (${identity}) OR (m.predicate LIKE 'decision.%' AND m.object_kind = 'literal' AND (${terms}))))
      OR EXISTS (SELECT 1 FROM claim_v2_support s WHERE s.claim_id = ${alias}.claim_id AND (${bodyTerms}) AND ${scoped}))
    AND NOT EXISTS (SELECT 1 FROM claim_v2_support s WHERE s.claim_id = ${alias}.claim_id AND s.support_origin = 'native_owner' AND ${scoped})
    AND (SELECT count(DISTINCT s.source_key) FROM claim_v2_support s WHERE s.claim_id = ${alias}.claim_id AND ${scoped}) < ${AUTHORITY_CLAIM_MIN_ROOTS})`,
    bindings: [...permitted.bindings, ...permitted.bindings, ...permitted.bindings],
  };
}
