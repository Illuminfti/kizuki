import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { isRfc3339 } from "../util/time";
import { fsyncDirectory, isCoreUlid } from "./connection-state-files";
import type { ConnectedAtRow } from "./connection-state-rows";
import { LedgerError } from "./connections";

export interface SwapJournal {
  schema: "kizuki.connection-state-swap/v1";
  connector_id: string;
  source_key: string;
  connected_at: string;
  final_name: string;
  backup_name: string | null;
}


/**
 * Finishes or undoes the one swap a journal describes. The row the journal
 * names decides which: a committed row means the new bytes are authoritative,
 * anything else means the swap never landed.
 */
export function repairSwap(db: Database, directory: string, name: string): void {
  const journalPath = join(directory, name);
  let journal: SwapJournal;
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8")) as SwapJournal;
  } catch {
    throw new LedgerError("connection state swap journal is unreadable");
  }
  if (
    journal.schema !== "kizuki.connection-state-swap/v1" ||
    typeof journal.connector_id !== "string" ||
    journal.connector_id.length === 0 ||
    !isCoreUlid(journal.source_key) ||
    !isRfc3339(journal.connected_at) ||
    journal.final_name !== `${journal.source_key}.state` ||
    (journal.backup_name !== null &&
      (basename(journal.backup_name) !== journal.backup_name ||
        !journal.backup_name.startsWith(`${journal.final_name}.`) ||
        !journal.backup_name.endsWith(".rollback")))
  ) {
    throw new LedgerError("connection state swap journal is invalid");
  }
  const finalPath = join(directory, journal.final_name);
  const backupPath = journal.backup_name === null
    ? null
    : join(directory, journal.backup_name);
  const row = db
    .query<ConnectedAtRow, [string, string]>(
      "SELECT connected_at FROM connections WHERE connector_id = ? AND source_key = ?",
    )
    .get(journal.connector_id, journal.source_key);
  if (row?.connected_at === journal.connected_at) {
    if (!existsSync(finalPath)) {
      throw new LedgerError("committed connection state is missing");
    }
    if (backupPath !== null) rmSync(backupPath, { force: true });
  } else if (backupPath !== null && existsSync(backupPath)) {
    rmSync(finalPath, { force: true });
    renameSync(backupPath, finalPath);
  } else if (backupPath !== null) {
    if (!existsSync(finalPath)) {
      throw new LedgerError("connection state and rollback are both missing");
    }
    // The journal was durable before the first rename. The original final
    // file is therefore still authoritative when its planned backup does
    // not exist and the database row was not committed.
  } else {
    rmSync(finalPath, { force: true });
  }
  rmSync(journalPath, { force: true });
  fsyncDirectory(directory);
}
