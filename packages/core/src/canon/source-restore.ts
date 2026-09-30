import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
import type { VaultMutationScope } from "../vault/mutation-scope";
import { UndoError } from "./errors";
import type { CanonIo } from "./store";
import { undoReceiptOwned } from "./undo";
import { readRailCursor, writeRailCursor } from "../ledger/checkpoints";
import { isUlid } from "../util/ulid";
import { BudgetExhausted, type BudgetTracker } from "./budget";

/**
 * A source that deleted a record and later has it again is source truth
 * returning: the page its deletion archived should come back. The archive is
 * an ordinary receipted write, so its reversal is an ordinary receipted
 * revert; this asks for exactly that, once per returned record, and only while
 * the page still holds the bytes the archive left. A page anyone has touched
 * since stays as it is.
 */

interface ReturnedArchive {
  receipt_id: string;
}

/**
 * Archive receipts, oldest first, written for a source tombstone whose record
 * the same source has since put back. The page must still be at that receipt.
 */
export function returnedSourceArchives(db: Database, limit: number, after = ""): ReturnedArchive[] {
  if (!tableExists(db, "canon_receipts") || !tableExists(db, "page_index") || !tableExists(db, "claims")) {
    return [];
  }
  return db
    .query<ReturnedArchive, [string, number]>(
      `SELECT r.receipt_id AS receipt_id
         FROM claims c
         JOIN canon_receipts r ON r.receipt_id = c.receipt_id
         JOIN page_index p ON p.rel_path = r.page_path AND p.last_receipt = r.receipt_id
         JOIN events t ON t.event_id = json_extract(c.provenance, '$[0]')
        WHERE c.kind = 'deletion' AND c.status = 'live'
          AND json_extract(c.frontmatter, '$."x-source-event"') IS NOT NULL
          AND r.page_action = 'archive' AND r.reverted_by IS NULL
          AND t.deleted = 1 AND r.receipt_id > ?
          AND (SELECT e.deleted
                 FROM events e LEFT JOIN source_event_bindings b ON b.event_id = e.event_id
                WHERE e.connector_id = t.connector_id AND e.source_record_id = t.source_record_id
                  AND b.source_key IS (SELECT source_key FROM source_event_bindings WHERE event_id = t.event_id)
                ORDER BY e.accepted_at DESC, e.event_id DESC LIMIT 1) = 0
        ORDER BY r.receipt_id
        LIMIT ?`,
    )
    .all(after, limit);
}

export interface SourceRestoreResult {
  /** Receipts reverted: pages that are active again. */
  readonly restored: number;
  /** Returned records whose page was edited since it was archived. */
  readonly kept: number;
  readonly stopped?: BudgetExhausted["stopped"];
}

/** Undo refusals that mean this page stays archived rather than that the pass failed. */
const KEPT: ReadonlySet<string> = new Set(["page_changed", "archive_missing", "already_reverted", "not_undoable", "erased"]);

export async function restoreReturnedSources(
  scope: VaultMutationScope,
  io: CanonIo,
  limit: number,
  budget?: BudgetTracker,
): Promise<SourceRestoreResult> {
  if (limit === 0) return { restored: 0, kept: 0 };
  let restored = 0;
  let kept = 0;
  const cursor = readRailCursor(io.db, RESTORE_RAIL, RESTORE_CURSOR);
  const after = cursor !== null && isUlid(cursor) ? cursor : "";
  let archives = returnedSourceArchives(io.db, limit + KEPT_SCAN, after);
  if (archives.length === 0 && after !== "") {
    // Cycle through kept pages too: an owner can return one to its archived
    // bytes later. The cursor is progress only, never permission to restore.
    io.db.query("DELETE FROM rail_cursors WHERE rail = ? AND source_key = ?")
      .run(RESTORE_RAIL, RESTORE_CURSOR);
    archives = returnedSourceArchives(io.db, limit + KEPT_SCAN);
  }
  const advance = (archive: ReturnedArchive) =>
    writeRailCursor(io.db, RESTORE_RAIL, RESTORE_CURSOR, archive.receipt_id);
  for (const archive of archives) {
    if (restored >= limit) break;
    try {
      await undoReceiptOwned(scope, io, archive.receipt_id, {
        cascade: false,
        ...(budget === undefined ? {} : { budget }),
      });
      restored += 1;
      advance(archive);
    } catch (error) {
      if (error instanceof BudgetExhausted) return { restored, kept, stopped: error.stopped };
      if (error instanceof UndoError && KEPT.has(error.code)) {
        kept += 1;
        advance(archive);
        continue;
      }
      throw error;
    }
  }
  return { restored, kept };
}

/** Pages kept archived stay in the query's window; scan past them so they cannot fill the cap. */
const KEPT_SCAN = 224;
const RESTORE_RAIL = "source-restore";
const RESTORE_CURSOR = "archives";
