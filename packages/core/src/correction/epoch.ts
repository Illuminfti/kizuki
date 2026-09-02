import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";

const EPOCH_NAME = "claims_epoch";

export function initClaimsEpoch(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS vault_epoch (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;
`);
  db.query(
    `INSERT OR IGNORE INTO vault_epoch (name, value) VALUES (?, 0)`,
  ).run(EPOCH_NAME);
}

export function getClaimsEpoch(db: Database): number {
  if (!tableExists(db, "vault_epoch")) return 0;
  return (
    db
      .query<{ value: number }, [string]>(
        "SELECT value FROM vault_epoch WHERE name = ?",
      )
      .get(EPOCH_NAME)?.value ?? 0
  );
}

export function bumpClaimsEpoch(db: Database): number {
  initClaimsEpoch(db);
  db.query("UPDATE vault_epoch SET value = value + 1 WHERE name = ?").run(EPOCH_NAME);
  return getClaimsEpoch(db);
}
