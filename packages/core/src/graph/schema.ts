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

-- What the last full projection learned about each page: enough to project one
-- page's edges, and every edge its identity touches, without reading the vault.
CREATE TABLE IF NOT EXISTS graph_pages (
  page_id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,
  title TEXT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  admitted INTEGER NOT NULL CHECK (admitted IN (0, 1)),
  sensitivity TEXT NOT NULL,
  taint TEXT NOT NULL CHECK (taint IN ('clean', 'quoted')),
  authority TEXT,
  provenance TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS graph_pages_path_idx ON graph_pages (rel_path);
CREATE INDEX IF NOT EXISTS graph_pages_admission_idx ON graph_pages (active, admitted);

CREATE TABLE IF NOT EXISTS graph_page_sources (
  page_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (page_id, event_id)
) STRICT;
CREATE INDEX IF NOT EXISTS graph_page_sources_event_idx ON graph_page_sources (event_id, page_id);

-- Indexed names let one page's links resolve without loading every page.
CREATE TABLE IF NOT EXISTS graph_page_keys (
  key TEXT NOT NULL,
  page_id TEXT NOT NULL,
  PRIMARY KEY (key, page_id)
) STRICT;
CREATE INDEX IF NOT EXISTS graph_page_keys_id_idx ON graph_page_keys (page_id);

-- Raw wikilink and subject targets; key is the lowercase form a link resolves by.
CREATE TABLE IF NOT EXISTS graph_links (
  src TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wikilink', 'subject')),
  target TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (src, kind, target)
) STRICT;

CREATE INDEX IF NOT EXISTS graph_links_key_idx ON graph_links (key);

-- The stat signature of every markdown file the walk saw; a page is refreshed
-- alone only while the vault still matches, apart from the page itself.
CREATE TABLE IF NOT EXISTS graph_files (
  rel_path TEXT PRIMARY KEY,
  signature TEXT NOT NULL
) STRICT;

-- One row once a walk has filled the tables above; its count is how many
-- files that walk could not read as pages.
CREATE TABLE IF NOT EXISTS graph_registry (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  skipped INTEGER NOT NULL CHECK (skipped >= 0),
  event_rowid INTEGER NOT NULL,
  source_epoch INTEGER NOT NULL
) STRICT;
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
    db.exec("DROP TABLE graph_edges; DROP TABLE IF EXISTS graph_pages; DROP TABLE IF EXISTS graph_links; DROP TABLE IF EXISTS graph_files; DROP TABLE IF EXISTS graph_registry; DROP TABLE IF EXISTS graph_page_keys; DROP TABLE IF EXISTS graph_page_sources");
  }
  // Older disposable registries lack resolution or evidence indexes. Reconcile
  // once rather than treating their stale admission as current authority.
  if (tableExists(db, "graph_registry") && (!tableExists(db, "graph_edges") || !tableExists(db, "graph_page_keys") || !tableExists(db, "graph_page_sources") ||
      !db.query<{ name: string }, []>("PRAGMA table_info(graph_registry)").all().some(column => column.name === "source_epoch"))) {
    db.exec("DROP TABLE graph_registry");
  }
  db.exec(GRAPH_SCHEMA);
  initDerivedMeta(db);
}
