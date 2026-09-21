import type { CanonReceipt } from "./receipts";
import { MAX_CANON_IDENTITY_BINDINGS } from "../ledger/canon-recovery-schema";
import { isPlainObject } from "../util/validate";
import { isUlid } from "../util/ulid";
import { isRfc3339 } from "../util/time";
import { assertPageRelPath, assertReceiptPaths } from "./paths";
const MAX_BINDINGS = MAX_CANON_IDENTITY_BINDINGS;
const HASH = /^[0-9a-f]{64}$/;
function invalid(): never { throw new Error("canon_receipt_invalid"); }
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) invalid();
}
function text(value: unknown, max = 1024): asserts value is string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || value.includes("\0")) invalid();
}
function id(value: unknown): asserts value is string { text(value); if (!value.length) invalid(); }
function hash(value: unknown): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) invalid(); }
function nullableText(value: unknown): void { if (value !== null) id(value); }
function array(value: unknown, max = MAX_BINDINGS): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
}
function ids(value: unknown): asserts value is string[] { array(value); for (const item of value) id(item); if (new Set(value).size !== value.length) invalid(); }
function oneOf(value: unknown, values: readonly string[]): void { if (typeof value !== "string" || !values.includes(value)) invalid(); }
/** Closed receipt data, rather than the permissive legacy log reader. */
export function validateRetainedReceipt(value: unknown, allowReverted = false): asserts value is CanonReceipt {
  object(value, ["receipt_id", "kind", "claim_ids", "page_path", "page_action", "before_hash", "after_hash", "archive_path", "writer", "producer", "model_ref", "authority", "confidence", "sensitivity", "taint", "provenance", "superseded", "candidates", "retrieval_ops", "reverts", "reverted_by", "at"]);
  if (!isUlid(value.receipt_id)) invalid();
  oneOf(value.kind, ["write", "revert", "purge_rewrite"]);
  ids(value.claim_ids); id(value.page_path); assertPageRelPath(value.page_path);
  oneOf(value.page_action, ["create", "edit", "archive"]);
  if (value.before_hash !== null) hash(value.before_hash); hash(value.after_hash);
  nullableText(value.archive_path); oneOf(value.writer, ["loop", "correction", "revert", "import"]);
  if (typeof value.producer !== "string" || (!/^(deterministic|model|owner)$/.test(value.producer) && !/^agent:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.producer))) invalid();
  nullableText(value.model_ref);
  oneOf(value.authority, ["owner_correction", "owner_authored", "connector_evidence", "model_inference"]);
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) invalid();
  oneOf(value.sensitivity, ["public", "personal", "private"]); oneOf(value.taint, ["clean", "quoted"]); ids(value.provenance);
  array(value.superseded); for (const item of value.superseded) { object(item, ["claim_id", "claim_key"]); id(item.claim_id); id(item.claim_key); }
  array(value.candidates, 512); for (const item of value.candidates) { object(item, ["page_id", "rel_path", "authority", "created_at"]); id(item.page_id); id(item.rel_path); assertPageRelPath(item.rel_path); oneOf(item.authority, ["owner_correction", "owner_authored", "connector_evidence", "model_inference"]); text(item.created_at, 64); }
  array(value.retrieval_ops, 512); for (const item of value.retrieval_ops) { object(item, ["store", "op", "doc"]); id(item.store); oneOf(item.op, ["upsert", "remove"]); id(item.doc); if (!item.doc.startsWith("page:")) invalid(); }
  nullableText(value.reverts); if ((value.reverted_by !== null && (!allowReverted || !isUlid(value.reverted_by))) || !isRfc3339(value.at)) invalid();
  assertReceiptPaths(value as unknown as CanonReceipt);
}

