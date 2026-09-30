import type { Database } from "bun:sqlite";
import { assertDerivedDiscoveryReady, readDerivedHolds } from "./derived-holds";
import { readDerivedMeta } from "./derived-meta";
import { refreshSearchHealth } from "./derived-health";
import { replacePageEdges, refreshPageEdgesBatch, refreshGraphHealth } from "./graph/graph";
import { initGraph } from "./graph/schema";
import { tableExists } from "./ledger/schema";
import { pageDocument, projectSearchDocs, replacePage, removeCanonPath } from "./search/indexer";
import { initSearch } from "./search/schema";
import { listCanonPagesReport } from "./vault/pages";
import { projectablePageEvidence } from "./vault/provenance";

/** Retry current exclusions, including repairs that produced no new receipt. */
export function reconcileDerivedPages(db: Database, vaultPath: string): void {
  const report = listCanonPagesReport(vaultPath);
  const hadFts = tableExists(db, "search_docs");
  const hadGraph = tableExists(db, "graph_edges");
  initSearch(db);
  initGraph(db);
  db.transaction(() => {
    assertDerivedDiscoveryReady(db);
    if (!hadFts) projectSearchDocs(db, report.pages);
    const evidence = projectablePageEvidence(db, report.pages);
    for (const path of readDerivedHolds(db).paths) evidence.delete(path);
    const stored = new Map(db.query<{ path: string; doc_id: string; title: string; body: string; page_type: string; sensitivity: string; taint: string; authority: string; subjects: string; provenance: string }, []>(
      "SELECT path, doc_id, title, body, page_type, sensitivity, taint, authority, subjects, provenance FROM search_documents WHERE scope='canon'",
    ).all().map(row => [row.path, row]));
    let changed = !hadGraph || readDerivedMeta(db, "graph")?.status !== "ok";
    for (const page of report.pages) {
      const admitted = evidence.get(page.relPath);
      const previous = stored.get(page.relPath);
      stored.delete(page.relPath);
      if (admitted === undefined) {
        if (previous !== undefined) { removeCanonPath(db, page.relPath); changed = true; }
        continue;
      }
      const next = pageDocument(page, admitted.revision.authority);
      if (previous !== undefined && previous.doc_id === next.docId && previous.title === next.title
        && previous.body === next.body && previous.page_type === next.pageType && previous.sensitivity === next.sensitivity
        && previous.taint === next.taint && previous.authority === next.authority
        && previous.subjects === JSON.stringify(next.subjects) && previous.provenance === JSON.stringify(next.provenance)
        && db.query("SELECT 1 FROM search_docs f JOIN search_documents d ON d.rowid=f.rowid WHERE d.doc_id=? AND f.doc_id=d.doc_id").get(next.docId) !== null) continue;
      replacePage(db, page);
      changed = true;
    }
    for (const path of stored.keys()) { removeCanonPath(db, path); changed = true; }
    if (changed) {
      // A partial walk never certifies a full graph. The existing incremental
      // writer preserves that distinction and withdraws known exclusions.
      if (report.skipped.length === 0) replacePageEdges(db, report.pages);
      else refreshPageEdgesBatch(db, report.pages, report.pages, report.skipped.length);
    }
    refreshGraphHealth(db, report.pages, report.skipped.length);
    refreshSearchHealth(db, report);
  }).immediate();
}
