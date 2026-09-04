import type { Database } from "bun:sqlite";
import { initDerivedMeta } from "../derived-meta";
import { tableExists } from "../ledger/schema";

const GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  dest_sensitivity TEXT,
  taint TEXT NOT NULL CHECK (taint IN ('clean', 'quoted')),
  authority TEXT NOT NULL,
  provenance TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  PRIMARY KEY (src, dst, kind)
) STRICT;

CREATE INDEX IF NOT EXISTS graph_edges_dst_idx ON graph_edges (dst);
CREATE INDEX IF NOT EXISTS graph_edges_src_idx ON graph_edges (src);
`;

export function graphSchemaNeedsRebuild(db: Database): boolean {
  if (!tableExists(db, "graph_edges")) return false;
  const columns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(graph_edges)")
      .all()
      .map((column) => column.name),
  );
  return !columns.has("sensitivity") || !columns.has("dest_sensitivity");
}

export function initGraph(db: Database): void {
  if (graphSchemaNeedsRebuild(db)) {
    db.exec("DROP TABLE graph_edges");
  }
  db.exec(GRAPH_SCHEMA);
  initDerivedMeta(db);
}
