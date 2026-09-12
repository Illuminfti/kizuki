import type { VaultMutationScope } from "../vault/mutation-scope";
import type { CanonFileSnapshot, CanonFiles } from "../vault/canon-files";
import { sha256Hex } from "../util/hash";
import { parseFrontmatter } from "../vault/frontmatter";
import { eventIdFromReference } from "../retrieval/ids";
import { oneShotGet } from "../ledger/schema";
import { requireCanonFiles } from "./io";
import { latestReceiptForPage } from "./receipts";
import { openOrdinaryRecoveryReceiptStream } from "./receipt-stream";
import { readCanonProjectionObligation } from "./projection-obligations";
import type { CanonIo } from "./store";
import { advanceCanonReadGeneration, assertIndependentSurvivorAdmission, decodeCanonImage, readCanonWriteIntent, recoveryFailure, type CanonWriteIntent } from "./write-intent";

function pageEventIds(bytes: Buffer, receiptId: string): string[] {
  const sources = parseFrontmatter(bytes.toString("utf8")).data["sources"];
  if (!Array.isArray(sources) || !sources.every(source => typeof source === "string")) recoveryFailure("intent_invalid", receiptId);
  return sources.map(eventIdFromReference);
}

function sameImage(actual: Buffer | null, expected: Buffer | null): boolean {
  return actual === null ? expected === null : expected !== null && actual.equals(expected);
}

function independentOf(bytes: Buffer | null, deniedEvents: Set<string>, receiptId: string): bytes is Buffer {
  return bytes !== null && !pageEventIds(bytes, receiptId).some(id => deniedEvents.has(id));
}

function publishIndependent(files: CanonFiles, stagePath: string, bytes: Buffer, dest: string, expected: CanonFileSnapshot | null): void {
  const stage = files.create(stagePath, bytes);
  try {
    const restored = expected === null ? files.publish(stage, dest) : files.replace(stage, expected);
    restored.close();
  } finally { stage.close(); }
}

/**
 * A pending revert restores a previously committed page. Rewrite live bytes to
 * that independent survivor and keep the intent; completing it here would need
 * purge-binding/lineage schema this lane does not own.
 */
function holdIndependentRevert(
  files: CanonFiles,
  db: CanonIo["db"],
  intent: CanonWriteIntent,
  before: Buffer | null,
  after: Buffer,
  held: CanonFileSnapshot[],
): never {
  const receipt = intent.receipt;
  assertIndependentSurvivorAdmission(db, intent, after);
  const live = files.read(receipt.page_path);
  let liveBytes: Buffer | null = null;
  if (live !== null) {
    held.push(live);
    liveBytes = Buffer.from(live.bytes);
  }
  if (!sameImage(liveBytes, after)) {
    if (!sameImage(liveBytes, before)) recoveryFailure("page_changed", receipt.receipt_id);
    if (before !== null && receipt.archive_path !== null && intent.stages.archive_stage !== null) {
      const archive = files.read(receipt.archive_path);
      if (archive === null) publishIndependent(files, intent.stages.archive_stage, before, receipt.archive_path, null);
      else {
        held.push(archive);
        if (!before.equals(Buffer.from(archive.bytes))) recoveryFailure("archive_changed", receipt.receipt_id);
      }
    }
    publishIndependent(files, intent.stages.live_stage, after, receipt.page_path, live);
  }
  recoveryFailure("authority_changed", receipt.receipt_id);
}

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
      if ((intent.receipt.kind === "revert" || intent.completion.mode === "revert") && independentOf(after, deniedEvents, receipt.receipt_id)) {
        holdIndependentRevert(files, db, intent, before, after, held);
      }
      const independentBefore = independentOf(before, deniedEvents, receipt.receipt_id);
      let rollback: { target: CanonFileSnapshot | null } | null = null;
      for (const [path, images] of [
        [receipt.page_path, [before, after]],
        [receipt.archive_path, [before]],
      ] as const) {
        if (path === null) continue;
        const snapshot = files.read(path);
        if (snapshot === null) {
          if (path === receipt.page_path && independentBefore) rollback = { target: null };
          continue; // A previous erasure attempt may have removed it.
        }
        held.push(snapshot);
        const bytes = Buffer.from(snapshot.bytes);
        if (!images.some(image => image !== null && image.equals(bytes))) recoveryFailure("page_changed", receipt.receipt_id);
        const sources = parseFrontmatter(bytes.toString("utf8")).data["sources"];
        if (!Array.isArray(sources) || !sources.every(source => typeof source === "string")) recoveryFailure("intent_invalid", receipt.receipt_id);
        const withdrawn = sources.some(source => deniedEvents.has(eventIdFromReference(source)));
        if (withdrawn) {
          if (path === receipt.page_path && independentBefore) rollback = { target: snapshot };
          else remove.push(snapshot);
        }
        else if (path === receipt.page_path && (before === null || !before.equals(bytes))) {
          // An independent postimage has no committed positive basis yet.
          // Neither deleting it nor inventing its completion is withdrawal.
          recoveryFailure("authority_changed", receipt.receipt_id);
        }
      }
      // A prior attempt may already have restored these bytes before SQL
      // completion failed. Preserving them still requires current authority.
      if (independentBefore && before !== null) assertIndependentSurvivorAdmission(db, intent, before);
      // Global single-intent admission makes the expected receipt the only
      // permitted suffix. The primitive refuses every foreign or changed tail.
      stream.withdrawExact(intent.checkpoint, Buffer.from(`${JSON.stringify(receipt)}\n`));
      if (rollback !== null && before !== null) {
        // Fresh creation custody permits atomic rollback. An interrupted stage
        // still follows the explicit unknown-stage hold on the next attempt.
        const stage = files.create(intent.stages.live_stage, before);
        try {
          const restored = rollback.target === null ? files.publish(stage, receipt.page_path) : files.replace(stage, rollback.target);
          restored.close();
        } finally { stage.close(); }
      }
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
