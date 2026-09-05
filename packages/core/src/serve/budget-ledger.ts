import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetExhausted, type BudgetTracker } from "../canon/budget";
import { assertPageRelPath } from "../canon/arbiter";
import { readReceiptsLog } from "../canon/receipts";
import { sha256Hex } from "../util/hash";
import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";

export function budgetDay(at: string): string {
  return at.slice(0, 10);
}

export function readDailyBudget(
  db: Database,
  day: string,
  name: string,
): number {
  if (!tableExists(db, "budget_ledger")) return 0;
  return (
    db
      .query<{ used: number }, [string, string]>(
        "SELECT used FROM budget_ledger WHERE day = ? AND name = ?",
      )
      .get(day, name)?.used ?? 0
  );
}

export function addDailyBudget(
  db: Database,
  day: string,
  name: string,
  delta: number,
): number {
  if (!tableExists(db, "budget_ledger")) return 0;
  if (!Number.isSafeInteger(delta) || delta < 0) throw new TypeError("budget delta must be a non-negative integer");
  db.query(
    `INSERT INTO budget_ledger (day, name, used) VALUES (?, ?, ?)
     ON CONFLICT(day, name) DO UPDATE SET used = budget_ledger.used + excluded.used`,
  ).run(day, name, delta);
  return readDailyBudget(db, day, name);
}

export function listDailyBudget(
  db: Database,
  day: string,
): { name: string; used: number }[] {
  if (!tableExists(db, "budget_ledger")) return [];
  return db
    .query<{ name: string; used: number }, [string]>(
      "SELECT name, used FROM budget_ledger WHERE day = ? ORDER BY name",
    )
    .all(day);
}

/** Durable admission is called synchronously by the writer before its file effect. */
export function createDurableWriteBudget(
  db: Database,
  vaultPath: string,
  day: string | (() => string),
  limits: { canon_writes_per_run: number; canon_writes_per_day: number },
): BudgetTracker {
  let runUsed = 0;
  const currentDay = () => typeof day === "string" ? day : day();
  return {
    chargeWrite(write) {
      if (write === undefined) throw new Error("durable write reservation requires a receipt identity");
      if (runUsed >= limits.canon_writes_per_run) throw new BudgetExhausted("canon_writes_per_run", limits.canon_writes_per_run);
      const chargedDay = currentDay();
      db.transaction(() => {
        const used = durableUsage(db, vaultPath, chargedDay);
        const reserved = db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM canon_write_reservations WHERE day=?").get(chargedDay)!.count;
        if (used + reserved >= limits.canon_writes_per_day) throw new BudgetExhausted("canon_writes_per_day", limits.canon_writes_per_day);
        db.query("INSERT INTO canon_write_reservations(receipt_id,day,page_path,before_hash) VALUES (?,?,?,?)").run(write.receipt_id, chargedDay, write.page_path, write.before_hash);
      }).immediate();
      runUsed++;
    },
    usage() {
      return {
        canon_writes_per_run: { used: runUsed, limit: limits.canon_writes_per_run },
        canon_writes_per_day: { used: durableUsage(db, vaultPath, currentDay()), limit: limits.canon_writes_per_day },
      };
    },
  };
}

function durableUsage(db: Database, vaultPath: string, day: string): number {
  const reserved = new Set(db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM canon_write_reservations").all().map(row => row.receipt_id));
  const ids = new Set(db.query<{ receipt_id: string }, [string]>("SELECT receipt_id FROM canon_receipts WHERE writer='loop' AND substr(at,1,10)=?").all(day).map(row => row.receipt_id));
  for (const receipt of readReceiptsLog(vaultPath)) {
    if (receipt.writer === "loop" && budgetDay(receipt.at) === day) ids.add(receipt.receipt_id);
  }
  for (const id of reserved) ids.delete(id);
  return Math.max(readDailyBudget(db, day, "canon_writes_per_day"), ids.size);
}

/** Run only under the write flock: no reservation can still be writing. */
export function settleWriteReservations(db: Database, vaultPath: string): void {
  const journal = new Set(readReceiptsLog(vaultPath).map(receipt => receipt.receipt_id));
  for (const row of db.query<{ receipt_id: string; day: string; page_path: string; before_hash: string | null }, []>("SELECT * FROM canon_write_reservations").all()) {
    assertPageRelPath(row.page_path);
    const path = join(vaultPath, row.page_path);
    const current = existsSync(path) ? sha256Hex(readFileSync(path)) : null;
    // A file-only crash still consumed a write. An unchanged file with no
    // receipt consumed none. Uncertain changed bytes count conservatively.
    const committed = journal.has(row.receipt_id) || db.query("SELECT 1 FROM canon_receipts WHERE receipt_id=?").get(row.receipt_id) !== null || current !== row.before_hash;
    db.transaction(() => {
      const used = durableUsage(db, vaultPath, row.day) + (committed ? 1 : 0);
      db.query("INSERT INTO budget_ledger(day,name,used) VALUES (?,'canon_writes_per_day',?) ON CONFLICT(day,name) DO UPDATE SET used=excluded.used").run(row.day, used);
      db.query("DELETE FROM canon_write_reservations WHERE receipt_id=?").run(row.receipt_id);
    }).immediate();
  }
}
