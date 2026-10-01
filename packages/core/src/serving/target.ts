import { authorize } from "../agents";
import type { AuditDenial, DenyReason, Grant, Servable } from "../agents";
import { getClaim, listClaims } from "../claims/store";
import { sourcePolicyEpoch } from "../ledger/source-grants";
import { claimReader } from "./claims";
import { authorizedClaimSql } from "./claim-policy-sql";
import type { Claim } from "../contracts/proposal";
import { identifier } from "./arguments";
import { ENVELOPE_SCHEMA, ENVELOPE_V2_SCHEMA, ServeError } from "./types";
import type { ResponseContract, ServeContext } from "./types";

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
  world_claim?: { readonly kind: "claim"; readonly token: string };
}

function refuse(field: string, rule: string, denials: AuditDenial[] = []): ServeError {
  return new ServeError(
    "invalid_arguments",
    `invalid arguments: ${field}: ${rule}`,
    { denials },
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
export interface Resolved {
  /** The target as the caller named it, once it is known to be usable. */
  target: CorrectTarget;
  claims: Claim[];
}

/**
 * What the principal could have read. A claim outside that view is treated as
 * absent, so the refusal for a claim that does not exist and for one the
 * caller may not read is the same one: neither existence nor tier can be
 * probed by guessing an id, a key or a subject. The owner sees every claim.
 */
function visibleTo(ctx: ServeContext, hidden: AuditDenial[] = []): (claim: Claim) => boolean {
  if (ctx.principal.kind === "owner") return () => true;
  const grant = ctx.principal.grant;
  const reader = claimReader(ctx.db, grant, { owner: false, purpose: "correction" });
  const sourcePolicy = sourcePolicyEpoch(ctx.db) > 0;
  return (claim) => {
    // The real reason goes to the owner's audit row, never to the caller.
    const decision = authorize(grant, claimServable(claim));
    if (!decision.allow) {
      hidden.push({ id: claim.claim_id, reason: decision.reason });
      return false;
    }
    if (sourcePolicy && !reader.canRead(claim)) {
      hidden.push({ id: claim.claim_id, reason: "held" });
      return false;
    }
    return true;
  };
}

/** Scoped targets are selected under policy before complete claims are decoded. */
function scopedTargets(ctx: ServeContext, where: string, bindings: string[], visible: (claim: Claim) => boolean): Claim[] {
  const policy = authorizedClaimSql(ctx);
  const selected: Claim[] = [];
  for (const row of ctx.db.query<{ claim_id: string }, (string | number)[]>(
    `SELECT claim_id FROM claims WHERE status='live' AND ${where} AND ${policy.sql}
      ORDER BY created_at, claim_id LIMIT ${MAX_CANDIDATES}`,
  ).iterate(...bindings, ...policy.bindings)) {
    const claim = getClaim(ctx.db, row.claim_id);
    if (claim !== null && visible(claim)) selected.push(claim);
  }
  return selected;
}

/** True when `claim` is inside what `ctx.principal` could have read; the replay path uses it too. */
export function claimVisibleTo(ctx: ServeContext, claim: Claim): boolean {
  return visibleTo(ctx)(claim);
}

export function resolve(
  ctx: ServeContext,
  target: CorrectTarget | undefined,
  contract: ResponseContract = ENVELOPE_SCHEMA,
): Resolved {
  if (target === undefined) {
    throw refuse("target", "name a claim, a claim key or a subject");
  }
  const named = [target.claim_id, target.claim_key, target.subject, target.world_claim].filter(
    (value) => value !== undefined,
  );
  if (named.length !== 1) {
    throw refuse("target", "name exactly one of claim_id, claim_key, subject");
  }

  const hidden: AuditDenial[] = [];
  const visible = visibleTo(ctx, hidden);
  // Only the compatibility path gathers privileged denial diagnostics.
  const scopedV2 = ctx.principal.kind === "agent" && contract === ENVELOPE_V2_SCHEMA;
  if (target.claim_id !== undefined) {
    const id = identifier("target.claim_id", target.claim_id);
    const policy = scopedV2 ? authorizedClaimSql(ctx) : null;
    const selected = policy === null || ctx.db.query<{ claim_id: string }, (string | number)[]>(
      `SELECT claim_id FROM claims WHERE claim_id=? AND status='live' AND ${policy.sql}`,
    ).get(id, ...policy.bindings) !== null;
    const claim = getClaim(
      ctx.db,
      selected ? id : "",
    );
    if (claim === null || claim.status !== "live" || !visible(claim)) {
      throw refuse("target.claim_id", "names no live claim", hidden);
    }
    if (claim.claim_key === null) {
      throw refuse(
        "target.claim_id",
        "names a claim with no predicate to correct",
      );
    }
    return { target, claims: [claim] };
  }

  if (target.claim_key !== undefined) {
    if (!CLAIM_KEY.test(target.claim_key)) {
      throw refuse("target.claim_key", "must be a claim key");
    }
    const claims = !scopedV2 ? listClaims(ctx.db, {
      claim_key: target.claim_key,
      status: "live",
      limit: MAX_CANDIDATES,
      filter: visible,
    }) : scopedTargets(ctx, "claim_key=?", [target.claim_key], visible);
    if (claims.length === 0) {
      throw refuse("target.claim_key", "names no live claim", hidden);
    }
    return { target, claims };
  }

  // Narrowed in SQL. Reading a default page of the table and filtering it in
  // memory stops finding real targets the moment a vault outgrows that page.
  const subject = identifier("target.subject", target.subject);
  const claims = !scopedV2 ? listClaims(ctx.db, {
    status: "live",
    subject,
    keyed: true,
    limit: MAX_CANDIDATES,
    filter: visible,
  }) : scopedTargets(ctx, "subject=? AND claim_key IS NOT NULL", [subject], visible);
  if (claims.length === 0) {
    throw refuse("target.subject", "names no live keyed claim", hidden);
  }
  if (claims.length === MAX_CANDIDATES) {
    throw refuse("target.subject", "names too many live claims to resolve");
  }
  return { target, claims };
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
  busy: "the target is outside the grant",
  invalid_arguments: "the target is outside the grant",
  unsupported_contract: "the target is outside the grant",
  error: "the target is outside the grant",
};

export function readable(grant: Grant, claims: Claim[]): void {
  for (const claim of claims) {
    const decision = authorize(grant, claimServable(claim));
    if (decision.allow) continue;
    throw new ServeError(decision.reason, OUT_OF_SCOPE[decision.reason]);
  }
}
