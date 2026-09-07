import type { VaultMutationScope } from "../vault/mutation-scope";
import type { CanonFileSnapshot } from "../vault/canon-files";
import { sha256Hex } from "../util/hash";
import { parseFrontmatter } from "../vault/frontmatter";
import { eventIdFromReference } from "../retrieval/ids";
import { oneShotGet } from "../ledger/schema";
import { requireCanonFiles } from "./io";
import { latestReceiptForPage } from "./receipts";
import { openOrdinaryRecoveryReceiptStream } from "./receipt-stream";
import { readCanonProjectionObligation } from "./projection-obligations";
import type { CanonIo } from "./store";
import { advanceCanonReadGeneration, decodeCanonImage, readCanonWriteIntent, recoveryFailure } from "./write-intent";

/**
 * An owner's source withdrawal may erase the exact pending joint record. It
 * cannot complete its former positive write under withdrawn authority. Keep
 * the intent as the erasure inventory until both bytes and log are absent.
 */
export function withdrawPendingCanonWrite(scope: VaultMutationScope, io: CanonIo, sourceKey: string): void {
  const files = requireCanonFiles(scope, io), db = io.db;
  if (db.inTransaction) recoveryFailure("nested_transaction");
  const intent = readCanonWriteIntent(db);
  if (intent === null || !intent.admission.sources.some(source => source.source_key === sourceKey)) return;
  const receipt = intent.receipt;
  const deniedEvents = new Set(intent.admission.sources.filter(source => source.source_key === sourceKey).map(source => source.event_id));
  const binding = db.query<{ digest: string }, [string]>("SELECT digest FROM canon_write_intents WHERE receipt_id=?").get(receipt.receipt_id)!;
  const denied = db.query<{ status: string; revoke_operation: string | null; revision: number }, [string]>(
    "SELECT status,revoke_operation,revision FROM source_grants WHERE source_key=?",
  ).get(sourceKey);
  if (denied === null || denied.status !== "denied" || denied.revoke_operation === null) recoveryFailure("authority_changed", receipt.receipt_id);
  const held: CanonFileSnapshot[] = [];
  const remove: CanonFileSnapshot[] = [];
  const stream = openOrdinaryRecoveryReceiptStream(scope, io);
  try {
    db.transaction(() => {
      const current = db.query("SELECT status,revoke_operation,revision FROM source_grants WHERE source_key=?").get(sourceKey);
      if (JSON.stringify(current) !== JSON.stringify(denied) ||
          db.query<{ digest: string }, [string]>("SELECT digest FROM canon_write_intents WHERE receipt_id=?").get(receipt.receipt_id)?.digest !== binding.digest ||
          db.query("SELECT 1 FROM canon_receipts WHERE receipt_id=?").get(receipt.receipt_id) !== null ||
          sha256Hex(JSON.stringify(latestReceiptForPage(db, receipt.page_path))) !== intent.admission.predecessor_digest) {
        recoveryFailure("authority_changed", receipt.receipt_id);
      }
      // An expected name or prefix is not durable creation custody. These
      // explicit manual cases survive source withdrawal as visible blockers.
      for (const path of [intent.stages.live_stage, intent.stages.archive_stage]) {
        if (path === null) continue;
        const stage = files.read(path);
        if (stage !== null) { stage.close(); recoveryFailure("stage_custody_unknown", receipt.receipt_id); }
      }
      const before = decodeCanonImage(intent.before_base64), after = decodeCanonImage(intent.after_base64);
      for (const [path, images] of [
        [receipt.page_path, [before, after]],
        [receipt.archive_path, [before]],
      ] as const) {
        if (path === null) continue;
        const snapshot = files.read(path);
        if (snapshot === null) continue; // A previous erasure attempt may have removed it.
        held.push(snapshot);
        const bytes = Buffer.from(snapshot.bytes);
        if (!images.some(image => image !== null && image.equals(bytes))) recoveryFailure("page_changed", receipt.receipt_id);
        const sources = parseFrontmatter(bytes.toString("utf8")).data["sources"];
        if (!Array.isArray(sources) || !sources.every(source => typeof source === "string")) recoveryFailure("intent_invalid", receipt.receipt_id);
        const withdrawn = sources.some(source => deniedEvents.has(eventIdFromReference(source)));
        if (withdrawn) remove.push(snapshot);
        else if (path === receipt.page_path && (before === null || !before.equals(bytes))) {
          // An independent postimage has no committed positive basis yet.
          // Neither deleting it nor inventing its completion is withdrawal.
          recoveryFailure("authority_changed", receipt.receipt_id);
        }
      }
      // Global single-intent admission makes the expected receipt the only
      // permitted suffix. The primitive refuses every foreign or changed tail.
      stream.withdrawExact(intent.checkpoint, Buffer.from(`${JSON.stringify(receipt)}\n`));
      for (const snapshot of remove) files.remove(snapshot);
      stream.verifyBinding();
      const removed = oneShotGet<{ receipt_id: string }>(db, "DELETE FROM canon_write_intents WHERE receipt_id=? AND digest=? RETURNING receipt_id", receipt.receipt_id, binding.digest);
      if (removed?.receipt_id !== receipt.receipt_id) recoveryFailure("intent_invalid", receipt.receipt_id);
      advanceCanonReadGeneration(db);
    }).immediate();
  } finally {
    try { for (const snapshot of held) snapshot.close(); }
    finally { stream.close(); }
  }
}

/** Cancel known work, retaining the existing inventory of actual store instances. */
export function withdrawPendingCanonProjections(scope: VaultMutationScope, io: CanonIo, sourceKey: string): void {
  requireCanonFiles(scope, io);
  const db = io.db;
  if (db.inTransaction) recoveryFailure("nested_transaction");
  db.transaction(() => {
    const grant = db.query<{ status: string; revoke_operation: string | null }, [string]>(
      "SELECT status,revoke_operation FROM source_grants WHERE source_key=?",
    ).get(sourceKey);
    if (grant?.status !== "denied" || grant.revoke_operation === null) recoveryFailure("authority_changed");
    const rows = db.query<{ receipt_id: string }, [string]>(
      "SELECT DISTINCT receipt_id FROM canon_projection_sources WHERE source_key=? ORDER BY receipt_id LIMIT 101",
    ).all(sourceKey);
    if (rows.length > 100) recoveryFailure("projection_pending");
    for (const row of rows) {
      const saved = readCanonProjectionObligation(db, row.receipt_id);
      if (saved === null || !saved.value.sources.some(source => source.source_key === sourceKey)) recoveryFailure("intent_invalid", row.receipt_id);
      // A request whose outcome is unknown may still write after an erasure.
      // Store absence alone cannot establish that it has stopped executing.
      if (saved.value.external_execution.includes("started")) recoveryFailure("projection_pending", row.receipt_id);
      // Scheduled operations were never sent. Acknowledged operations recorded
      // their real store instance before I/O. Preserve that inventory for the
      // existing whole-store erasure protocol; op.store is a port descriptor,
      // not an instance ID and cannot create an erasure receipt by itself.
      const removed = oneShotGet<{ receipt_id: string }>(db, "DELETE FROM canon_projection_obligations WHERE receipt_id=? AND digest=? RETURNING receipt_id", row.receipt_id, saved.row.digest);
      if (removed?.receipt_id !== row.receipt_id) recoveryFailure("intent_invalid", row.receipt_id);
      advanceCanonReadGeneration(db);
    }
  }).immediate();
}
