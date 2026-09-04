import type { Database } from "bun:sqlite";
import { authorize, sensitivity, SENSITIVITY_ORDER } from "../agents";
import type { AuditDenial, AuditItem, Grant, Sensitivity, Servable } from "../agents";
import type { IdentityLink } from "../claims/identity";
import { getClaim } from "../claims/store";
import type { Claim } from "../contracts/proposal";
import { isAuthorityTier } from "../contracts/proposal";
import { asTaint } from "./canon";
import { eventDecision, readServableEvents } from "./ledger";
import type { ServableEvent } from "./ledger";

/** One call's policy snapshot. Neither source text nor denied names escape. */
export function claimReader(db: Database, grant: Grant) {
  const decisions = new Map<string, boolean>();
  const events = new Map<string, ServableEvent | null>();
  const denied = new Map<string, AuditDenial>();
  const readableClaims = new Map<string, Claim>();
  const aliases = new Map<string, AuditItem>();

  function aliasId(left: string, right: string): string {
    return `identity:${new Bun.CryptoHasher("sha256")
      .update(JSON.stringify([left, right].sort())).digest("hex")}`;
  }

  function event(id: string): ServableEvent | null {
    if (!events.has(id)) events.set(id, readServableEvents(db, [id]).get(id) ?? null);
    return events.get(id) ?? null;
  }

  function canRead(claim: Claim): boolean {
    const cached = decisions.get(claim.claim_id);
    if (cached !== undefined) return cached;
    const raw = db.query<{ sensitivity: string | null }, [string]>(
      "SELECT sensitivity FROM claims WHERE claim_id = ?",
    ).get(claim.claim_id);
    // Storage's legacy null-to-private decode is not permission to serve an
    // unstamped row, even to the owner.
    const type = claim.frontmatter["type"];
    const item: Servable = {
      id: claim.claim_id,
      sensitivity: raw?.sensitivity,
      ...(typeof type === "string" ? { type } : {}),
      subjects: claim.subject === null ? claim.subjects : [claim.subject],
      occurred_at: claim.valid_from,
    };
    const decision = authorize(grant, item);
    let reason = decision.allow ? undefined : decision.reason;
    if (reason === undefined && asTaint(claim.taint) === null) reason = "missing_taint";
    if (reason === undefined && (!isAuthorityTier(claim.authority) ||
        !Number.isFinite(claim.confidence) || claim.retracted_at !== null ||
        !["live", "superseded"].includes(claim.status))) reason = "held";
    if (reason === undefined && (claim.provenance.length === 0 ||
        !claim.provenance.every((id) => {
          const source = event(id);
          return source !== null && sensitivity(source.sensitivity) !== null;
        }))) reason = "held";
    // A derived claim may be explicitly declassified by owner correction.
    // Validate total live provenance, but do not require permission to read
    // the source text: it is not part of this projection.
    if (reason !== undefined) denied.set(claim.claim_id, { id: claim.claim_id, reason });
    decisions.set(claim.claim_id, reason === undefined);
    if (reason === undefined) readableClaims.set(claim.claim_id, claim);
    return reason === undefined;
  }

  function auditClaim(id: string): AuditItem[] {
    const claim = readableClaims.get(id);
    return claim === undefined ? [] : [{
      id, sensitivity: claim.sensitivity, taint: claim.taint,
      authority: claim.authority, provenance_count: claim.provenance.length,
    }];
  }

  function auditGroup(key: string): AuditItem[] {
    return [...readableClaims.values()].filter((claim) => claim.claim_key === key)
      .flatMap((claim) => auditClaim(claim.claim_id));
  }

  function canReadAlias(link: IdentityLink): boolean {
    if (link.evidence.length === 0) return false;
    let label: Sensitivity = "public";
    for (const id of link.evidence) {
      const source = id.startsWith("claim:") ? null : event(id);
      const claim = id.startsWith("event:") ? null : getClaim(db, id.replace(/^claim:/, ""));
      // Legacy bare ids must resolve unambiguously. Typed references select
      // one namespace; unknown/deleted evidence never contributes a label.
      if ((source === null) === (claim === null)) return false;
      const evidenceLabel = sensitivity(source?.sensitivity ?? claim?.sensitivity);
      if (evidenceLabel === null) return false;
      if (source !== null && !eventDecision(grant, source).allow) return false;
      if (claim !== null && !canRead(claim)) return false;
      if (SENSITIVITY_ORDER[evidenceLabel] > SENSITIVITY_ORDER[label]) label = evidenceLabel;
    }
    const id = aliasId(link.subject_a, link.subject_b);
    // An alias reveals BOTH identities, not just the matching endpoint.
    for (const subject of [link.subject_a, link.subject_b]) {
      if (!authorize(grant, {
        id, sensitivity: label, subjects: [subject], occurred_at: link.at,
        // An identity link has no page type. Type-scoped grants fail closed.
      }).allow) return false;
    }
    aliases.set(id, { id, sensitivity: label, taint: "clean", authority: null,
      provenance_count: link.evidence.length });
    return true;
  }

  function auditAlias(left: string, right: string): AuditItem[] {
    const item = aliases.get(aliasId(left, right));
    return item === undefined ? [] : [item];
  }

  return { canRead, canReadAlias, denied, auditClaim, auditGroup, auditAlias };
}
