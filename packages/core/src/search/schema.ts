import type { Database } from "bun:sqlite";

const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_docs USING fts5(
  doc_id UNINDEXED,
  scope UNINDEXED,
  title,
  body,
  path UNINDEXED,
  page_type UNINDEXED,
  sensitivity UNINDEXED,
  occurred_at UNINDEXED,
  connector_id UNINDEXED,
  subjects UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS derived_meta (
  layer TEXT PRIMARY KEY,
  rebuilt_at TEXT NOT NULL,
  doc_count INTEGER NOT NULL
) STRICT;
`;

export function initSearch(db: Database): void {
  db.exec(SEARCH_SCHEMA);
}
