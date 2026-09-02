import type { Database } from "bun:sqlite";

/**
 * Port-owned FTS5 table. Sensitivity and subjects stay UNINDEXED; unlabeled
 * is stored as the literal `unlabeled` so no ceiling CASE can satisfy it.
 */
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
  db.exec(FTS5_RETRIEVAL_SCHEMA);
}
