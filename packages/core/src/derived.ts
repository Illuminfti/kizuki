import type { Database } from "bun:sqlite";
import {
  derivedMetaNeedsRebuild,
  stampDerived,
} from "./derived-meta";
import {
  rebuildGraphLayer,
  replacePageEdges,
} from "./graph/graph";
import type { GraphRebuildResult } from "./graph/graph";
import { graphSchemaNeedsRebuild, initGraph } from "./graph/schema";
import { tableExists } from "./ledger/schema";
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

export function applyDerivedV10(db: Database): void {
  const searchWiped =
    tableExists(db, "search_docs") && !tableExists(db, "search_documents");
  const graphWiped = graphSchemaNeedsRebuild(db);
  const metaWiped = derivedMetaNeedsRebuild(db);
  initSearch(db);
  initGraph(db);
  if (!searchWiped && !graphWiped && !metaWiped) return;
  const rebuiltAt = new Date().toISOString();
  const stamp = (layer: "search" | "graph"): void => {
    stampDerived(db, {
      layer,
      generation: "schema-v10",
      rebuilt_at: rebuiltAt,
      doc_count: 0,
      source_count: 0,
      skipped_count: 0,
      status: "degraded",
    });
  };
  if (searchWiped || metaWiped) stamp("search");
  if (graphWiped || metaWiped) stamp("graph");
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
  const pages = listCanonPagesReport(vaultPath).pages;
  db.transaction(() => {
    replacePage(db, page);
    replacePageEdges(db, pages);
  }).immediate();
}

export function removeDerivedPage(
  db: Database,
  pageId: string,
  vaultPath: string,
): void {
  initSearch(db);
  initGraph(db);
  db.transaction(() => {
    removeDoc(db, "canon", pageId);
    replacePageEdges(db, listCanonPagesReport(vaultPath).pages);
  }).immediate();
}
