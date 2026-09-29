import type { Database } from "bun:sqlite";
import { sourceRoots } from "../claims/source-roots";
import type { ClaimV2Assertion } from "../contracts/claim-v2";
import { AUTHORITY_TIERS, type AuthorityTier } from "../contracts/proposal";

/** Lower-case fragments that give a decision authority, grant or policy meaning. */
const AUTHORITY_TERMS = ["owner", "agent", "grant", "permission", "authoriz", "authoris", "access", "polic", "admin", "credential", "audit", "revok"] as const;
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

/** Independent source records a model-read authority claim needs before it is served. */
export const AUTHORITY_CLAIM_MIN_ROOTS = 2;

/**
 * A model-read claim with identity, authority, grant or policy meaning is held,
 * not deleted: it stays in the ledger, is invisible to reads and canon, and is
 * released by a second independent source record or by the owner. The owner's
 * own correction is native support and never waits. It counts every support the
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
  if (!hasAuthorityMeaning(semantic)) return false;
  if (AUTHORITY_TIERS[authority] > AUTHORITY_TIERS.model_inference) return false;
  const supports = db.query<{ support_key: string; support_origin: string }, (string | number)[]>(
    `SELECT s.support_key, s.support_origin FROM claim_v2_support s WHERE claim_id=? AND ${permitted.sql}`,
  ).all(claimId, ...permitted.bindings);
  if (supports.some(support => support.support_origin === "native_owner")) return false;
  const events = db.query<{ event_id: string }, [string]>(
    "SELECT DISTINCT event_id FROM claim_v2_support_events WHERE support_key IN (SELECT value FROM json_each(?))",
  ).all(JSON.stringify(supports.map(support => support.support_key)));
  return sourceRoots(db, events.map(event => event.event_id)).size < AUTHORITY_CLAIM_MIN_ROOTS;
}

/**
 * The same rule as a SQL condition over `claims` aliased `alias`, for queues
 * that must not fill with claims that cannot be served yet. It is a prefilter:
 * the read path applies `heldUntilCorroborated` itself.
 */
export function heldClaimSql(alias: string): string {
  const identity = IDENTITY_PREDICATES.map(predicate => `'${predicate}'`).join(",");
  const terms = AUTHORITY_TERMS.map(term => `lower(json_extract(m.payload,'$.object.value')) LIKE '%${term}%'`).join(" OR ");
  return `(${alias}.authority = 'model_inference'
    AND EXISTS (SELECT 1 FROM claim_v2_semantics m WHERE m.claim_id = ${alias}.claim_id
      AND (m.predicate IN (${identity}) OR (m.predicate LIKE 'decision.%' AND m.object_kind = 'literal' AND (${terms}))))
    AND NOT EXISTS (SELECT 1 FROM claim_v2_support n WHERE n.claim_id = ${alias}.claim_id AND n.support_origin = 'native_owner')
    AND (SELECT count(DISTINCT s.source_key || char(31) || e.source_record_id)
           FROM claim_v2_support s JOIN claim_v2_support_events se ON se.support_key = s.support_key
           JOIN events e ON e.event_id = se.event_id WHERE s.claim_id = ${alias}.claim_id) < ${AUTHORITY_CLAIM_MIN_ROOTS})`;
}
