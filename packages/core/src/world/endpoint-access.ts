import type { RawSubjectRef } from "../contracts/claim-v2";
import type { ServeContext } from "../serving/types";
import { authorizedSupportSql } from "./policy-sql";
import { eligibleWorldClaim, type ReadBudget } from "./projection";
import { resolveWorldObject, type WorldNamespace } from "./references";

/** More than one claim is never needed: a node is readable when any claim naming it is. */
const CANDIDATES = 16;

/**
 * The raw endpoint an object token names for this principal, or null when the
 * token names nothing the principal can read now. A token is lookup identity,
 * never authority: the node must still be named by a live claim whose complete
 * support the principal's grant and purpose allow, so a narrowed grant or a
 * lost source ends a token's use without any other state changing.
 */
export function readableWorldNode(ctx: ServeContext, ns: WorldNamespace, token: string): RawSubjectRef | null {
  const handle = resolveWorldObject(ctx.db, ns, token);
  if (handle === null) return null;
  const raw = ctx.db
    .query<{ raw_kind: "occurrence" | "supplied"; raw_namespace: string; raw_id: string }, [string]>(
      "SELECT raw_kind,raw_namespace,raw_id FROM semantic_bindings WHERE handle_id=?",
    )
    .get(handle);
  if (raw === null) return null;
  const ref: RawSubjectRef =
    raw.raw_namespace === ""
      ? { kind: raw.raw_kind, id: raw.raw_id }
      : { kind: "supplied", id: raw.raw_id, namespace: JSON.parse(raw.raw_namespace) };
  const permitted = authorizedSupportSql(ctx);
  const claims = ctx.db
    .query<{ claim_id: string }, (string | number)[]>(
      `SELECT c.claim_id FROM claim_v2_semantics c JOIN claims base USING(claim_id)
        WHERE c.discriminator='assertion' AND base.status='live' AND
          ((c.subject_kind=? AND c.subject_id=? AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=?) OR
           (json_extract(c.payload,'$.object.ref.kind')=? AND json_extract(c.payload,'$.object.ref.id')=?
            AND coalesce(json_extract(c.payload,'$.object.ref.namespace'),'')=?))
          AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
        ORDER BY c.claim_id LIMIT ?`,
    )
    .all(raw.raw_kind, raw.raw_id, raw.raw_namespace, raw.raw_kind, raw.raw_id, raw.raw_namespace, ...permitted.bindings, CANDIDATES);
  const budget: ReadBudget = { bytes: 0 };
  const readable = claims.some(({ claim_id }) => eligibleWorldClaim(ctx, claim_id, { kind: "all" }, budget) !== null);
  return readable ? ref : null;
}
