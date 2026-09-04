import type { Database } from "bun:sqlite";
import { initDerivedMeta } from "../derived-meta";
import { tableExists } from "../ledger/schema";

/**
 * Authoritative document identity. FTS5 cannot enforce a primary key, so
 * upserts go through this table first and the virtual table is kept in step.
 */
export const SEARCH_DOCUMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS search_documents (
  doc_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('canon', 'ledger')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  path TEXT NOT NULL,
  page_type TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  taint TEXT NOT NULL CHECK (taint IN ('clean', 'quoted')),
  authority TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  subjects TEXT NOT NULL,
  provenance TEXT NOT NULL
) STRICT;
`;

const SEARCH_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_docs USING fts5(
  doc_id UNINDEXED,
  scope UNINDEXED,
  title,
  body,
  path UNINDEXED,
  page_type UNINDEXED,
  sensitivity UNINDEXED,
  taint UNINDEXED,
  authority UNINDEXED,
  occurred_at UNINDEXED,
  connector_id UNINDEXED,
  subjects UNINDEXED,
  provenance UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export function initSearch(db: Database): void {
  if (tableExists(db, "search_docs") && !tableExists(db, "search_documents")) {
    db.exec("DROP TABLE search_docs");
  }
  db.exec(SEARCH_DOCUMENTS_SCHEMA);
  db.exec(SEARCH_FTS_SCHEMA);
  initDerivedMeta(db);
}
