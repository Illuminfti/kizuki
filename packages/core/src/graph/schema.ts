import type { Database } from "bun:sqlite";
import { initDerivedMeta } from "../derived-meta";
import { tableExists } from "../ledger/schema";

const GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
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

export function initGraph(db: Database): void {
  if (tableExists(db, "graph_edges")) {
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(graph_edges)")
      .all();
    if (!columns.some((column) => column.name === "sensitivity")) {
      db.exec("DROP TABLE graph_edges");
    }
  }
  db.exec(GRAPH_SCHEMA);
  initDerivedMeta(db);
}
