import type { Database } from "bun:sqlite";

const GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
) STRICT;

CREATE TABLE IF NOT EXISTS derived_meta (
  layer TEXT PRIMARY KEY,
  rebuilt_at TEXT NOT NULL,
  doc_count INTEGER NOT NULL
) STRICT;
`;

export function initGraph(db: Database): void {
  db.exec(GRAPH_SCHEMA);
}
