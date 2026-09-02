import type { Database } from "bun:sqlite";
import { tableExists } from "./ledger/schema";

export type DerivedLayer = "search" | "graph";

export interface DerivedMeta {
  layer: DerivedLayer;
  rebuilt_at: string;
  doc_count: number;
}

export function initDerivedMeta(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS derived_meta (
  layer TEXT PRIMARY KEY,
  rebuilt_at TEXT NOT NULL,
  doc_count INTEGER NOT NULL
) STRICT;
`);
}

export function stampDerived(
  db: Database,
  layer: DerivedLayer,
  rebuiltAt: string,
  docCount: number,
): void {
  db.query<never, [string, string, number]>(
    `INSERT INTO derived_meta (layer, rebuilt_at, doc_count)
     VALUES (?, ?, ?)
     ON CONFLICT (layer) DO UPDATE SET
       rebuilt_at = excluded.rebuilt_at,
       doc_count = excluded.doc_count`,
  ).run(layer, rebuiltAt, docCount);
}

export function readDerivedMeta(
  db: Database,
  layer: DerivedLayer,
): DerivedMeta | null {
  if (!tableExists(db, "derived_meta")) return null;
  return (
    db
      .query<DerivedMeta, [string]>(
        `SELECT layer, rebuilt_at, doc_count
           FROM derived_meta
          WHERE layer = ?`,
      )
      .get(layer) ?? null
  );
}
