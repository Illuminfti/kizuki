import type { Database } from "bun:sqlite";
import { initDerivedMeta } from "../derived-meta";

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
`;

export function initSearch(db: Database): void {
  db.exec(SEARCH_SCHEMA);
  initDerivedMeta(db);
}
