import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
import { isRfc3339 } from "../util/time";
import type { Claim } from "../contracts/proposal";
import { claimsConflict, type ConflictClaim } from "./conflict";
import { ClaimError } from "./errors";
import { initClaims } from "./schema";
import { listClaims } from "./store";

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

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

function refuse(field: string, rule: string): never {
  throw new ClaimError("schema_invalid", `${field}: ${rule}`);
}

function subjectId(field: string, value: string): string {
  if (!SUBJECT.test(value)) {
    refuse(field, "must be a subject identifier");
  }
  return value;
}

function orderedPair(
  left: string,
  right: string,
): { subject_a: string; subject_b: string } {
  if (left === right) refuse("subject_b", "must name a different subject");
  return left < right
    ? { subject_a: left, subject_b: right }
    : { subject_a: right, subject_b: left };
}

export function upsertIdentityLink(
  db: Database,
  input: UpsertIdentityLinkInput,
): IdentityLink {
  initClaims(db);
  const left = subjectId("subject_a", input.subject_a);
  const right = subjectId("subject_b", input.subject_b);
  const pair = orderedPair(left, right);
  if (
    typeof input.score !== "number" ||
    !Number.isFinite(input.score) ||
    input.score < 0 ||
    input.score > 1
  ) {
    refuse("score", "must be a number in [0, 1]");
  }
  if (
    !Array.isArray(input.evidence) ||
    input.evidence.length === 0 ||
    !input.evidence.every((id) => typeof id === "string" && id.length > 0)
  ) {
    refuse("evidence", "must name at least one event or claim id");
  }
  if (
    !(IDENTITY_LINK_STATUSES as readonly string[]).includes(input.status)
  ) {
    refuse("status", `must be one of ${IDENTITY_LINK_STATUSES.join(" | ")}`);
  }
  if (typeof input.decided_by !== "string" || input.decided_by.length === 0) {
    refuse("decided_by", "must be a non-empty string");
  }
  if (!isRfc3339(input.at)) refuse("at", "must be an RFC3339 timestamp");
  const receipt =
    input.receipt_id === undefined || input.receipt_id === null
      ? null
      : input.receipt_id;
  if (receipt !== null && receipt.length === 0) {
    refuse("receipt_id", "must be null or a non-empty string");
  }

  db.query(
    `INSERT INTO identity_links
       (subject_a, subject_b, score, evidence, status, decided_by, receipt_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (subject_a, subject_b) DO UPDATE SET
       score = excluded.score,
       evidence = excluded.evidence,
       status = excluded.status,
       decided_by = excluded.decided_by,
       receipt_id = excluded.receipt_id,
       at = excluded.at`,
  ).run(
    pair.subject_a,
    pair.subject_b,
    input.score,
    JSON.stringify([...input.evidence]),
    input.status,
    input.decided_by,
    receipt,
    input.at,
  );

  return {
    ...pair,
    score: input.score,
    evidence: [...input.evidence],
    status: input.status,
    decided_by: input.decided_by,
    receipt_id: receipt,
    at: input.at,
  };
}

/**
 * Soft aliases influence ranking and visibility. Rejected links stay out.
 * Merged links expand the set a correction or purge can name.
 */
export function listSubjectAliases(
  db: Database,
  subject: string,
  limit = 16,
  canRead?: (link: IdentityLink) => boolean,
  onInvalid?: (left: string, right: string) => void,
): SubjectAlias[] {
  if (!tableExists(db, "identity_links")) return [];
  const bound = Number.isSafeInteger(limit) && limit > 0 ? limit : 16;
  return db
    .query<
      {
        subject_a: string;
        subject_b: string;
        score: number;
        status: string;
        evidence: string;
        decided_by: string;
        receipt_id: string | null;
        at: string;
      },
      [string, string, number]
    >(
      `SELECT subject_a, subject_b, score, status, evidence, decided_by, receipt_id, at FROM identity_links
        WHERE (subject_a = ? OR subject_b = ?)
          AND status IN ('candidate', 'merged')
        ORDER BY score DESC, subject_a, subject_b
        LIMIT ?`,
    )
    .all(subject, subject, canRead === undefined ? bound : 400)
    .filter((row) => {
      if (canRead === undefined) return true;
      const invalid = (): false => {
        onInvalid?.(row.subject_a, row.subject_b);
        return false;
      };
      if (typeof row.evidence !== "string" || row.evidence.length > 16_384) return invalid();
      let evidence: unknown;
      try { evidence = JSON.parse(row.evidence); } catch { return invalid(); }
      if (!Array.isArray(evidence) || evidence.length === 0 ||
          !evidence.every((id): id is string => typeof id === "string" && id.length > 0)) {
        return invalid();
      }
      return canRead({ ...row, evidence, status: row.status as IdentityLinkStatus });
    })
    .slice(0, bound)
    .map((row) => ({
      subject: row.subject_a === subject ? row.subject_b : row.subject_a,
      score: row.score,
      status: row.status as IdentityLinkStatus,
    }));
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
