import type { Database } from "bun:sqlite";
import { requireSourceEvents, sourcePolicyEpoch } from "../ledger/source-grants";
import { MAX_CANON_IMAGE_BYTES, MAX_CANON_INTENT_BYTES, MAX_CANON_IDENTITY_BINDINGS } from "../ledger/canon-recovery-schema";
import { sha256Hex } from "../util/hash";
import { isPlainObject } from "../util/validate";
import { isUlid } from "../util/ulid";
import { isRfc3339 } from "../util/time";
import { parseFrontmatter, serializePage } from "../vault/frontmatter";
import { validatePage } from "../vault/schema";
import { ABSENT_PAGE_HASH, archiveRelPath, canonStageRelPath, hashBytes } from "../vault/write";
import { eventIdFromReference } from "../retrieval/ids";
import { assertPageRelPath, assertReceiptPaths } from "./paths";
import { latestReceiptForPage, getCanonReceipt, type CanonReceipt } from "./receipts";
import { pageIndexByPath } from "./store";
import { validateOrdinaryReceiptCheckpoint, type OrdinaryReceiptCheckpoint } from "./receipt-stream";

export type CanonRecoveryReason = "intent_invalid" | "recovery_pending" | "nested_transaction" |
  "authority_changed" | "predecessor_changed" | "page_changed" | "archive_changed" |
  "historical_orphan" | "receipt_changed" | "stage_custody_unknown" | "projection_pending";
export class CanonRecoveryError extends Error {
  readonly code = "canon_recovery_needed";
  constructor(readonly reason: CanonRecoveryReason, readonly receipt_id: string | null = null) {
    super(`canon recovery needed: ${reason}`); this.name = "CanonRecoveryError";
  }
}
export function recoveryFailure(reason: CanonRecoveryReason, receiptId: string | null = null): never {
  throw new CanonRecoveryError(reason, receiptId);
}
export interface CanonCompletion {
  mode: "write" | "purge" | "revert";
  claim_kind: string;
  page_id: string | null;
  subject_key: string | null;
  original_receipt_id: string | null;
}
interface Guard { id: string; digest: string }
export interface CanonAdmission {
  source_epoch: number;
  claims: Guard[];
  events: Guard[];
  sources: { source_key: string; event_id: string }[];
  derive_ids: string[];
  predecessor_digest: string;
  original_digest: string;
  page_index_digest: string;
  supersessions_digest: string;
  claim_bindings_digest: string;
}
export interface CanonWriteIntent {
  version: 1;
  receipt: CanonReceipt;
  before_base64: string | null;
  after_base64: string | null;
  completion: CanonCompletion;
  admission: CanonAdmission;
  checkpoint: OrdinaryReceiptCheckpoint;
  stages: { live_stage: string; archive_stage: string | null };
}
export interface CanonRecoverySummary {
  pending: boolean;
  receipt_id: string | null;
  page_path: string | null;
  projection_pending: number;
  generation: number;
}

const MAX_BINDINGS = MAX_CANON_IDENTITY_BINDINGS;
const HASH = /^[0-9a-f]{64}$/;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });
function digest(value: unknown): string { return sha256Hex(JSON.stringify(value)); }
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) recoveryFailure("intent_invalid");
}
function text(value: unknown, max = 1024): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || value.includes("\0")) recoveryFailure("intent_invalid");
}
function id(value: unknown): asserts value is string { text(value); if (!value.length) recoveryFailure("intent_invalid"); }
function hash(value: unknown): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) recoveryFailure("intent_invalid"); }
function nullableText(value: unknown): void { if (value !== null) id(value); }
function array(value: unknown, max = MAX_BINDINGS): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) recoveryFailure("intent_invalid");
}
function ids(value: unknown): asserts value is string[] { array(value); for (const item of value) id(item); if (new Set(value).size !== value.length) recoveryFailure("intent_invalid"); }
function oneOf(value: unknown, values: readonly string[]): void { if (typeof value !== "string" || !values.includes(value)) recoveryFailure("intent_invalid"); }
function guards(value: unknown): void { array(value); const seen = new Set<string>(); for (const item of value) { object(item, ["id", "digest"]); id(item.id); hash(item.digest); if (seen.has(item.id)) recoveryFailure("intent_invalid"); seen.add(item.id); } }

export function decodeCanonImage(value: string | null): Buffer | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 4 * Math.ceil(MAX_CANON_IMAGE_BYTES / 3)) recoveryFailure("intent_invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_CANON_IMAGE_BYTES || bytes.toString("base64") !== value) recoveryFailure("intent_invalid");
  try { FATAL_UTF8.decode(bytes); } catch { recoveryFailure("intent_invalid"); }
  return bytes;
}

/** Closed receipt data, rather than the permissive legacy log reader. */
export function validateCanonIntentReceipt(value: unknown): asserts value is CanonReceipt {
  object(value, ["receipt_id", "kind", "claim_ids", "page_path", "page_action", "before_hash", "after_hash", "archive_path", "writer", "producer", "model_ref", "authority", "confidence", "sensitivity", "taint", "provenance", "superseded", "candidates", "retrieval_ops", "reverts", "reverted_by", "at"]);
  if (!isUlid(value.receipt_id)) recoveryFailure("intent_invalid");
  oneOf(value.kind, ["write", "revert", "purge_rewrite"]);
  ids(value.claim_ids); id(value.page_path); assertPageRelPath(value.page_path);
  oneOf(value.page_action, ["create", "edit", "archive"]);
  if (value.before_hash !== null) hash(value.before_hash); hash(value.after_hash);
  nullableText(value.archive_path); oneOf(value.writer, ["loop", "correction", "revert", "import"]);
  if (typeof value.producer !== "string" || (!/^(deterministic|model|owner)$/.test(value.producer) && !/^agent:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.producer))) recoveryFailure("intent_invalid");
  nullableText(value.model_ref);
  oneOf(value.authority, ["owner_correction", "owner_authored", "connector_evidence", "model_inference"]);
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) recoveryFailure("intent_invalid");
  oneOf(value.sensitivity, ["public", "personal", "private"]); oneOf(value.taint, ["clean", "quoted"]); ids(value.provenance);
  array(value.superseded); for (const item of value.superseded) { object(item, ["claim_id", "claim_key"]); id(item.claim_id); id(item.claim_key); }
  array(value.candidates, 512); for (const item of value.candidates) { object(item, ["page_id", "rel_path", "authority", "created_at"]); id(item.page_id); id(item.rel_path); assertPageRelPath(item.rel_path); oneOf(item.authority, ["owner_correction", "owner_authored", "connector_evidence", "model_inference"]); text(item.created_at, 64); }
  array(value.retrieval_ops, 512); for (const item of value.retrieval_ops) { object(item, ["store", "op", "doc"]); id(item.store); oneOf(item.op, ["upsert", "remove"]); id(item.doc); if (!item.doc.startsWith("page:")) recoveryFailure("intent_invalid"); }
  nullableText(value.reverts); if (value.reverted_by !== null || !isRfc3339(value.at)) recoveryFailure("intent_invalid");
  assertReceiptPaths(value as unknown as CanonReceipt);
}

export function parseCanonWriteIntent(value: unknown): CanonWriteIntent {
  object(value, ["version", "receipt", "before_base64", "after_base64", "completion", "admission", "checkpoint", "stages"]);
  if (value.version !== 1) recoveryFailure("intent_invalid");
  validateCanonIntentReceipt(value.receipt);
  const receipt = value.receipt;
  const before = decodeCanonImage(value.before_base64 as string | null), after = decodeCanonImage(value.after_base64 as string | null);
  if ((before === null ? (receipt.kind === "revert" ? ABSENT_PAGE_HASH : null) : hashBytes(before)) !== receipt.before_hash ||
      (after === null ? ABSENT_PAGE_HASH : hashBytes(after)) !== receipt.after_hash ||
      receipt.archive_path !== (before === null ? null : archiveRelPath(receipt.page_path, receipt.receipt_id))) recoveryFailure("intent_invalid");
  object(value.completion, ["mode", "claim_kind", "page_id", "subject_key", "original_receipt_id"]);
  oneOf(value.completion.mode, ["write", "purge", "revert"]); oneOf(value.completion.claim_kind, ["entity", "claim", "edit", "merge", "deletion", "purge_review", "revert"]);
  nullableText(value.completion.page_id); nullableText(value.completion.subject_key); nullableText(value.completion.original_receipt_id);
  if ((value.completion.mode === "write" && receipt.kind !== "write") ||
      (value.completion.mode === "purge" && receipt.kind !== "purge_rewrite") ||
      (value.completion.mode === "revert" && (receipt.kind !== "revert" || receipt.reverts !== value.completion.original_receipt_id))) recoveryFailure("intent_invalid");
  if ((receipt.kind === "revert" && (receipt.writer !== "revert" || value.completion.claim_kind !== "revert")) ||
      (receipt.kind === "purge_rewrite" && (receipt.writer !== "loop" || value.completion.claim_kind !== "purge_review")) ||
      (receipt.kind === "write" && (value.completion.original_receipt_id !== null || receipt.reverts !== null || value.completion.claim_kind === "revert" || value.completion.claim_kind === "purge_review"))) recoveryFailure("intent_invalid");
  if (after !== null) {
    const page = parseFrontmatter(FATAL_UTF8.decode(after));
    if (validatePage(page.data).length > 0 || page.data["id"] !== value.completion.page_id ||
        !Buffer.from(serializePage(page)).equals(after)) recoveryFailure("intent_invalid");
  }
  object(value.admission, ["source_epoch", "claims", "events", "sources", "derive_ids", "predecessor_digest", "original_digest", "page_index_digest", "supersessions_digest", "claim_bindings_digest"]);
  const admission = value.admission;
  if (!Number.isSafeInteger(admission.source_epoch) || Number(admission.source_epoch) < 0) recoveryFailure("intent_invalid");
  guards(admission.claims); guards(admission.events); ids(admission.derive_ids);
  for (const key of ["predecessor_digest", "original_digest", "page_index_digest", "supersessions_digest", "claim_bindings_digest"]) hash(admission[key]);
  array(admission.sources); const sourceEvents = new Set<string>(); for (const source of admission.sources) { object(source, ["source_key", "event_id"]); text(source.source_key); id(source.event_id); if (sourceEvents.has(source.event_id)) recoveryFailure("intent_invalid"); sourceEvents.add(source.event_id); }
  const eventIds = [...new Set([...receipt.provenance, ...pageSources(before), ...pageSources(after)].map(eventIdFromReference))].sort();
  const deriveIds = [...new Set((value.completion.mode === "purge" ? pageSources(after) : [...receipt.provenance, ...pageSources(after)]).map(eventIdFromReference))].sort();
  const boundEvents = (admission.events as unknown as Guard[]).map(item => item.id);
  const boundClaims = new Set((admission.claims as unknown as Guard[]).map(item => item.id));
  if (digest(eventIds) !== digest(boundEvents) || digest(eventIds) !== digest([...sourceEvents]) ||
      digest(deriveIds) !== digest(admission.derive_ids) ||
      [...receipt.claim_ids, ...receipt.superseded.map(item => item.claim_id)].some(id => !boundClaims.has(id))) recoveryFailure("intent_invalid");
  validateOrdinaryReceiptCheckpoint(value.checkpoint);
  object(value.stages, ["live_stage", "archive_stage"]);
  if (value.stages.live_stage !== canonStageRelPath(receipt.page_path, receipt.receipt_id) ||
      value.stages.archive_stage !== (receipt.archive_path === null ? null : canonStageRelPath(receipt.archive_path, receipt.receipt_id))) recoveryFailure("intent_invalid");
  return value as unknown as CanonWriteIntent;
}

function queryDigest(db: Database, sql: string, key: string): string { return digest(db.query(sql).get(key)); }
function boundedRows(db: Database, sql: string, ...args: (string | null)[]): unknown[] {
  const rows = db.query(`${sql} LIMIT ${MAX_BINDINGS + 1}`).all(...args);
  if (rows.length > MAX_BINDINGS) recoveryFailure("intent_invalid");
  return rows;
}
function eventDigest(db: Database, eventId: string): string {
  return digest([
    db.query("SELECT event_id,content_hash,origin,origin_binding,origin_binding_version FROM events WHERE event_id=?").get(eventId),
    db.query("SELECT * FROM source_event_bindings WHERE event_id=?").get(eventId),
    db.query("SELECT * FROM native_owner_evidence WHERE event_id=?").get(eventId),
    db.query("SELECT g.* FROM source_grants g JOIN source_event_bindings b ON b.source_key=g.source_key WHERE b.event_id=?").get(eventId),
    boundedRows(db, "SELECT receipt_id,event_id,connector_id,reason,purged_at FROM event_purges WHERE event_id=? ORDER BY receipt_id", eventId),
  ]);
}
function pageSources(bytes: Buffer | null): string[] {
  if (bytes === null) return [];
  const sources = parseFrontmatter(FATAL_UTF8.decode(bytes)).data["sources"];
  if (!Array.isArray(sources) || !sources.every(item => typeof item === "string")) recoveryFailure("intent_invalid");
  return sources.map(eventIdFromReference);
}
export function captureCanonAdmission(db: Database, receipt: CanonReceipt, completion: CanonCompletion, before: Buffer | null, after: Buffer | null, knownClaims?: string[]): CanonAdmission {
  const claimIds = [...new Set(knownClaims ?? [
    ...receipt.claim_ids, ...receipt.superseded.map(ref => ref.claim_id),
    ...db.query<{ claim_id: string }, [string]>(`SELECT c.claim_id FROM claims c JOIN canon_receipts r ON r.receipt_id=c.receipt_id WHERE r.page_path=? ORDER BY c.claim_id LIMIT ${MAX_BINDINGS + 1}`).all(receipt.page_path).map(row => row.claim_id),
  ])].sort();
  if (claimIds.length > MAX_BINDINGS) recoveryFailure("intent_invalid");
  const eventIds = [...new Set([...receipt.provenance, ...pageSources(before), ...pageSources(after)].map(eventIdFromReference))].sort();
  if (eventIds.length > MAX_BINDINGS) recoveryFailure("intent_invalid");
  const sources = eventIds.map(event_id => ({ event_id, source_key: db.query<{ source_key: string }, [string]>("SELECT source_key FROM source_event_bindings WHERE event_id=?").get(event_id)?.source_key ?? "" }));
  const claimJson = JSON.stringify(claimIds);
  return {
    source_epoch: sourcePolicyEpoch(db),
    claims: claimIds.map(id => ({ id, digest: queryDigest(db, "SELECT * FROM claims WHERE claim_id=?", id) })),
    events: eventIds.map(id => ({ id, digest: eventDigest(db, id) })), sources,
    derive_ids: [...new Set((completion.mode === "purge" ? pageSources(after) : [...receipt.provenance, ...pageSources(after)]).map(eventIdFromReference))].sort(),
    predecessor_digest: digest(latestReceiptForPage(db, receipt.page_path)),
    original_digest: digest(completion.original_receipt_id === null ? null : getCanonReceipt(db, completion.original_receipt_id)),
    page_index_digest: digest(pageIndexByPath(db, receipt.page_path)),
    supersessions_digest: digest(boundedRows(db, "SELECT * FROM claim_supersessions WHERE winner IN (SELECT value FROM json_each(?)) OR loser IN (SELECT value FROM json_each(?)) ORDER BY winner,loser", claimJson, claimJson)),
    claim_bindings_digest: digest(boundedRows(db, "SELECT * FROM claim_bindings WHERE page_id=? ORDER BY claim_key,page_id", completion.page_id)),
  };
}
export function assertCanonAdmission(db: Database, intent: CanonWriteIntent): void {
  const current = captureCanonAdmission(db, intent.receipt, intent.completion, decodeCanonImage(intent.before_base64), decodeCanonImage(intent.after_base64), intent.admission.claims.map(claim => claim.id));
  if (current.source_epoch !== intent.admission.source_epoch || digest(current.events) !== digest(intent.admission.events) || digest(current.claims) !== digest(intent.admission.claims) || digest(current.sources) !== digest(intent.admission.sources)) recoveryFailure("authority_changed", intent.receipt.receipt_id);
  if (digest(current) !== digest(intent.admission)) recoveryFailure("predecessor_changed", intent.receipt.receipt_id);
  requireSourceEvents(db, intent.admission.derive_ids, { owner: true, purpose: "derive" });
}

/** Restoring a committed independent page does not complete the pending intent. */
export function assertIndependentSurvivorAdmission(db: Database, intent: CanonWriteIntent, survivor: Buffer): void {
  const current = captureCanonAdmission(db, intent.receipt, intent.completion, survivor, decodeCanonImage(intent.after_base64), intent.admission.claims.map(claim => claim.id));
  for (const key of ["claims", "predecessor_digest", "original_digest", "page_index_digest", "supersessions_digest", "claim_bindings_digest"] as const) {
    if (JSON.stringify(current[key]) !== JSON.stringify(intent.admission[key])) recoveryFailure("authority_changed", intent.receipt.receipt_id);
  }
  const ids = new Set(pageSources(survivor));
  const selected = (events: CanonAdmission["events"]) => events.filter(event => ids.has(event.id));
  if (JSON.stringify(selected(current.events)) !== JSON.stringify(selected(intent.admission.events))) recoveryFailure("authority_changed", intent.receipt.receipt_id);
  try { requireSourceEvents(db, [...ids], { owner: true, purpose: "derive" }); }
  catch { recoveryFailure("authority_changed", intent.receipt.receipt_id); }
}

export function canonReadGeneration(db: Database): number {
  const row = db.query<{ generation: number }, []>("SELECT generation FROM canon_read_generation WHERE singleton=1").get();
  if (row === null || !Number.isSafeInteger(row.generation) || row.generation < 0) recoveryFailure("intent_invalid");
  return row.generation;
}
export function advanceCanonReadGeneration(db: Database): void {
  if (!db.inTransaction || canonReadGeneration(db) >= Number.MAX_SAFE_INTEGER) recoveryFailure("intent_invalid");
  db.exec("UPDATE canon_read_generation SET generation=generation+1 WHERE singleton=1");
}
export function canonPageRecoveryPending(db: Database, pagePath: string): boolean {
  return db.query("SELECT 1 FROM canon_write_intents WHERE page_path=? UNION ALL SELECT 1 FROM canon_projection_obligations WHERE page_path=? LIMIT 1").get(pagePath, pagePath) !== null;
}
export function inspectCanonRecovery(db: Database): CanonRecoverySummary {
  const row = db.query<{ receipt_id: string; page_path: string }, []>("SELECT receipt_id,page_path FROM canon_write_intents LIMIT 1").get();
  const projection = db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_projection_obligations").get()!;
  return { pending: row !== null, receipt_id: row?.receipt_id ?? null, page_path: row?.page_path ?? null, projection_pending: projection.n, generation: canonReadGeneration(db) };
}
export function readCanonWriteIntent(db: Database): CanonWriteIntent | null {
  const row = db.query<{ receipt_id: string; page_path: string; intent: Uint8Array | null; digest: string }, []>(`SELECT receipt_id,page_path,CASE WHEN length(CAST(intent AS BLOB))<=${MAX_CANON_INTENT_BYTES} THEN CAST(intent AS BLOB) ELSE NULL END AS intent,digest FROM canon_write_intents WHERE singleton=1`).get();
  if (row === null) return null;
  if (row.intent === null) recoveryFailure("intent_invalid", row.receipt_id);
  let raw: string; try { raw = FATAL_UTF8.decode(row.intent); } catch { recoveryFailure("intent_invalid", row.receipt_id); }
  if (sha256Hex(raw) !== row.digest) recoveryFailure("intent_invalid", row.receipt_id);
  let value: unknown; try { value = JSON.parse(raw); } catch { recoveryFailure("intent_invalid", row.receipt_id); }
  const intent = parseCanonWriteIntent(value);
  if (intent.receipt.receipt_id !== row.receipt_id || intent.receipt.page_path !== row.page_path) recoveryFailure("intent_invalid", row.receipt_id);
  const sourceRows = db.query<{ source_key: string; event_id: string }, [string]>(`SELECT source_key,event_id FROM canon_write_intent_sources WHERE receipt_id=? ORDER BY event_id LIMIT ${MAX_BINDINGS + 1}`).all(row.receipt_id);
  if (digest(sourceRows.map(row => [row.event_id, row.source_key])) !== digest(intent.admission.sources.map(row => [row.event_id, row.source_key]))) recoveryFailure("intent_invalid", row.receipt_id);
  return intent;
}
export function persistCanonWriteIntent(db: Database, input: CanonWriteIntent): CanonWriteIntent {
  if (!db.inTransaction) recoveryFailure("nested_transaction");
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json) > MAX_CANON_INTENT_BYTES) recoveryFailure("intent_invalid");
  const intent = parseCanonWriteIntent(JSON.parse(json));
  if (readCanonWriteIntent(db) !== null) recoveryFailure("recovery_pending");
  db.query("INSERT INTO canon_write_intents VALUES (1,?,?,?,?)").run(intent.receipt.receipt_id, intent.receipt.page_path, json, sha256Hex(json));
  for (const source of intent.admission.sources) db.query("INSERT INTO canon_write_intent_sources VALUES (?,?,?)").run(intent.receipt.receipt_id, source.source_key, source.event_id);
  advanceCanonReadGeneration(db);
  return intent;
}
