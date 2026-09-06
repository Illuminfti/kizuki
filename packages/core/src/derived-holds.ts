import type { Database } from "bun:sqlite";
import { readDerivedMeta, stampDerived } from "./derived-meta";
import { tableExists } from "./ledger/schema";
import type { CanonPage } from "./vault/pages";

/** One current hold snapshot for every local projection of the same pages. */
export function readDerivedHolds(db: Database, pages: readonly CanonPage[] = []): {
  paths: Set<string>;
  pageIds: Set<string>;
} {
  const paths = new Set(tableExists(db, "canon_holds")
    ? db.query<{ page_path: string }, []>("SELECT page_path FROM canon_holds").all().map(row => row.page_path)
    : []);
  const pageIds = new Set(pages.filter(page => paths.has(page.relPath)).map(page => page.id));
  if (paths.size === 0) return { paths, pageIds };
  if (tableExists(db, "page_index")) {
    for (const row of db.query<{ page_id: string }, []>(
      "SELECT page_id FROM page_index WHERE rel_path IN (SELECT page_path FROM canon_holds)",
    ).all()) pageIds.add(row.page_id);
  }
  // Retain identity for an unreadable held page during incomplete maintenance.
  if (tableExists(db, "search_documents")) {
    for (const row of db.query<{ doc_id: string }, []>(
      "SELECT doc_id FROM search_documents WHERE scope='canon' AND path IN (SELECT page_path FROM canon_holds)",
    ).all()) {
      pageIds.add(row.doc_id);
      if (row.doc_id.startsWith("page:")) pageIds.add(row.doc_id.slice("page:".length));
    }
  }
  return { paths, pageIds };
}

/** Withheld pages cannot leave a previous complete projection stamp in place. */
export function markDerivedHeld(db: Database, layer: "search" | "graph", count: number): void {
  if (count === 0) return;
  const existing = readDerivedMeta(db, layer);
  if (existing === null) return;
  stampDerived(db, {
    ...existing,
    rebuilt_at: new Date().toISOString(),
    skipped_count: Math.max(existing.skipped_count, count),
    canon_hash: null,
    status: "degraded",
  });
}
