import type { Database } from "bun:sqlite";
import { assertReceiptPaths } from "./paths";
import { insertErasedReceiptRow, insertReceiptRow } from "./store";
import { parseWorldCanonReceipt } from "./world-receipt";

type ReceiptSchemaVersions = { readonly ledger: number; readonly canon: number };

/**
 * Restore the historical receipt stream inside private backup staging. The caller
 * restores its claim/world dependencies first and validates the complete history
 * before publishing the vault. This internal restore seam grants no page-write capability.
 */
export function restoreCanonReceipts(
  db: Database,
  rows: Iterable<Record<string, unknown>>,
  versions: ReceiptSchemaVersions,
): void {
  if (!db.inTransaction) throw new Error("canon receipt restore requires a transaction");
  for (const row of rows) insertReceipt(db, row, versions);
}

function insertReceipt(db: Database, raw: Record<string, unknown>, versions: ReceiptSchemaVersions): void {
  if (Object.hasOwn(raw, "schema")) {
    if (versions.ledger < 33 || versions.canon !== 5) throw new Error("typed canon receipt requires ledger33/canon5");
    const receipt = parseWorldCanonReceipt(raw);
    if (receipt === null) throw new Error("backup typed canon receipt is invalid");
    if (receipt.state === "erased") insertErasedReceiptRow(db, receipt);
    else insertReceiptRow(db, receipt, receipt.kind === "revert" ? "revert" : receipt.kind === "purge_rewrite" ? "purge_review" : "claim");
    return;
  }
  if (["state", "own_id_origin", "basis", "prior_receipt_id", "purge_receipt_id", "erased_at", "integrity"].some(key => Object.hasOwn(raw, key)) ||
      (Array.isArray(raw.claim_ids) && raw.claim_ids.some(id => typeof id === "string" &&
        db.query("SELECT 1 FROM claims WHERE claim_id=? AND is_world_typed=1").get(id) !== null)) ||
      (typeof raw.receipt_id === "string" && db.query("SELECT 1 FROM claims WHERE receipt_id=? AND is_world_typed=1").get(raw.receipt_id) !== null) ||
      (typeof raw.page_path === "string" && /^auto\/world\/[a-f0-9]{32}\.md$/.test(raw.page_path) &&
        db.query("SELECT 1 FROM semantic_handles WHERE handle_id=?").get(raw.page_path.slice(11, -3)) !== null)) {
    throw new Error("backup typed canon receipt discriminator is missing");
  }
  const pagePath = asString(raw.page_path, "page_path");
  const archivePath = asStringOrNull(raw.archive_path, "archive_path");
  assertReceiptPaths({ page_path: pagePath, archive_path: archivePath });
  db.query(
    `INSERT INTO canon_receipts
       (receipt_id, claim_ids, provenance, sensitivity, page_path, kind,
        before_hash, after_hash, at, receipt_kind, page_action, archive_path,
        writer, producer, model_ref, authority, confidence, taint,
        candidates, superseded, retrieval_ops, reverts, reverted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    asString(raw.receipt_id, "receipt_id"),
    JSON.stringify(raw.claim_ids ?? []),
    JSON.stringify(raw.provenance ?? []),
    asString(raw.sensitivity, "sensitivity"),
    pagePath,
    asString(raw.claim_kind ?? "claim", "claim_kind"),
    asStringOrNull(raw.before_hash, "before_hash"),
    asString(raw.after_hash, "after_hash"),
    asString(raw.at, "at"),
    asString(raw.kind ?? "write", "kind"),
    asString(raw.page_action ?? "edit", "page_action"),
    archivePath,
    asString(raw.writer ?? "import", "writer"),
    asString(raw.producer ?? "deterministic", "producer"),
    asStringOrNull(raw.model_ref, "model_ref"),
    asString(raw.authority ?? "connector_evidence", "authority"),
    asNumber(raw.confidence ?? 1, "confidence"),
    asString(raw.taint ?? "quoted", "taint"),
    JSON.stringify(raw.candidates ?? []),
    JSON.stringify(raw.superseded ?? []),
    JSON.stringify(raw.retrieval_ops ?? []),
    asStringOrNull(raw.reverts, "reverts"),
    asStringOrNull(raw.reverted_by, "reverted_by"),
  );
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field}: must be a string`);
  return value;
}

function asStringOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, field);
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field}: must be a number`);
  }
  return value;
}

