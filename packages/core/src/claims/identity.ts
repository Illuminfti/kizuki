import type { Database } from "bun:sqlite";
import type { Claim } from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import { claimsConflict, type ConflictClaim } from "./conflict";
import { ClaimError } from "./errors";
import { listClaims } from "./store";

export const LEGACY_IDENTITY_EVIDENCE_MAX_BYTES = 16_384;
export const LEGACY_IDENTITY_EVIDENCE_MAX_REFS = 64;
export const LEGACY_IDENTITY_EVIDENCE_ID_MAX_BYTES = 256;

export interface LegacyIdentityEvidenceRef {
  readonly kind: "event" | "claim";
  readonly id: string;
}

export type LegacyIdentityEvidence =
  | { readonly ok: true; readonly refs: readonly LegacyIdentityEvidenceRef[] }
  | { readonly ok: false };

const LEGACY_EVIDENCE_REF = /^(event|claim):([A-Za-z0-9][A-Za-z0-9._:/-]{0,255})$/;

/**
 * Legacy identity rows are inert history. Parse their stored support once and
 * only admit exact typed references for cleanup and absence verification.
 */
export function parseLegacyIdentityEvidence(raw: unknown): LegacyIdentityEvidence {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > LEGACY_IDENTITY_EVIDENCE_MAX_BYTES) {
    return { ok: false };
  }
  let values: unknown;
  try { values = JSON.parse(raw); } catch { return { ok: false }; }
  if (!Array.isArray(values) || values.length === 0 || values.length > LEGACY_IDENTITY_EVIDENCE_MAX_REFS) {
    return { ok: false };
  }
  const refs: LegacyIdentityEvidenceRef[] = [];
  for (const value of values) {
    if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > LEGACY_IDENTITY_EVIDENCE_ID_MAX_BYTES) {
      return { ok: false };
    }
    const match = LEGACY_EVIDENCE_REF.exec(value);
    if (match === null) return { ok: false };
    const kind = match[1];
    const id = match[2];
    if ((kind !== "event" && kind !== "claim") || id === undefined) return { ok: false };
    refs.push({ kind, id });
  }
  return { ok: true, refs };
}

/** RFC 0002 §18.1: autonomous merge only at this score with two connectors. */
export const IDENTITY_MERGE_MIN = 0.9;

export const IDENTITY_LINK_STATUSES = [
  "candidate",
  "merged",
  "rejected",
] as const;
export type IdentityLinkStatus = (typeof IDENTITY_LINK_STATUSES)[number];

export interface IdentityLink {
  readonly subject_a: string;
  readonly subject_b: string;
  readonly score: number;
  readonly evidence: readonly string[];
  readonly status: IdentityLinkStatus;
  readonly decided_by: string;
  readonly receipt_id: string | null;
  readonly at: string;
}

export interface SubjectAlias {
  readonly subject: string;
  readonly score: number;
  readonly status: IdentityLinkStatus;
}

export interface LiveConflictMember {
  readonly claim_id: string;
  readonly object: string | null;
  readonly polarity: "positive" | "negative";
  readonly confidence: number;
  readonly authority: string;
}

export interface LiveConflict {
  readonly claim_key: string;
  readonly claims: readonly LiveConflictMember[];
}

export interface UpsertIdentityLinkInput {
  readonly subject_a: string;
  readonly subject_b: string;
  readonly score: number;
  readonly evidence: readonly string[];
  readonly status: IdentityLinkStatus;
  readonly decided_by: string;
  readonly receipt_id?: string | null;
  readonly at: string;
}

export function upsertIdentityLink(
  _db: Database,
  _input: UpsertIdentityLinkInput,
): IdentityLink {
  throw new ClaimError("identity_unsupported", "identity mutation API retired");
}

/** Legacy compatibility API: identity authority is unavailable in A0. */
export function listSubjectAliases(
  _db: Database,
  _subject: string,
  _limit = 16,
  _canRead?: (link: IdentityLink) => boolean,
  _onInvalid?: (left: string, right: string) => void,
): SubjectAlias[] {
  throw new ClaimError("identity_unsupported", "identity authority unavailable");
}

function toConflict(claim: Claim): ConflictClaim | null {
  if (claim.claim_key === null) return null;
  return {
    claim_id: claim.claim_id,
    claim_key: claim.claim_key,
    polarity: claim.polarity,
    object: claim.object,
    predicate: claim.predicate,
    authority: claim.authority,
    confidence: claim.confidence,
    valid_from: claim.valid_from,
    valid_to: claim.valid_to,
    status: claim.status,
    provenance: claim.provenance,
  };
}

/**
 * Live claim_key groups that still disagree. Contested peers stay visible
 * so a correction can name them; they are not a review queue.
 */
export function listLiveConflicts(
  db: Database,
  opts: { subject?: string; limit?: number; canRead?: (claim: Claim) => boolean } = {},
): LiveConflict[] {
  if (!tableExists(db, "claims")) return [];
  const bound = Number.isSafeInteger(opts.limit) && (opts.limit ?? 0) > 0
    ? (opts.limit as number)
    : 32;
  const live = listClaims(db, {
    status: "live",
    keyed: true,
    ...(opts.subject === undefined ? {} : { subject: opts.subject }),
    limit: 400,
  }).filter((claim) => opts.canRead?.(claim) ?? true);
  const byKey = new Map<string, typeof live>();
  for (const claim of live) {
    if (claim.claim_key === null) continue;
    const group = byKey.get(claim.claim_key) ?? [];
    group.push(claim);
    byKey.set(claim.claim_key, group);
  }
  const conflicts: LiveConflict[] = [];
  for (const [claim_key, group] of byKey) {
    if (group.length < 2) continue;
    let disagreed = false;
    for (let i = 0; i < group.length && !disagreed; i += 1) {
      const leftClaim = group[i];
      if (leftClaim === undefined) continue;
      const left = toConflict(leftClaim);
      if (left === null) continue;
      for (let j = i + 1; j < group.length; j += 1) {
        const rightClaim = group[j];
        if (rightClaim === undefined) continue;
        const right = toConflict(rightClaim);
        if (right !== null && claimsConflict(left, right)) {
          disagreed = true;
          break;
        }
      }
    }
    if (!disagreed) continue;
    conflicts.push({
      claim_key,
      claims: group.map((claim) => ({
        claim_id: claim.claim_id,
        object: claim.object,
        polarity: claim.polarity,
        confidence: claim.confidence,
        authority: claim.authority,
      })),
    });
    if (conflicts.length >= bound) break;
  }
  return conflicts;
}
