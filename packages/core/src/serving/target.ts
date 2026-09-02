import { authorize } from "../agents";
import type { DenyReason, Grant, Servable } from "../agents";
import { getClaim, listClaims } from "../claims/store";
import type { Claim } from "../contracts/proposal";
import { identifier } from "./arguments";
import { ServeError } from "./types";
import type { ServeContext } from "./types";

/**
 * A subject with more live keyed readings than this is not a target: the
 * caller is told to name one rather than handed a truncated page of them.
 */
const MAX_CANDIDATES = 200;
const CLAIM_KEY = /^[0-9a-f]{64}$/;

export interface CorrectTarget {
  claim_id?: string;
  claim_key?: string;
  subject?: string;
}

function refuse(field: string, rule: string): ServeError {
  return new ServeError(
    "invalid_arguments",
    `invalid arguments: ${field}: ${rule}`,
  );
}

/** Live, keyed claims grouped by the key a correction supersedes. */
export function groupByKey(claims: Claim[]): Map<string, Claim[]> {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const key = claim.claim_key;
    if (key === null) continue;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [claim]);
    else bucket.push(claim);
  }
  return groups;
}

/**
 * Resolution is exact or it does not happen. A model would be needed to read
 * an implicit target out of the sentence, and none is bound here, so an
 * unnamed target fails closed instead of guessing which claim to retire.
 */
export function resolve(
  ctx: ServeContext,
  target: CorrectTarget | undefined,
): Claim[] {
  if (target === undefined) {
    throw refuse("target", "name a claim, a claim key or a subject");
  }
  const named = [target.claim_id, target.claim_key, target.subject].filter(
    (value) => value !== undefined,
  );
  if (named.length !== 1) {
    throw refuse("target", "name exactly one of claim_id, claim_key, subject");
  }

  if (target.claim_id !== undefined) {
    const claim = getClaim(
      ctx.db,
      identifier("target.claim_id", target.claim_id),
    );
    if (claim === null || claim.status !== "live") {
      throw refuse("target.claim_id", "names no live claim");
    }
    if (claim.claim_key === null) {
      throw refuse(
        "target.claim_id",
        "names a claim with no predicate to correct",
      );
    }
    return [claim];
  }

  if (target.claim_key !== undefined) {
    if (!CLAIM_KEY.test(target.claim_key)) {
      throw refuse("target.claim_key", "must be a claim key");
    }
    const claims = listClaims(ctx.db, {
      claim_key: target.claim_key,
      status: "live",
      limit: MAX_CANDIDATES,
    });
    if (claims.length === 0) {
      throw refuse("target.claim_key", "names no live claim");
    }
    return claims;
  }

  // Narrowed in SQL. Reading a default page of the table and filtering it in
  // memory stops finding real targets the moment a vault outgrows that page.
  const subject = identifier("target.subject", target.subject);
  const claims = listClaims(ctx.db, {
    status: "live",
    subject,
    keyed: true,
    limit: MAX_CANDIDATES,
  });
  if (claims.length === 0) {
    throw refuse("target.subject", "names no live keyed claim");
  }
  if (claims.length === MAX_CANDIDATES) {
    throw refuse("target.subject", "names too many live claims to resolve");
  }
  return claims;
}

/**
 * A correction may not reach further than the reader could read, and "how
 * far" is one question with one answer: the same gate the read tools use, so
 * a grant's window and type scope bind here exactly as they do there.
 */
function claimServable(claim: Claim): Servable {
  const type = claim.frontmatter["type"];
  return {
    id: claim.claim_id,
    sensitivity: claim.sensitivity,
    ...(typeof type === "string" ? { type } : {}),
    subjects:
      claim.subject === null
        ? [...claim.subjects]
        : [claim.subject, ...claim.subjects],
    occurred_at: claim.valid_from,
  };
}

const OUT_OF_SCOPE: Record<DenyReason, string> = {
  missing_sensitivity: "the target carries no sensitivity label",
  missing_taint: "the target carries no taint stamp",
  above_ceiling: "the target is above the ceiling",
  type_out_of_scope: "the target is outside the grant",
  subject_out_of_scope: "the target is outside the grant",
  time_out_of_scope: "the target is outside the grant",
  held: "the target is held",
  tool_not_granted: "the target is outside the grant",
  unknown_agent: "the target is outside the grant",
  rate_limited: "the target is outside the grant",
  invalid_arguments: "the target is outside the grant",
  error: "the target is outside the grant",
};

export function readable(grant: Grant, claims: Claim[]): void {
  for (const claim of claims) {
    const decision = authorize(grant, claimServable(claim));
    if (decision.allow) continue;
    throw new ServeError(decision.reason, OUT_OF_SCOPE[decision.reason]);
  }
}

