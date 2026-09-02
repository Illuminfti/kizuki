import type { Database } from "bun:sqlite";
import { initDerivedMeta } from "../derived-meta";

const GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind)
) STRICT;

CREATE INDEX IF NOT EXISTS graph_edges_dst_idx ON graph_edges (dst);
`;

export function initGraph(db: Database): void {
  db.exec(GRAPH_SCHEMA);
  initDerivedMeta(db);
}
