import type { Database } from "bun:sqlite";

export function tableExists(db: Database, name: string): boolean {
  return db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(name) !== null;
}
