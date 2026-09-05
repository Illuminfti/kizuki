import type { Database } from "bun:sqlite";
import type { Claim } from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import { claimsConflict, type ConflictClaim } from "./conflict";
import { ClaimError } from "./errors";
import { listClaims } from "./store";
import { EVENT_LIMITS, SUBJECT_ROLES } from "../contracts/event";
import { isPlainObject } from "../util/validate";
import { isVisibleIdentifier } from "../util/opaque-identifier";

export const LEGACY_IDENTITY_EVIDENCE_MAX_BYTES = 16_384;
export const LEGACY_IDENTITY_EVIDENCE_MAX_REFS = 64;
export const LEGACY_IDENTITY_EVIDENCE_ID_MAX_BYTES = 256;
export const LEGACY_IDENTITY_ENDPOINT_MAX_BYTES = EVENT_LIMITS.subjectIdBytes;
export const LEGACY_IDENTITY_SCAN_MAX_ROWS = 10_000;
export const LEGACY_IDENTITY_SCAN_MAX_BYTES = 1_048_576;
export const LEGACY_IDENTITY_SCAN_MAX_REFS = 8_192;
const SCAN_PAGE = 128;
const SUBJECT_SCAN_MAX_EVENTS = 1_000_000;
const SUBJECT_SCAN_MAX_BYTES = 16 * EVENT_LIMITS.eventBytes;

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
  readonly score: number;
  readonly evidence: string;
  readonly status: string;
  readonly decided_by: string;
  readonly receipt_id: string | null;
  readonly at: string;
}

const LEGACY_EVIDENCE_REF = /^(event|claim):([A-Za-z0-9][A-Za-z0-9._:/-]{0,255})$/;

/**
 * Legacy identity rows are inert history. Parse their stored support once and
 * only admit exact typed references for cleanup and absence verification.
 */
export function parseLegacyIdentityEvidence(raw: unknown): LegacyIdentityEvidence {
  // Callers that read SQLite use scanLegacyIdentityRows, which checks byte
  // lengths before materialising text. This guard remains for archive input.
  if (typeof raw !== "string" || raw.length > LEGACY_IDENTITY_EVIDENCE_MAX_BYTES || Buffer.byteLength(raw, "utf8") > LEGACY_IDENTITY_EVIDENCE_MAX_BYTES) {
    return { ok: false };
  }
  let values: unknown;
  try { values = JSON.parse(raw); } catch { return { ok: false }; }
  if (!Array.isArray(values) || values.length === 0 || values.length > LEGACY_IDENTITY_EVIDENCE_MAX_REFS) {
    return { ok: false };
  }
  const refs: LegacyIdentityEvidenceRef[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length > LEGACY_IDENTITY_EVIDENCE_ID_MAX_BYTES || Buffer.byteLength(value, "utf8") > LEGACY_IDENTITY_EVIDENCE_ID_MAX_BYTES) {
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
  return db.transaction(() => {
    const result: LegacyIdentityRow[] = [];
    let after: string | null = null;
    let bytes = 0;
    let refs = 0;
    // Metadata and payload reads share one SQLite snapshot. Row keys are text
    // so even a legacy 64-bit rowid is never rounded through a JS number.
    const metadata = db.query<{ row_key: string; invalid: number; bytes: number }, [string | null, string | null]>(`
      SELECT CAST(rowid AS TEXT) AS row_key,
        (typeof(subject_a)!='text' OR length(CAST(subject_a AS BLOB))>${LEGACY_IDENTITY_ENDPOINT_MAX_BYTES}
         OR typeof(subject_b)!='text' OR length(CAST(subject_b AS BLOB))>${LEGACY_IDENTITY_ENDPOINT_MAX_BYTES}
         OR typeof(evidence)!='text' OR length(CAST(evidence AS BLOB))>${LEGACY_IDENTITY_EVIDENCE_MAX_BYTES}
         OR typeof(status)!='text' OR length(CAST(status AS BLOB))>32
         OR typeof(decided_by)!='text' OR length(CAST(decided_by AS BLOB))>1024
         OR typeof(at)!='text' OR length(CAST(at AS BLOB))>64
         OR typeof(receipt_id) NOT IN ('text','null') OR length(CAST(coalesce(receipt_id,'') AS BLOB))>256
         OR typeof(score) NOT IN ('integer','real') OR score NOT BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308) AS invalid,
        length(CAST(subject_a AS BLOB))+length(CAST(subject_b AS BLOB))+length(CAST(evidence AS BLOB))+
        length(CAST(status AS BLOB))+length(CAST(decided_by AS BLOB))+length(CAST(at AS BLOB))+
        length(CAST(coalesce(receipt_id,'') AS BLOB)) AS bytes
      FROM identity_links WHERE (? IS NULL OR rowid>CAST(? AS INTEGER)) ORDER BY rowid LIMIT ${SCAN_PAGE}`);
    while (true) {
      const page = metadata.all(after, after);
      if (page.length === 0) break;
      if (result.length + page.length > LEGACY_IDENTITY_SCAN_MAX_ROWS) throw new Error("legacy identity row limit exceeded");
      for (const item of page) {
        if (item.invalid !== 0 || !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new Error("legacy identity row is malformed or oversized");
        bytes += item.bytes;
        if (bytes > LEGACY_IDENTITY_SCAN_MAX_BYTES) throw new Error("legacy identity aggregate limit exceeded");
      }
      // Decode actual stored bytes strictly. Bun's permissive SQLite TEXT
      // conversion can lose malformed UTF-8, which cannot be an exact backup.
      const rows = db.query<{
        subject_a: Uint8Array; subject_b: Uint8Array; score: number;
        evidence: Uint8Array; status: Uint8Array; decided_by: Uint8Array;
        receipt_id: Uint8Array | null; at: Uint8Array;
      }, string[]>(`
        SELECT CAST(subject_a AS BLOB) AS subject_a,CAST(subject_b AS BLOB) AS subject_b,score,
          CAST(evidence AS BLOB) AS evidence,CAST(status AS BLOB) AS status,
          CAST(decided_by AS BLOB) AS decided_by,CAST(receipt_id AS BLOB) AS receipt_id,
          CAST(at AS BLOB) AS at
          FROM identity_links WHERE rowid IN (${page.map(() => "?").join(",")}) ORDER BY rowid`).all(...page.map(item => item.row_key));
      if (rows.length !== page.length) throw new Error("legacy identity snapshot is incomplete");
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      for (const stored of rows) {
        let row: LegacyIdentityRow;
        try {
          row = {
            subject_a: decoder.decode(stored.subject_a), subject_b: decoder.decode(stored.subject_b),
            score: stored.score, evidence: decoder.decode(stored.evidence),
            status: decoder.decode(stored.status), decided_by: decoder.decode(stored.decided_by),
            receipt_id: stored.receipt_id === null ? null : decoder.decode(stored.receipt_id),
            at: decoder.decode(stored.at),
          };
        } catch { throw new Error("legacy identity text encoding is malformed"); }
        const parsed = parseLegacyIdentityEvidence(row.evidence);
        if (parsed.ok) refs += parsed.refs.length;
        if (refs > LEGACY_IDENTITY_SCAN_MAX_REFS) throw new Error("legacy identity reference limit exceeded");
        result.push(row);
      }
      after = page.at(-1)!.row_key;
    }
    return result;
  }).deferred();
}

/** Strictly snapshot raw subjects before a purge deletes their event rows. */
export function collectLegacyPurgeSubjects(db: Database, eventIds: Iterable<string>): Set<string> {
  return db.transaction(() => {
    const refs = new Set<string>();
    let count = 0;
    let bytes = 0;
    let page: string[] = [];
    const readPage = (): void => {
      const slots = page.map(() => "?").join(",");
      const metadata = db.query<{ bytes: number; type: string }, string[]>(
        `SELECT length(CAST(subjects AS BLOB)) AS bytes,typeof(subjects) AS type FROM events WHERE event_id IN (${slots})`).all(...page);
      if (metadata.length !== page.length) throw new Error("purge subject snapshot is incomplete");
      for (const row of metadata) {
        if (row.type !== "text" || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > EVENT_LIMITS.eventBytes) throw new Error("purge subject snapshot is malformed or oversized");
        bytes += row.bytes;
        if (bytes > SUBJECT_SCAN_MAX_BYTES) throw new Error("purge subject aggregate limit exceeded");
      }
      for (const row of db.query<{ subjects: string }, string[]>(`SELECT subjects FROM events WHERE event_id IN (${slots})`).iterate(...page)) {
        let values: unknown;
        try { values = JSON.parse(row.subjects); }
        catch { throw new Error("purge subject snapshot is malformed"); }
        if (!Array.isArray(values) || values.length > EVENT_LIMITS.subjectCount) throw new Error("purge subject snapshot is malformed");
        const seen = new Set<string>();
        for (const value of values) {
          if (!isPlainObject(value) || Object.keys(value).some(key => !["subject_id", "role", "display_name"].includes(key)) ||
              typeof value.subject_id !== "string" || value.subject_id.length === 0 || value.subject_id.length > EVENT_LIMITS.subjectIdBytes ||
              Buffer.byteLength(value.subject_id, "utf8") > EVENT_LIMITS.subjectIdBytes || !isVisibleIdentifier(value.subject_id) ||
              typeof value.role !== "string" || !(SUBJECT_ROLES as readonly string[]).includes(value.role) ||
              (value.display_name !== undefined && (typeof value.display_name !== "string" || value.display_name.length > EVENT_LIMITS.displayNameBytes || Buffer.byteLength(value.display_name, "utf8") > EVENT_LIMITS.displayNameBytes))) {
            throw new Error("purge subject snapshot is malformed");
          }
          const key = `${value.subject_id}\0${value.role}`;
          if (seen.has(key)) throw new Error("purge subject snapshot has duplicate subjects");
          seen.add(key);
          refs.add(value.subject_id);
        }
      }
      page = [];
    };
    for (const id of eventIds) {
      if (++count > SUBJECT_SCAN_MAX_EVENTS) throw new Error("purge subject event limit exceeded");
      page.push(id);
      if (page.length === SCAN_PAGE) readPage();
    }
    if (page.length > 0) readPage();
    return refs;
  }).deferred();
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

/** Historical compatibility constant; A0 provides no identity authority. */
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
