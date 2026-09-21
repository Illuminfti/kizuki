import { completedEventPurgeProofs, type CompletedEventPurgeProof } from "../ledger/purge";
import { isErasedReceipt, rowToReceiptRecord, type CanonReceiptRow } from "./receipts";
import { isWorldCanonReceipt, parseWorldCanonReceipt, type RetainedWorldCanonReceipt, type WorldCanonReceiptRecord, type ErasedWorldCanonReceipt, eraseWorldReceipt } from "./world-receipt";
import { assertWorldBasis, assertWorldCanonPage, selectWorldMaterialization } from "./world-materialization";
import { validateRetainedReceipt } from "./receipt-validation";
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
import { assertPageRelPath, assertReceiptPaths, assertStoredPageRelPath } from "./paths";
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
interface CanonWriteIntentV1 {
  version: 1;
  receipt: CanonReceipt;
  before_base64: string | null;
  after_base64: string | null;
  completion: CanonCompletion;
  admission: CanonAdmission;
  checkpoint: OrdinaryReceiptCheckpoint;
  stages: { live_stage: string; archive_stage: string | null };
}
export interface WorldCanonErasure {
  proofs:CompletedEventPurgeProof[];
  redactions:ErasedWorldCanonReceipt[];
  receipt_guards:{receipt_id:string;digest:string}[];
  archives:{path:string;hash:string}[];
  final_receipt:WorldCanonReceiptRecord;
  log_after_hash:string;
  log_after_length:number;
}
export type WorldCanonErasureIntent=Omit<CanonWriteIntentV1,"version"|"receipt"|"before_base64"> & {version:3;receipt:RetainedWorldCanonReceipt;before_base64:null;erasure:WorldCanonErasure};
export type CanonWriteIntent = CanonWriteIntentV1 | (Omit<CanonWriteIntentV1, "version" | "receipt"> & {version: 2; receipt: RetainedWorldCanonReceipt}) | WorldCanonErasureIntent;
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
  try { validateRetainedReceipt(value); } catch { recoveryFailure("intent_invalid"); }
}

export function validateVersionedCanonReceipt(value: unknown, version: unknown): asserts value is CanonReceipt {
  if (version === 1) { validateCanonIntentReceipt(value); return; }
  if (version !== 2) recoveryFailure("intent_invalid");
  const typed = parseWorldCanonReceipt(value, validateCanonIntentReceipt);
  if (typed === null || typed.state !== "retained") recoveryFailure("intent_invalid");
}
export function worldErasureFinalReceipt(receipt:RetainedWorldCanonReceipt,purgeReceiptId:string):WorldCanonReceiptRecord {
  if(receipt.basis.after===null)return eraseWorldReceipt(receipt.receipt_id,purgeReceiptId,receipt.at);
  return {...receipt,before_hash:null,basis:{...receipt.basis,before:null}};
}
function validateWorldErasure(value:unknown,receipt:CanonReceipt):void {
  object(value,["proofs","redactions","receipt_guards","archives","final_receipt","log_after_hash","log_after_length"]);
  if(!isWorldCanonReceipt(receipt))recoveryFailure("intent_invalid");
  array(value.proofs);if(value.proofs.length===0)recoveryFailure("intent_invalid");
  let previous="";
  for(const proof of value.proofs){object(proof,["event_id","purge_receipt_id","batch_id","proof_digest"]);if(!isUlid(proof.event_id)||!isUlid(proof.purge_receipt_id)||!isUlid(proof.batch_id)||proof.event_id<=previous)recoveryFailure("intent_invalid");hash(proof.proof_digest);previous=proof.event_id;}
  array(value.redactions);array(value.receipt_guards);if(value.redactions.length===0||value.redactions.length!==value.receipt_guards.length)recoveryFailure("intent_invalid");
  const selected=new Set<string>();
  for(const record of value.redactions){const parsed=parseWorldCanonReceipt(record);if(parsed===null||parsed.state!=="erased"||selected.has(parsed.receipt_id)||parsed.receipt_id===receipt.receipt_id||parsed.erased_at!==receipt.at||!(value.proofs as unknown as CompletedEventPurgeProof[]).some(proof=>proof.purge_receipt_id===parsed.purge_receipt_id))recoveryFailure("intent_invalid");selected.add(parsed.receipt_id);}
  for(const guard of value.receipt_guards){object(guard,["receipt_id","digest"]);if(typeof guard.receipt_id!=="string"||!selected.delete(guard.receipt_id))recoveryFailure("intent_invalid");hash(guard.digest);}if(selected.size!==0)recoveryFailure("intent_invalid");
  array(value.archives,8192);const paths=new Set<string>();
  for(const archive of value.archives){object(archive,["path","hash"]);id(archive.path);assertStoredPageRelPath(archive.path);if(!archive.path.startsWith("archive/")||paths.has(archive.path))recoveryFailure("intent_invalid");hash(archive.hash);paths.add(archive.path);}
  const final=parseWorldCanonReceipt(value.final_receipt),proof=(value.proofs as unknown as CompletedEventPurgeProof[])[0]!;
  if(final===null||digest(final)!==digest(worldErasureFinalReceipt(receipt,proof.purge_receipt_id)))recoveryFailure("intent_invalid");
  hash(value.log_after_hash);if(!Number.isSafeInteger(value.log_after_length)||Number(value.log_after_length)<0||Number(value.log_after_length)>32*1024*1024)recoveryFailure("intent_invalid");
}
export function parseCanonWriteIntent(value: unknown): CanonWriteIntent {
  if (!isPlainObject(value)) recoveryFailure("intent_invalid");
  const erasing=value.version===3;
  object(value, ["version", "receipt", "before_base64", "after_base64", "completion", "admission", "checkpoint", "stages",...(erasing?["erasure"]:[])]);
  validateVersionedCanonReceipt(value.receipt, erasing?2:value.version);
  const receipt = value.receipt;
  if (!erasing && isWorldCanonReceipt(receipt)) {
    const absentBefore=receipt.kind==="revert"?ABSENT_PAGE_HASH:null;
    if((receipt.basis.before===null?receipt.before_hash!==absentBefore:receipt.before_hash===null||receipt.before_hash===ABSENT_PAGE_HASH)||(receipt.after_hash===ABSENT_PAGE_HASH)!==(receipt.basis.after===null))recoveryFailure("intent_invalid");
  }
  const before = decodeCanonImage(value.before_base64 as string | null), after = decodeCanonImage(value.after_base64 as string | null);
  if (erasing) {
    if(before!==null||receipt.before_hash===null||receipt.archive_path!==null||receipt.kind!=="purge_rewrite"||(after===null?ABSENT_PAGE_HASH:hashBytes(after))!==receipt.after_hash)recoveryFailure("intent_invalid");
    validateWorldErasure(value.erasure,receipt);
  } else if ((before === null ? (receipt.kind === "revert" ? ABSENT_PAGE_HASH : null) : hashBytes(before)) !== receipt.before_hash ||
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
    ...(isWorldCanonReceipt(receipt) ? [...(receipt.basis.before ?? []), ...(receipt.basis.after ?? [])].map(item => item.claim_id) : []),
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
  if (isWorldCanonReceipt(intent.receipt)) {
    try {
      if(intent.version!==3)assertWorldBasis(db, intent.receipt.basis.before, true);
      assertWorldBasis(db, intent.receipt.basis.after, intent.completion.mode === "revert");
    } catch { recoveryFailure("authority_changed", intent.receipt.receipt_id); }
  }
  if(intent.version===3) {
    const proofs=completedEventPurgeProofs(db,intent.erasure.proofs.map(item=>item.event_id));
    if(proofs===null||JSON.stringify(proofs)!==JSON.stringify(intent.erasure.proofs))recoveryFailure("authority_changed",intent.receipt.receipt_id);
    const match=/^auto\/world\/([0-9a-f]{32})\.md$/.exec(intent.receipt.page_path);
    const prior=latestReceiptForPage(db,intent.receipt.page_path);
    if(match===null||prior===null||!isWorldCanonReceipt(prior)||prior.after_hash!==intent.receipt.before_hash||digest(prior.basis.after)!==digest(intent.receipt.basis.before))recoveryFailure("predecessor_changed",intent.receipt.receipt_id);
    const purged=new Set(proofs.map(proof=>proof.event_id));
    const rows=db.query<CanonReceiptRow,[string]>("SELECT * FROM canon_receipts WHERE page_path=? AND record_codec='kizuki.canon-receipt/v2' ORDER BY receipt_id LIMIT 8193").all(intent.receipt.page_path);
    if(rows.length>8192)recoveryFailure("intent_invalid",intent.receipt.receipt_id);
    const affected:RetainedWorldCanonReceipt[]=[];
    for(const row of rows){const record=rowToReceiptRecord(row);if(isErasedReceipt(record)||!isWorldCanonReceipt(record))recoveryFailure("receipt_changed",intent.receipt.receipt_id);if(record.provenance.some(id=>purged.has(eventIdFromReference(id))))affected.push(record);}
    const guards=affected.map(record=>({receipt_id:record.receipt_id,digest:digest(record)}));
    if(digest(guards)!==digest(intent.erasure.receipt_guards))recoveryFailure("receipt_changed",intent.receipt.receipt_id);
    const archives=new Map<string,string>();
    for(const record of affected)if(record.archive_path!==null&&record.before_hash!==null){const existing=archives.get(record.archive_path);if(existing!==undefined&&existing!==record.before_hash)recoveryFailure("archive_changed",intent.receipt.receipt_id);archives.set(record.archive_path,record.before_hash);}
    if(digest([...archives].map(([path,hash])=>({path,hash})))!==digest(intent.erasure.archives))recoveryFailure("archive_changed",intent.receipt.receipt_id);
    const selected=selectWorldMaterialization(db,match[1]!);
    if(digest(selected?.basis??null)!==digest(intent.receipt.basis.after))recoveryFailure("authority_changed",intent.receipt.receipt_id);
    const final=intent.erasure.final_receipt,after=decodeCanonImage(intent.after_base64);
    if(!isErasedReceipt(final)){try{assertWorldCanonPage(db,final,after,"after");}catch{recoveryFailure("authority_changed",intent.receipt.receipt_id);}}

  }
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
