import type { ClaimVisibility } from "../claims/visibility";
import { claimReader } from "../serving/claims";
import type { ServeContext } from "../serving/types";
import { authorizedClaimSql, authorizedSupportSql } from "../world/policy-sql";
import { heldClaimSql, heldUntilCorroborated } from "../world/corroboration";
import { eligibleWorldClaim } from "../world/pipeline/eligible";

/**
 * Legacy rows carry their scope in parent fields; typed parents deliberately
 * do not. Keep legacy validation and total provenance, but authorize typed
 * meaning through the same endpoints, support and time policy as its card.
 * Both SQL and the full-record check apply that policy so bounded dependency
 * traversal cannot silently omit a visible typed edge.
 */
export function correctionVisibility(ctx: ServeContext): ClaimVisibility {
  const source = { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall" };
  const legacy = claimReader(ctx.db, ctx.principal.grant, source);
  const typed = claimReader(ctx.db, {
    ...ctx.principal.grant, subjects: null, types: null, since: null, until: null,
  }, source);
  const claim = authorizedClaimSql(ctx, "claims");
  const support = authorizedSupportSql(ctx);
  const held = heldClaimSql("claims", support);
  const budget = { bytes: 0 };
  return {
    sql: `((claims.is_world_typed=0 AND ${legacy.visibility.sql}) OR
      (${typed.visibility.sql} AND ${claim.sql} AND NOT ${held.sql} AND
       EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=claims.claim_id AND ${support.sql})))`,
    bindings: [...legacy.visibility.bindings, ...typed.visibility.bindings, ...claim.bindings, ...held.bindings, ...support.bindings],
    canRead(value) {
      const isTyped = ctx.db.query("SELECT 1 FROM claims WHERE claim_id=? AND is_world_typed=1").get(value.claim_id) !== null;
      if (!isTyped) return legacy.canRead(value);
      if (!typed.canRead(value)) return false;
      // The response may describe its retired predecessor. Mutation still
      // requires a live target; disclosure retains today's source and hold rules.
      const retired = value.status === "superseded";
      if (retired && heldUntilCorroborated(ctx.db, value.claim_id, support)) return false;
      return eligibleWorldClaim(ctx, value.claim_id, { kind: "all" }, budget,
        retired ? { historical: true } : {}) !== null;
    },
  };
}
