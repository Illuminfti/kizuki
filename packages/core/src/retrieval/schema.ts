import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";

/**
 * Port-owned FTS5 table. Sensitivity and subjects stay UNINDEXED; unlabeled
 * is stored as the literal `unlabeled` so no ceiling CASE can satisfy it.
 * Identity lives in search_documents so upsert cannot duplicate a doc_id.
 */
export const FTS5_DOCUMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS search_documents (
  doc_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  taint TEXT NOT NULL,
  authority TEXT NOT NULL,
  subjects TEXT NOT NULL,
  provenance TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`;

export const FTS5_RETRIEVAL_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_docs USING fts5(
  doc_id UNINDEXED,
  kind UNINDEXED,
  title,
  text,
  sensitivity UNINDEXED,
  taint UNINDEXED,
  authority UNINDEXED,
  subjects UNINDEXED,
  provenance UNINDEXED,
  occurred_at UNINDEXED,
  updated_at UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export const FTS5_RETRIEVAL_STORE_REL = "store/retrieval.db";
export const FTS5_RETRIEVAL_ENGINE_REL = "engine.json";
export const UNLABELED_SENSITIVITY = "unlabeled";

export function initFts5RetrievalStore(db: Database): void {
  if (tableExists(db, "search_docs") && !tableExists(db, "search_documents")) {
    db.exec("DROP TABLE search_docs");
  }
  db.exec(FTS5_DOCUMENTS_SCHEMA);
  db.exec(FTS5_RETRIEVAL_SCHEMA);
}
