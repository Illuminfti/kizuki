import type { Database } from "bun:sqlite";
import type { Claim } from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import { claimsConflict, type ConflictClaim } from "./conflict";
import { ClaimError } from "./errors";
import { listClaims } from "./store";

export const LEGACY_IDENTITY_EVIDENCE_MAX_BYTES = 16_384;
export const LEGACY_IDENTITY_EVIDENCE_MAX_REFS = 64;
export const LEGACY_IDENTITY_EVIDENCE_ID_MAX_BYTES = 256;
export const LEGACY_IDENTITY_ENDPOINT_MAX_BYTES = 1_024;
export const LEGACY_IDENTITY_SCAN_MAX_ROWS = 10_000;
export const LEGACY_IDENTITY_SCAN_MAX_BYTES = 1_048_576;

export interface LegacyIdentityEvidenceRef {
  readonly kind: "event" | "claim";
  readonly id: string;
}

export type LegacyIdentityEvidence =
  | { readonly ok: true; readonly refs: readonly LegacyIdentityEvidenceRef[] }
  | { readonly ok: false };

export interface LegacyIdentityRow {
  readonly subject_a: string;
  readonly subject_b: string;
  readonly evidence: string;
}

const LEGACY_EVIDENCE_REF = /^(event|claim):([A-Za-z0-9][A-Za-z0-9._:/-]{0,255})$/;

/**
 * Legacy identity rows are inert history. Parse their stored support once and
 * only admit exact typed references for cleanup and absence verification.
 */
export function parseLegacyIdentityEvidence(raw: unknown): LegacyIdentityEvidence {
  // Callers that read SQLite use scanLegacyIdentityRows, which checks byte
  // lengths before materialising text. This guard remains for archive input.
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > LEGACY_IDENTITY_EVIDENCE_MAX_BYTES) {
    return { ok: false };
  }
  let values: unknown;
  try { values = JSON.parse(raw); } catch { return { ok: false }; }
  if (!Array.isArray(values) || values.length === 0 || values.length > LEGACY_IDENTITY_EVIDENCE_MAX_REFS) {
    return { ok: false };
  }
  const refs: LegacyIdentityEvidenceRef[] = [];
  for (const value of values) {
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > LEGACY_IDENTITY_EVIDENCE_ID_MAX_BYTES) {
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

/** Read inert legacy rows under a finite work and allocation budget. */
export function scanLegacyIdentityRows(db: Database): LegacyIdentityRow[] {
  if (!tableExists(db, "identity_links")) return [];
  const preflight = db.query<{
    subject_a_type: string; subject_b_type: string; evidence_type: string;
    subject_a_bytes: number; subject_b_bytes: number; evidence_bytes: number;
  }, []>(`SELECT typeof(subject_a) AS subject_a_type, typeof(subject_b) AS subject_b_type,
                   typeof(evidence) AS evidence_type,
                   length(CAST(subject_a AS BLOB)) AS subject_a_bytes,
                   length(CAST(subject_b AS BLOB)) AS subject_b_bytes,
                   length(CAST(evidence AS BLOB)) AS evidence_bytes
            FROM identity_links LIMIT ${LEGACY_IDENTITY_SCAN_MAX_ROWS + 1}`).all();
  if (preflight.length > LEGACY_IDENTITY_SCAN_MAX_ROWS) throw new Error("legacy identity row limit exceeded");
  let total = 0;
  for (const row of preflight) {
    if (row.subject_a_type !== "text" || row.subject_b_type !== "text" || row.evidence_type !== "text" ||
      row.subject_a_bytes > LEGACY_IDENTITY_ENDPOINT_MAX_BYTES || row.subject_b_bytes > LEGACY_IDENTITY_ENDPOINT_MAX_BYTES ||
      row.evidence_bytes > LEGACY_IDENTITY_EVIDENCE_MAX_BYTES) throw new Error("legacy identity row is malformed or oversized");
    total += row.subject_a_bytes + row.subject_b_bytes + row.evidence_bytes;
    if (total > LEGACY_IDENTITY_SCAN_MAX_BYTES) throw new Error("legacy identity aggregate limit exceeded");
  }
  return db.query<LegacyIdentityRow, []>("SELECT subject_a, subject_b, evidence FROM identity_links").all();
}

/** Strictly snapshot raw subjects before a purge deletes their event rows. */
export function collectLegacyPurgeSubjects(db: Database, eventIds: readonly string[]): Set<string> {
  const refs = new Set<string>();
  if (eventIds.length === 0) return refs;
  const rows = db.query<{ event_id: string; bytes: number; type: string }, string[]>(
    `SELECT event_id, length(CAST(subjects AS BLOB)) AS bytes, typeof(subjects) AS type FROM events WHERE event_id IN (${eventIds.map(() => "?").join(",")})`,
  ).all(...eventIds);
  if (rows.length !== eventIds.length) throw new Error("purge subject snapshot is incomplete");
  let total = 0;
  for (const row of rows) {
    if (row.type !== "text" || row.bytes > LEGACY_IDENTITY_EVIDENCE_MAX_BYTES) throw new Error("purge subject snapshot is malformed or oversized");
    total += row.bytes;
    if (total > LEGACY_IDENTITY_SCAN_MAX_BYTES) throw new Error("purge subject aggregate limit exceeded");
    if (row.event_id === undefined) throw new Error("purge subject snapshot is incomplete");
    const payload = db.query<{ subjects: string }, [string]>("SELECT subjects FROM events WHERE event_id=?").get(row.event_id);
    if (payload === null) throw new Error("purge subject snapshot is incomplete");
    let values: unknown;
    try { values = JSON.parse(payload.subjects); } catch { throw new Error("purge subject snapshot is malformed"); }
    if (!Array.isArray(values) || values.length > LEGACY_IDENTITY_EVIDENCE_MAX_REFS) throw new Error("purge subject snapshot is malformed");
    for (const value of values) {
      if (typeof value !== "object" || value === null || typeof (value as { subject_id?: unknown }).subject_id !== "string") throw new Error("purge subject snapshot is malformed");
      const id = (value as { subject_id: string }).subject_id;
      if (Buffer.byteLength(id, "utf8") > LEGACY_IDENTITY_ENDPOINT_MAX_BYTES) throw new Error("purge subject snapshot is malformed");
      refs.add(id);
    }
  }
  return refs;
}

export type LegacySupportState = "current" | "erased" | "unresolved";
export function resolveLegacyIdentityRef(db: Database, ref: LegacyIdentityEvidenceRef, erasedEvents: ReadonlySet<string>, erasedClaims: ReadonlySet<string>): LegacySupportState {
  if ((ref.kind === "event" ? erasedEvents : erasedClaims).has(ref.id)) return "erased";
  if (ref.kind === "event") {
    if (db.query("SELECT 1 FROM events WHERE event_id=? LIMIT 1").get(ref.id) !== null) return "current";
    return db.query("SELECT 1 FROM event_purges WHERE event_id=? LIMIT 1").get(ref.id) !== null ? "erased" : "unresolved";
  }
  const row = db.query<{ status: string }, [string]>("SELECT status FROM claims WHERE claim_id=? LIMIT 1").get(ref.id);
  return row == null ? "unresolved" : row.status === "purged" ? "erased" : "current";
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
