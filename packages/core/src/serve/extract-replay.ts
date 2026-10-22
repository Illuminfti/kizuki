import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import { parseWorldAdmission, completeWorldAnchors } from "../contracts/world-admission";
import { semanticKey, supportKey } from "../claims/claim-v2-keys";
import { readClaimV2Semantic } from "../claims/claim-v2-commit";
import { groundingDigest, validateWorldAdmissionProofs, witnessEventIds } from "../claims/world-grounding";
import { isUtf16TextBoundary } from "../contracts/producer-v2";
import { assertPositiveAuthorityMutationAllowed } from "../canon/positive-authority";
import { inspectCanonRecovery } from "../canon/write-intent";
import { readRailCursor } from "../ledger/checkpoints";
import { readLiveEvent } from "../ledger/ledger";
import { tableExists } from "../ledger/schema";
import { validateEventOrigin } from "../ledger/event-origin";
import { inspectSourceGrant, sourceEventsAllowed, sourcePolicyEpoch, sourcePortBindingDigest } from "../ledger/source-grants";
import { modelProducerFingerprint } from "../producer/fingerprint";
import { canonicalJson, sha256Hex } from "../util/hash";
import { isRfc3339 } from "../util/time";
import { isUlid } from "../util/ulid";
import { isPlainObject } from "../util/validate";
import { withVaultMutationSync } from "../vault/mutation-scope";
import { acquireLease, leaseState, releaseLease, thisProcess } from "./leases";
import { readVaultId } from "./vault-id";

const SCHEMA = "kizuki.extract-empty-replay/v1" as const;
const MAX_PLAN_BYTES = 16_384;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const token = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => isPlainObject(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property !== undefined && property.enumerable && Object.hasOwn(property, "value");
  });

export class ExtractReplayError extends Error {
  constructor(readonly code: "invalid_plan" | "replay_conflict" | "writer_busy" | "unsettled_work" | "source_changed" |
    "producer_changed" | "historical_evidence_invalid" | "claims_present" | "segment_changed") {
    super(`empty segment replay refused: ${code}`); this.name = "ExtractReplayError";
  }
}
function refuse(code: ExtractReplayError["code"]): never { throw new ExtractReplayError(code); }

export interface EmptySegmentReplayPlan {
  readonly schema: typeof SCHEMA;
  readonly operation_id: string;
  readonly vault_id: string;
  readonly event_id: string;
  readonly connector_id: string;
  readonly source_key: string;
  readonly content_hash: string;
  readonly text_hash: string;
  readonly source_revision: number;
  readonly source_policy_digest: string;
  readonly source_epoch: number;
  readonly model_binding_digest: string;
  readonly expected_cursor: string | null;
  readonly segment: { readonly status: "segmenting"; readonly chars: number; readonly done_utf16: number;
    readonly pending_end_utf16: null; readonly updated_at: string };
  readonly old_run_id: string;
  /** SHA256 of the exact retained run_receipts.report UTF-8 bytes. */
  readonly old_run_receipt_sha256: string;
  readonly old_producer_fingerprint: string;
  readonly new_producer_fingerprint: string;
  readonly new_qualification_sha256: string;
  readonly new_review_sha256: string;
  readonly historical_evidence: {
    readonly kind: "owner_attested_legacy_empty";
    readonly old_source_commit: string;
    readonly old_prompt_sha256: string;
    readonly old_gate_sha256: string;
    readonly old_input_plan_sha256: string;
    readonly independent_review_sha256: string;
    readonly legacy_metadata_sha256: string;
    readonly allowed_errors_sha256: string | null;
    readonly capture_denial_proof_sha256: string | null;
  };
  readonly reason: "producer_false_negative_repair";
}
const PLAN_KEYS = ["schema", "operation_id", "vault_id", "event_id", "connector_id", "source_key", "content_hash", "text_hash",
  "source_revision", "source_policy_digest", "source_epoch", "model_binding_digest", "expected_cursor", "segment", "old_run_id",
  "old_run_receipt_sha256", "old_producer_fingerprint", "new_producer_fingerprint", "new_qualification_sha256", "new_review_sha256",
  "historical_evidence", "reason"] as const;

/** Closed owner-local attestation. Its hashes bind review evidence; they do not
 * prove hidden historical model content. All current authority is re-read below. */
export function parseEmptySegmentReplayPlan(value: unknown): EmptySegmentReplayPlan {
  if (!exact(value, PLAN_KEYS) || value.schema !== SCHEMA || value.reason !== "producer_false_negative_repair" ||
      !token(value.operation_id) || !token(value.vault_id) || !isUlid(value.event_id) || !token(value.connector_id) || !token(value.source_key) ||
      !token(value.old_run_id) || !Number.isSafeInteger(value.source_revision) || Number(value.source_revision) < 1 ||
      !Number.isSafeInteger(value.source_epoch) || Number(value.source_epoch) < 1 ||
      !["content_hash", "text_hash", "source_policy_digest", "model_binding_digest", "old_run_receipt_sha256",
        "old_producer_fingerprint", "new_producer_fingerprint", "new_qualification_sha256", "new_review_sha256"].every(key => hash(value[key])) ||
      value.old_producer_fingerprint === value.new_producer_fingerprint ||
      !(value.expected_cursor === null || typeof value.expected_cursor === "string" && value.expected_cursor.length <= 256 && !value.expected_cursor.includes("\0"))) refuse("invalid_plan");
  const s = value.segment;
  if (!exact(s, ["status", "chars", "done_utf16", "pending_end_utf16", "updated_at"]) || s.status !== "segmenting" ||
      !Number.isSafeInteger(s.chars) || !Number.isSafeInteger(s.done_utf16) || Number(s.done_utf16) <= 0 || Number(s.chars) <= Number(s.done_utf16) ||
      s.pending_end_utf16 !== null || typeof s.updated_at !== "string" || !isRfc3339(s.updated_at)) refuse("invalid_plan");
  const e = value.historical_evidence;
  if (!exact(e, ["kind", "old_source_commit", "old_prompt_sha256", "old_gate_sha256", "old_input_plan_sha256", "independent_review_sha256",
      "legacy_metadata_sha256", "allowed_errors_sha256", "capture_denial_proof_sha256"]) ||
      e.kind !== "owner_attested_legacy_empty" || typeof e.old_source_commit !== "string" || !/^[a-f0-9]{40}$/.test(e.old_source_commit) ||
      ![e.old_prompt_sha256, e.old_gate_sha256, e.old_input_plan_sha256, e.independent_review_sha256, e.legacy_metadata_sha256].every(hash) ||
      !(e.allowed_errors_sha256 === null && e.capture_denial_proof_sha256 === null ||
        hash(e.allowed_errors_sha256) && hash(e.capture_denial_proof_sha256))) refuse("invalid_plan");
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded) > MAX_PLAN_BYTES) refuse("invalid_plan");
  return JSON.parse(encoded) as EmptySegmentReplayPlan;
}

export interface EmptySegmentReplayReceipt {
  readonly status: "accepted" | "already_applied";
  readonly operation_id: string;
  readonly plan_sha256: string;
  readonly event_id: string;
  readonly start_utf16: 0;
  readonly end_utf16: number;
  readonly created_at: string;
}
interface ReplayRow { operation_id: string; event_id: string; plan_sha256: string; plan: string; created_at: string }
function storedPlan(row: ReplayRow): EmptySegmentReplayPlan {
  if (Buffer.byteLength(row.plan) > MAX_PLAN_BYTES || sha256Hex(row.plan) !== row.plan_sha256) refuse("replay_conflict");
  let value: unknown; try { value = JSON.parse(row.plan); } catch { refuse("replay_conflict"); }
  const plan = parseEmptySegmentReplayPlan(value);
  if (canonicalJson(plan) !== row.plan || plan.operation_id !== row.operation_id || plan.event_id !== row.event_id) refuse("replay_conflict");
  return plan;
}
function receipt(row: ReplayRow, plan: EmptySegmentReplayPlan, status: EmptySegmentReplayReceipt["status"]): EmptySegmentReplayReceipt {
  return { status, operation_id: row.operation_id, plan_sha256: row.plan_sha256, event_id: row.event_id,
    start_utf16: 0, end_utf16: plan.segment.done_utf16, created_at: row.created_at };
}

/** Shared live fence for acceptance and ordinary replay requests/settlement. */
function liveInput(db: Database, producer: object, plan: EmptySegmentReplayPlan): CaptureEvent {
  assertPositiveAuthorityMutationAllowed(db);
  if (modelProducerFingerprint(producer) !== plan.new_producer_fingerprint || sourcePortBindingDigest(producer) !== plan.model_binding_digest) refuse("producer_changed");
  const event = readLiveEvent(db, plan.event_id);
  const binding = db.query<{ source_key: string }, [string]>("SELECT source_key FROM source_event_bindings WHERE event_id=?").get(plan.event_id);
  const grant = inspectSourceGrant(db, plan.source_key);
  if (event === null || event.connector_id !== plan.connector_id || event.content_hash !== plan.content_hash || event.text_hash !== plan.text_hash ||
      event.text.length !== plan.segment.chars || !isUtf16TextBoundary(event.text, plan.segment.done_utf16) ||
      validateEventOrigin(db, event).origin !== "external" || binding?.source_key !== plan.source_key ||
      grant?.status !== "active" || grant.revision !== plan.source_revision || grant.policy_digest !== plan.source_policy_digest ||
      sourcePolicyEpoch(db) !== plan.source_epoch ||
      !sourceEventsAllowed(db, [plan.event_id], { owner: false, purpose: "extract", model: true, port: producer })) refuse("source_changed");
  return event;
}

/** Every status participates. Only valid typed anchors can prove disjointness;
 * a legacy provenance-only claim never authorizes replay over its evidence. */
function requireNoModelClaims(db: Database, eventId: string, start: number, end: number, text: string): void {
  try { validateModelClaimAbsence(db, eventId, start, end, text); }
  catch { refuse("claims_present"); }
}
function validateModelClaimAbsence(db: Database, eventId: string, start: number, end: number, text: string): void {
  if (db.query("SELECT 1 FROM claims WHERE producer IN ('model','llm') AND NOT json_valid(provenance) LIMIT 1").get() !== null) refuse("claims_present");
  if (db.query(`SELECT 1 FROM claims c WHERE producer IN ('model','llm') AND (
      json_type(provenance)<>'array' OR json_array_length(provenance) NOT BETWEEN 1 AND 256 OR
      EXISTS(SELECT 1 FROM json_each(c.provenance) p WHERE p.type<>'text' OR length(p.value)<>26 OR p.value GLOB '*[^0-9A-HJKMNP-TV-Z]*')) LIMIT 1`).get() !== null) refuse("claims_present");
  const rows = db.query<{ claim_id: string; status: string; is_world_typed: number }, [string, string]>(`SELECT c.claim_id,c.status,c.is_world_typed FROM claims c WHERE c.producer IN ('model','llm') AND (
      EXISTS(SELECT 1 FROM json_each(c.provenance) p WHERE p.value=?) OR
      EXISTS(SELECT 1 FROM claim_v2_support s JOIN claim_v2_support_events e USING(support_key) WHERE s.claim_id=c.claim_id AND e.event_id=?)
    ) LIMIT 1025`).all(eventId, eventId);
  if (rows.length > 1024) refuse("claims_present");
  for (const claim of rows) {
    if (claim.is_world_typed !== 1 || db.query("SELECT 1 FROM claim_v2_semantics WHERE claim_id=? AND octet_length(payload)>524288").get(claim.claim_id) !== null) refuse("claims_present");
    if (db.query(`SELECT 1 FROM claim_v2_support WHERE claim_id=? AND (octet_length(admission)>524288 OR octet_length(anchors)>65536) LIMIT 1`).get(claim.claim_id) !== null) refuse("claims_present");
    const support = db.query<{ support_key: string; anchors: string; admission: string; source_key: string; grant_revision: number; support_origin: string }, [string, string]>(`SELECT s.* FROM claim_v2_support s JOIN claim_v2_support_events e USING(support_key)
      WHERE s.claim_id=? AND e.event_id=? LIMIT 1025`).all(claim.claim_id, eventId);
    if (support.length === 0 || support.length > 1024) refuse("claims_present");
    let located = false;
    for (const row of support) {
      let parsed: unknown; try { parsed = JSON.parse(row.admission); } catch { refuse("claims_present"); }
      const admission = parseWorldAdmission(parsed), meaning = readClaimV2Semantic(db, claim.claim_id);
      if (admission === null || meaning === null || row.support_origin !== "source" || semanticKey(meaning) !== semanticKey(admission.semantic)) refuse("claims_present");
      const anchors = completeWorldAnchors(admission.semantic);
      const grounding = validateWorldAdmissionProofs(db, admission, row.source_key, { restore: true });
      const events = db.query<{ event_id: string; event_content_hash: string }, [string]>(
        "SELECT event_id,event_content_hash FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id LIMIT 65").all(row.support_key);
      if (anchors.length === 0 || anchors.length > 256 || events.length === 0 || events.length > 64 ||
          row.anchors !== canonicalJson(anchors) || supportKey({ support_origin: "source", grounding_digest: groundingDigest(admission),
            semantic_key: semanticKey(admission.semantic), source_key: row.source_key, grant_revision: row.grant_revision, events, anchors }) !== row.support_key) refuse("claims_present");
      if (admission.schema === "kizuki.world-admission/v2") {
        const required = new Set([...witnessEventIds(admission), ...grounding.map(event => event.event_id)]);
        if (required.size !== events.length || events.some(event => !required.has(event.event_id))) refuse("claims_present");
      }
      for (const identity of events) {
        const current = readLiveEvent(db, identity.event_id);
        const source = db.query<{ source_key: string }, [string]>("SELECT source_key FROM source_event_bindings WHERE event_id=?").get(identity.event_id);
        if (current === null || current.content_hash !== identity.event_content_hash || validateEventOrigin(db, current).origin !== "external" ||
            source?.source_key !== row.source_key && !grounding.some(event => event.event_id === identity.event_id && event.event_content_hash === identity.event_content_hash)) refuse("claims_present");
      }
      for (const anchor of anchors) {
        if (!exact(anchor, ["event_id", "start_utf16", "end_utf16"]) || !isUlid(anchor.event_id) ||
            !Number.isSafeInteger(anchor.start_utf16) || !Number.isSafeInteger(anchor.end_utf16) ||
            Number(anchor.start_utf16) < 0 || Number(anchor.end_utf16) <= Number(anchor.start_utf16)) refuse("claims_present");
        if (!events.some(identity => identity.event_id === anchor.event_id)) refuse("claims_present");
        if (anchor.event_id !== eventId) continue;
        if (Number(anchor.end_utf16) > text.length || !isUtf16TextBoundary(text, Number(anchor.start_utf16)) ||
            !isUtf16TextBoundary(text, Number(anchor.end_utf16))) refuse("claims_present");
        located = true;
        if (Number(anchor.start_utf16) < end && Number(anchor.end_utf16) > start || claim.status !== "live") refuse("claims_present");
      }
    }
    if (!located) refuse("claims_present");
  }
  // A missing parent is corruption, not evidence of zero prior claims.
  if (db.query(`SELECT 1 FROM claim_v2_support_events e JOIN claim_v2_support s USING(support_key)
      LEFT JOIN claims c USING(claim_id) WHERE e.event_id=? AND c.claim_id IS NULL LIMIT 1`).get(eventId) !== null) refuse("claims_present");
}

function requireHistoricalEmpty(db: Database, plan: EmptySegmentReplayPlan): void {
  const row = db.query<{ report: string; rail: string; status: string; stopped: string | null }, [string]>("SELECT report,rail,status,stopped FROM run_receipts WHERE run_id=?").get(plan.old_run_id);
  if (row === null || Buffer.byteLength(row.report) > 1_048_576 || sha256Hex(row.report) !== plan.old_run_receipt_sha256) refuse("historical_evidence_invalid");
  let run: unknown; try { run = JSON.parse(row.report); } catch { refuse("historical_evidence_invalid"); }
  if (!isPlainObject(run) || run.run_id !== plan.old_run_id || run.rail !== "sync" || run.sync_mode !== undefined || row.rail !== run.rail || row.status !== run.status || row.stopped !== run.stopped ||
      (run.status !== "ok" && run.status !== "degraded") || run.stopped !== null || !Array.isArray(run.errors) ||
      run.errors.length > 32 || !run.errors.every(error => typeof error === "string") ||
      run.has_more !== true || run.canon_reverts !== 0 || run.claims_written_extracted !== 0 || run.claims_deduped !== 0 || run.claims_superseded !== 0 || run.records_skipped !== 0 ||
      run.claims_extracted !== 0 || !isPlainObject(run.claims_rejected) || Object.keys(run.claims_rejected).length !== 0 ||
      !isPlainObject(run.model) || run.model.calls !== 1 || run.model.answered !== 1 || run.model.usage_unknown === true ||
      run.model.last_request !== "answered" || run.model.unavailable !== 0 ||
      !Number.isSafeInteger(run.model.input_tokens) || Number(run.model.input_tokens) < 0 ||
      !Number.isSafeInteger(run.model.output_tokens) || Number(run.model.output_tokens) < 0 ||
      !isPlainObject(run.oversized) || run.oversized.segments !== 1 || run.oversized.skipped !== 0) refuse("historical_evidence_invalid");
  const evidence = plan.historical_evidence;
  if (run.status === "ok" ? run.errors.length !== 0 || evidence.allowed_errors_sha256 !== null || evidence.capture_denial_proof_sha256 !== null :
      run.errors.length !== 1 || evidence.allowed_errors_sha256 !== sha256Hex(canonicalJson(run.errors)) || evidence.capture_denial_proof_sha256 === null) refuse("historical_evidence_invalid");
}

/** Metadata-only repair. Existing leases, flock and immediate SQLite commit are
 * the only mutation path; this operation never calls the producer. */
export function replayEmptyExtractSegment(target: { readonly db: Database; readonly vault_path: string; readonly producer: object }, raw: unknown): EmptySegmentReplayReceipt {
  const plan = parseEmptySegmentReplayPlan(raw), { db, vault_path, producer } = target;
  if (db.inTransaction) refuse("unsettled_work");
  const encoded = canonicalJson(plan), digest = sha256Hex(encoded);
  return withVaultMutationSync({ db, vault_path }, () => {
    const process = thisProcess();
    if (leaseState(db, process) !== "free") refuse("writer_busy");
    if (!acquireLease(db, process).acquired) refuse("writer_busy");
    try {
      return db.transaction(() => {
        if (readVaultId(vault_path) !== plan.vault_id) refuse("replay_conflict");
        const prior = db.query<ReplayRow, [string]>("SELECT * FROM extract_replay_receipts WHERE operation_id=?").get(plan.operation_id);
        if (prior !== null) {
          const original = storedPlan(prior);
          if (prior.plan_sha256 !== digest) refuse("replay_conflict");
          return receipt(prior, original, "already_applied");
        }
        // V1 authorizes one first-prefix repair per event, never a replay chain.
        if (db.query("SELECT 1 FROM extract_replay_receipts WHERE event_id=? LIMIT 1").get(plan.event_id) !== null) refuse("replay_conflict");
        if (db.query("SELECT 1 FROM extract_batches LIMIT 1").get() !== null || db.query("SELECT 1 FROM extract_usage LIMIT 1").get() !== null ||
            inspectCanonRecovery(db).pending || db.query("SELECT 1 FROM purge_ops WHERE state<>'done' LIMIT 1").get() !== null) refuse("unsettled_work");
        const event = liveInput(db, producer, plan);
        requireHistoricalEmpty(db, plan);
        requireNoModelClaims(db, plan.event_id, 0, plan.segment.done_utf16, event.text);
        if (readRailCursor(db, "kizuki.producer.model", "extract") !== plan.expected_cursor) refuse("segment_changed");
        const current = db.query<{ status: string; chars: number; done_utf16: number; pending_end_utf16: number | null; updated_at: string; replay_operation_id: string | null }, [string]>(
          "SELECT status,chars,done_utf16,pending_end_utf16,updated_at,replay_operation_id FROM extract_oversized_records WHERE event_id=?").get(plan.event_id);
        if (current === null || current.replay_operation_id !== null || canonicalJson({ status: current.status, chars: current.chars,
          done_utf16: current.done_utf16, pending_end_utf16: current.pending_end_utf16, updated_at: current.updated_at }) !== canonicalJson(plan.segment)) refuse("segment_changed");
        if (db.query("SELECT 1 FROM extract_oversized_records WHERE replay_operation_id IS NOT NULL LIMIT 1").get() !== null) refuse("unsettled_work");
        const at = new Date().toISOString();
        db.query("INSERT INTO extract_replay_receipts VALUES(?,?,?,?,?)").run(plan.operation_id, plan.event_id, digest, encoded, at);
        const changed = db.query(`UPDATE extract_oversized_records SET done_utf16=0,updated_at=?,replay_operation_id=?
          WHERE event_id=? AND status='segmenting' AND chars=? AND done_utf16=? AND pending_end_utf16 IS NULL AND updated_at=? AND replay_operation_id IS NULL`).run(
          at, plan.operation_id, plan.event_id, plan.segment.chars, plan.segment.done_utf16, plan.segment.updated_at);
        if (changed.changes !== 1) refuse("segment_changed");
        return receipt({ operation_id: plan.operation_id, event_id: plan.event_id, plan_sha256: digest, plan: encoded, created_at: at }, plan, "accepted");
      }).immediate();
    } finally { releaseLease(db, process); }
  });
}

export interface ActiveExtractReplay { readonly operation_id: string; readonly end_utf16: number }
/** No special request writer: ordinary extraction asks this fence for its cap. */
export function activeExtractReplay(db: Database, eventId: string, producer: object, checkClaims = true): ActiveExtractReplay | null {
  if (!tableExists(db, "extract_replay_receipts")) return null;
  return db.transaction(() => {
    const row = db.query<ReplayRow, [string]>(`SELECT r.* FROM extract_oversized_records p JOIN extract_replay_receipts r ON r.operation_id=p.replay_operation_id WHERE p.event_id=?`).get(eventId);
    if (row === null) return null;
    const plan = storedPlan(row);
    const event = liveInput(db, producer, plan);
    if (readRailCursor(db, "kizuki.producer.model", "extract") !== plan.expected_cursor) refuse("segment_changed");
    const progress = db.query<{ status: string; chars: number; done_utf16: number; pending_end_utf16: number | null }, [string]>(
      "SELECT status,chars,done_utf16,pending_end_utf16 FROM extract_oversized_records WHERE event_id=?").get(eventId);
    if (progress === null || progress.status !== "segmenting" || progress.chars !== plan.segment.chars ||
        !Number.isSafeInteger(progress.done_utf16) || progress.done_utf16 < 0 || progress.done_utf16 >= plan.segment.done_utf16 ||
        !isUtf16TextBoundary(event.text, progress.done_utf16) || progress.pending_end_utf16 !== null &&
        (!Number.isSafeInteger(progress.pending_end_utf16) || progress.pending_end_utf16 <= progress.done_utf16 ||
          progress.pending_end_utf16 > plan.segment.done_utf16 || !isUtf16TextBoundary(event.text, progress.pending_end_utf16))) refuse("segment_changed");
    if (checkClaims) requireNoModelClaims(db, eventId, progress.done_utf16, plan.segment.done_utf16, event.text);
    return { operation_id: row.operation_id, end_utf16: plan.segment.done_utf16 };
  }).immediate();
}

/** Fence before ordinary selection can defer or pass over a revoked replay.
 * One active replay is allowed, and unrelated input is never sent in its pass. */
export function activeExtractReplayEvent(db: Database, producer: object): string | null {
  if (!tableExists(db, "extract_replay_receipts")) return null;
  const rows = db.query<{ event_id: string }, []>("SELECT event_id FROM extract_oversized_records WHERE replay_operation_id IS NOT NULL LIMIT 2").all();
  if (rows.length > 1) refuse("replay_conflict");
  const eventId = rows[0]?.event_id;
  if (eventId === undefined) return null;
  if (activeExtractReplay(db, eventId, producer) === null) refuse("replay_conflict");
  return eventId;
}

/** Runs inside existing segment completion, atomically with its progress. */
export function completeExtractReplay(db: Database, eventId: string, end: number): void {
  if (!db.inTransaction) throw new Error("replay completion requires a transaction");
  if (!tableExists(db, "extract_replay_receipts")) return;
  const row = db.query<ReplayRow, [string]>(`SELECT r.* FROM extract_oversized_records p JOIN extract_replay_receipts r ON r.operation_id=p.replay_operation_id WHERE p.event_id=?`).get(eventId);
  if (row === null) return;
  const plan = storedPlan(row);
  if (end > plan.segment.done_utf16) refuse("segment_changed");
  if (end === plan.segment.done_utf16) db.query("UPDATE extract_oversized_records SET replay_operation_id=NULL WHERE event_id=? AND replay_operation_id=?").run(eventId, row.operation_id);
}

export interface SegmentSettlement {
  readonly event_id: string; readonly start: number; readonly end: number; readonly chars: number;
  readonly content_hash: string; readonly producer_fingerprint: string; readonly model_binding_digest: string;
  readonly replay_operation_id: string | null;
}
export function recordSegmentSettlement(db: Database, decision: SegmentSettlement, runId: string, outcome: "empty" | "nonempty"): void {
  if (!db.inTransaction) throw new Error("segment settlement requires a transaction");
  if (!tableExists(db, "extract_segment_settlements")) return;
  const id = sha256Hex(canonicalJson([runId, outcome, decision]));
  db.query("INSERT OR IGNORE INTO extract_segment_settlements VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, decision.event_id, runId,
    decision.content_hash, decision.start, decision.end, decision.chars, decision.producer_fingerprint, decision.model_binding_digest,
    outcome, decision.replay_operation_id, new Date().toISOString());
}

export const EXTRACT_REPLAY_BACKUPS = [
  { path: "serve/extract-replay-receipts.jsonl", table: "extract_replay_receipts", key: "operation_id" },
  { path: "serve/extract-segment-settlements.jsonl", table: "extract_segment_settlements", key: "decision_id" },
] as const;
type ReplayBackup = typeof EXTRACT_REPLAY_BACKUPS[number];

function validateBackupRow(db: Database, spec: ReplayBackup, raw: Record<string, unknown>): void {
  if (spec.table === "extract_replay_receipts") {
    if (!exact(raw, ["operation_id", "event_id", "plan_sha256", "plan", "created_at"]) || !token(raw.operation_id) || !isUlid(raw.event_id) ||
        !hash(raw.plan_sha256) || typeof raw.plan !== "string" || typeof raw.created_at !== "string" || !isRfc3339(raw.created_at)) refuse("replay_conflict");
    const plan = storedPlan({ operation_id: raw.operation_id, event_id: raw.event_id, plan_sha256: raw.plan_sha256, plan: raw.plan, created_at: raw.created_at });
    const event = db.query<{ content_hash: string; text_hash: string }, [string]>("SELECT content_hash,text_hash FROM events WHERE event_id=?").get(plan.event_id);
    if (event?.content_hash !== plan.content_hash || event.text_hash !== plan.text_hash) refuse("replay_conflict");
    return;
  }
  const columns = ["decision_id", "event_id", "run_id", "content_hash", "start_utf16", "end_utf16", "chars", "producer_fingerprint",
    "model_binding_digest", "outcome", "replay_operation_id", "created_at"];
  if (!exact(raw, columns) || !hash(raw.decision_id) || !isUlid(raw.event_id) || !token(raw.run_id) || !hash(raw.content_hash) ||
      !hash(raw.producer_fingerprint) || !hash(raw.model_binding_digest) || (raw.outcome !== "empty" && raw.outcome !== "nonempty") ||
      !(raw.replay_operation_id === null || token(raw.replay_operation_id)) || typeof raw.created_at !== "string" || !isRfc3339(raw.created_at) ||
      ![raw.start_utf16, raw.end_utf16, raw.chars].every(Number.isSafeInteger) || Number(raw.start_utf16) < 0 ||
      Number(raw.end_utf16) <= Number(raw.start_utf16) || Number(raw.end_utf16) > Number(raw.chars)) refuse("replay_conflict");
  const event = db.query<{ content_hash: string; text: string }, [string]>("SELECT content_hash,text FROM events WHERE event_id=?").get(raw.event_id);
  if (event?.content_hash !== raw.content_hash || event.text.length !== raw.chars ||
      !isUtf16TextBoundary(event.text, Number(raw.start_utf16)) || !isUtf16TextBoundary(event.text, Number(raw.end_utf16))) refuse("replay_conflict");
  const decision: SegmentSettlement = { event_id: raw.event_id, start: Number(raw.start_utf16), end: Number(raw.end_utf16), chars: Number(raw.chars),
    content_hash: raw.content_hash, producer_fingerprint: raw.producer_fingerprint, model_binding_digest: raw.model_binding_digest,
    replay_operation_id: raw.replay_operation_id };
  if (sha256Hex(canonicalJson([raw.run_id, raw.outcome, decision])) !== raw.decision_id) refuse("replay_conflict");
  if (raw.replay_operation_id !== null) {
    const row = db.query<ReplayRow, [string]>("SELECT * FROM extract_replay_receipts WHERE operation_id=?").get(raw.replay_operation_id);
    if (row === null) refuse("replay_conflict");
    const plan = storedPlan(row);
    if (plan.event_id !== raw.event_id || plan.new_producer_fingerprint !== raw.producer_fingerprint || Number(raw.end_utf16) > plan.segment.done_utf16) refuse("replay_conflict");
  }
}

/** Fixed identifiers only; bounded pages and cells before payload admission. */
export function* extractReplayBackupRows(db: Database, spec: ReplayBackup): Generator<Record<string, unknown>> {
  if (!tableExists(db, spec.table)) return;
  let after = "";
  while (true) {
    if (spec.table === "extract_replay_receipts" && db.query("SELECT 1 FROM extract_replay_receipts WHERE octet_length(plan)>16384 LIMIT 1").get() !== null) refuse("replay_conflict");
    const rows = db.query<Record<string, unknown>, [string]>(`SELECT * FROM ${spec.table} WHERE ${spec.key}>? ORDER BY ${spec.key} LIMIT 256`).all(after);
    for (const row of rows) { validateBackupRow(db, spec, row); yield row; }
    if (rows.length < 256) return;
    after = String(rows.at(-1)![spec.key]);
  }
}

export function restoreExtractReplayRow(db: Database, spec: ReplayBackup, row: Record<string, unknown>): void {
  validateBackupRow(db, spec, row);
  if (spec.table === "extract_replay_receipts") {
    db.query("INSERT INTO extract_replay_receipts VALUES(?,?,?,?,?)").run(String(row.operation_id), String(row.event_id), String(row.plan_sha256), String(row.plan), String(row.created_at));
  } else {
    db.query("INSERT INTO extract_segment_settlements VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(String(row.decision_id), String(row.event_id), String(row.run_id),
      String(row.content_hash), Number(row.start_utf16), Number(row.end_utf16), Number(row.chars), String(row.producer_fingerprint), String(row.model_binding_digest),
      String(row.outcome), row.replay_operation_id === null ? null : String(row.replay_operation_id), String(row.created_at));
  }
}

export function validateRestoredReplayLink(db: Database, eventId: string, operationId: string, done: number, chars: number, pending: number | null): void {
  const row = db.query<ReplayRow, [string]>("SELECT * FROM extract_replay_receipts WHERE operation_id=?").get(operationId);
  if (row === null) refuse("replay_conflict");
  const plan = storedPlan(row);
  if (plan.event_id !== eventId || plan.segment.chars !== chars || done >= plan.segment.done_utf16 ||
      pending !== null && pending > plan.segment.done_utf16) refuse("replay_conflict");
}
