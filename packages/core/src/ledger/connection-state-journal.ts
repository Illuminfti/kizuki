import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { sha256Hex } from "../util/hash";
import { isRfc3339 } from "../util/time";
import { isPlainObject } from "../util/validate";
import {
  assertRegularStateFile,
  fsyncDirectory,
  isCoreUlid,
  MAX_CONNECTION_STATE_BYTES,
  MAX_JOURNAL_BYTES,
} from "./connection-state-files";
import type { ConnectedAtRow } from "./connection-state-rows";
import { LedgerError } from "./connections";

export interface SwapJournal {
  schema: "kizuki.connection-state-swap/v1";
  connector_id: string;
  source_key: string;
  connected_at: string;
  final_name: string;
  backup_name: string | null;
  final_sha256: string;
  final_bytes: number;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function decodeSwapJournal(raw: unknown): SwapJournal {
  if (!isPlainObject(raw)) {
    throw new LedgerError("connection state swap journal is invalid");
  }
  const connector_id = raw.connector_id;
  const source_key = raw.source_key;
  const connected_at = raw.connected_at;
  const final_name = raw.final_name;
  const backup_name = raw.backup_name;
  const final_sha256 = raw.final_sha256;
  const final_bytes = raw.final_bytes;
  if (
    raw.schema !== "kizuki.connection-state-swap/v1" ||
    typeof connector_id !== "string" ||
    connector_id.length === 0 ||
    typeof source_key !== "string" ||
    !isCoreUlid(source_key) ||
    typeof connected_at !== "string" ||
    !isRfc3339(connected_at) ||
    typeof final_name !== "string" ||
    final_name !== `${source_key}.state` ||
    (backup_name !== null &&
      (typeof backup_name !== "string" ||
        basename(backup_name) !== backup_name ||
        !backup_name.startsWith(`${final_name}.`) ||
        !backup_name.endsWith(".rollback"))) ||
    typeof final_sha256 !== "string" ||
    !SHA256_HEX.test(final_sha256) ||
    typeof final_bytes !== "number" ||
    !Number.isSafeInteger(final_bytes) ||
    final_bytes < 0
  ) {
    throw new LedgerError("connection state swap journal is invalid");
  }
  return {
    schema: "kizuki.connection-state-swap/v1",
    connector_id,
    source_key,
    connected_at,
    final_name,
    backup_name: backup_name === null ? null : backup_name,
    final_sha256,
    final_bytes,
  };
}

export function quarantineJournal(directory: string, name: string): string {
  const quarantine = join(directory, "quarantine");
  mkdirSync(quarantine, { recursive: true, mode: 0o700 });
  const from = join(directory, name);
  const to = join(quarantine, name);
  renameSync(from, to);
  fsyncDirectory(quarantine);
  fsyncDirectory(directory);
  return to;
}


/**
 * Finishes or undoes the one swap a journal describes. The row the journal
 * names decides which: a committed row means the new bytes are authoritative,
 * anything else means the swap never landed.
 */
function verifyCommittedState(directory: string, journal: SwapJournal): void {
  const finalPath = join(directory, journal.final_name);
  const stats = assertRegularStateFile(finalPath, directory);
  if (stats.size !== journal.final_bytes) {
    throw new LedgerError("committed connection state size does not match the journal");
  }
  if (stats.size > MAX_CONNECTION_STATE_BYTES) {
    throw new LedgerError("committed connection state exceeds maximum size");
  }
  const bytes = readFileSync(finalPath);
  if (bytes.byteLength !== journal.final_bytes || sha256Hex(bytes) !== journal.final_sha256) {
    throw new LedgerError("committed connection state hash does not match the journal");
  }
}

export function repairSwap(db: Database, directory: string, name: string): void {
  const journalPath = join(directory, name);
  let journal: SwapJournal;
  try {
    const stats = assertRegularStateFile(journalPath, directory);
    if (stats.size > MAX_JOURNAL_BYTES) {
      throw new LedgerError("connection state swap journal exceeds maximum size");
    }
    journal = decodeSwapJournal(JSON.parse(readFileSync(journalPath, "utf8")));
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError("connection state swap journal is unreadable");
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
    verifyCommittedState(directory, journal);
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
