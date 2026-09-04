import type { Database } from "bun:sqlite";
import {
  rebuildGraphLayer,
  replacePageEdges,
  removePageEdges,
} from "./graph/graph";
import type { GraphRebuildResult } from "./graph/graph";
import { linkIndexFromPages } from "./graph/resolve";
import { initGraph } from "./graph/schema";
import {
  rebuildSearchLayer,
  removeDoc,
  replacePage,
} from "./search/indexer";
import type { SearchRebuildResult } from "./search/indexer";
import { initSearch } from "./search/schema";
import { ulid } from "./util/ulid";
import {
  canonPagesHash,
  isLiveCanonPage,
  listCanonPagesReport,
} from "./vault/pages";
import type { CanonPage } from "./vault/pages";

export interface DerivedRebuildResult {
  search: SearchRebuildResult;
  graph: GraphRebuildResult;
  generation: string;
}

export function rebuildDerived(
  db: Database,
  vaultPath: string,
): DerivedRebuildResult {
  const report = listCanonPagesReport(vaultPath);
  const live = report.pages.filter(isLiveCanonPage);
  const generation = ulid();
  const rebuiltAt = new Date().toISOString();
  const input = {
    generation,
    pages: live,
    skipped: report.skipped,
    rebuilt_at: rebuiltAt,
    canon_hash: canonPagesHash(live),
  };
  initSearch(db);
  initGraph(db);
  return db.transaction(() => {
    const search = rebuildSearchLayer(db, input);
    const graph = rebuildGraphLayer(db, input);
    return { search, graph, generation };
  }).immediate();
}

/** One incremental write path: search and graph for a single page. */
export function refreshDerivedPage(
  db: Database,
  page: CanonPage,
  vaultPath: string,
): void {
  initSearch(db);
  initGraph(db);
  const index = linkIndexFromPages(listCanonPagesReport(vaultPath).pages);
  db.transaction(() => {
    replacePage(db, page);
    replacePageEdges(db, page, index);
  }).immediate();
}

export function removeDerivedPage(db: Database, pageId: string): void {
  initSearch(db);
  initGraph(db);
  db.transaction(() => {
    removeDoc(db, "canon", pageId);
    removePageEdges(db, pageId);
  }).immediate();
}
