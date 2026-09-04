import type { Database } from "bun:sqlite";
import { tableExists } from "./ledger/schema";
import { isRfc3339 } from "./util/time";

export const DERIVED_LAYERS = [
  "search",
  "graph",
  "vector",
  "entities",
] as const;
export type DerivedLayer = (typeof DERIVED_LAYERS)[number];

export const DERIVED_STATUSES = [
  "ok",
  "degraded",
  "failed",
  "partial",
] as const;
export type DerivedStatus = (typeof DERIVED_STATUSES)[number];

export interface DerivedMeta {
  layer: DerivedLayer;
  generation: string;
  rebuilt_at: string;
  doc_count: number;
  source_count: number;
  skipped_count: number;
  status: DerivedStatus;
  ledger_watermark: string | null;
  canon_hash: string | null;
  port_id: string | null;
  contract: string | null;
  space: string | null;
}

export interface DerivedStamp {
  layer: DerivedLayer;
  generation: string;
  rebuilt_at: string;
  doc_count: number;
  source_count: number;
  skipped_count: number;
  status: DerivedStatus;
  ledger_watermark?: string | null;
  canon_hash?: string | null;
  port_id?: string | null;
  contract?: string | null;
  space?: string | null;
}

const DERIVED_META_SCHEMA = `
CREATE TABLE IF NOT EXISTS derived_meta (
  layer TEXT PRIMARY KEY CHECK (layer IN ('search', 'graph', 'vector', 'entities')),
  generation TEXT NOT NULL,
  rebuilt_at TEXT NOT NULL,
  doc_count INTEGER NOT NULL CHECK (doc_count >= 0),
  source_count INTEGER NOT NULL CHECK (source_count >= 0),
  skipped_count INTEGER NOT NULL CHECK (skipped_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'failed', 'partial')),
  ledger_watermark TEXT,
  canon_hash TEXT,
  port_id TEXT,
  contract TEXT,
  space TEXT
) STRICT;
`;

function isDerivedLayer(value: string): value is DerivedLayer {
  return (DERIVED_LAYERS as readonly string[]).includes(value);
}

function isDerivedStatus(value: string): value is DerivedStatus {
  return (DERIVED_STATUSES as readonly string[]).includes(value);
}

export function derivedMetaNeedsRebuild(db: Database): boolean {
  if (!tableExists(db, "derived_meta")) return false;
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(derived_meta)")
    .all();
  return !columns.some((column) => column.name === "status");
}

export function initDerivedMeta(db: Database): void {
  if (derivedMetaNeedsRebuild(db)) {
    db.exec("DROP TABLE derived_meta");
  }
  db.exec(DERIVED_META_SCHEMA);
}

export function applyDerivedV9(db: Database): void {
  initDerivedMeta(db);
  if (tableExists(db, "search_docs") && !tableExists(db, "search_documents")) {
    db.exec("DROP TABLE search_docs");
  }
  if (tableExists(db, "graph_edges")) {
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(graph_edges)")
      .all();
    if (!columns.some((column) => column.name === "sensitivity")) {
      db.exec("DROP TABLE graph_edges");
    }
  }
}

function assertStamp(stamp: DerivedStamp): void {
  if (!isDerivedLayer(stamp.layer)) {
    throw new RangeError(`derived layer ${stamp.layer} is unknown`);
  }
  if (!isDerivedStatus(stamp.status)) {
    throw new RangeError(`derived status ${stamp.status} is unknown`);
  }
  if (stamp.generation.length === 0) {
    throw new RangeError("derived generation is required");
  }
  if (!isRfc3339(stamp.rebuilt_at)) {
    throw new RangeError("derived rebuilt_at must be RFC3339");
  }
  if (Date.parse(stamp.rebuilt_at) > Date.now() + 1_000) {
    throw new RangeError("derived rebuilt_at must not be in the future");
  }
  for (const field of ["doc_count", "source_count", "skipped_count"] as const) {
    if (!Number.isSafeInteger(stamp[field]) || stamp[field] < 0) {
      throw new RangeError(`derived ${field} must be a non-negative integer`);
    }
  }
}

export function stampDerived(db: Database, stamp: DerivedStamp): void {
  assertStamp(stamp);
  initDerivedMeta(db);
  db.query<
    never,
    [
      string,
      string,
      string,
      number,
      number,
      number,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO derived_meta (
       layer, generation, rebuilt_at, doc_count, source_count, skipped_count,
       status, ledger_watermark, canon_hash, port_id, contract, space
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (layer) DO UPDATE SET
       generation = excluded.generation,
       rebuilt_at = excluded.rebuilt_at,
       doc_count = excluded.doc_count,
       source_count = excluded.source_count,
       skipped_count = excluded.skipped_count,
       status = excluded.status,
       ledger_watermark = excluded.ledger_watermark,
       canon_hash = excluded.canon_hash,
       port_id = excluded.port_id,
       contract = excluded.contract,
       space = excluded.space`,
  ).run(
    stamp.layer,
    stamp.generation,
    stamp.rebuilt_at,
    stamp.doc_count,
    stamp.source_count,
    stamp.skipped_count,
    stamp.status,
    stamp.ledger_watermark ?? null,
    stamp.canon_hash ?? null,
    stamp.port_id ?? null,
    stamp.contract ?? null,
    stamp.space ?? null,
  );
}

export function readDerivedMeta(
  db: Database,
  layer: DerivedLayer,
): DerivedMeta | null {
  if (!tableExists(db, "derived_meta")) return null;
  if (derivedMetaNeedsRebuild(db)) return null;
  return (
    db
      .query<DerivedMeta, [string]>(
        `SELECT layer, generation, rebuilt_at, doc_count, source_count,
                skipped_count, status, ledger_watermark, canon_hash,
                port_id, contract, space
           FROM derived_meta
          WHERE layer = ?`,
      )
      .get(layer) ?? null
  );
}
