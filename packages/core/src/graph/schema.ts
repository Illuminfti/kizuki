import type { Database } from "bun:sqlite";
import { initDerivedMeta } from "../derived-meta";

const GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
) STRICT;

-- The primary key already covers the src half of a neighbor probe; without
-- this index the dst half is a table scan. A database written before the
-- index existed gains it on the next rebuild, so no migration is needed:
-- every table here is derived.
CREATE INDEX IF NOT EXISTS graph_edges_dst_idx ON graph_edges (dst);
`;

export function initGraph(db: Database): void {
  db.exec(GRAPH_SCHEMA);
  initDerivedMeta(db);
}
