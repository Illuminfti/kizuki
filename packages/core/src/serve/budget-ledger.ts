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
