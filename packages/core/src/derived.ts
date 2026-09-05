import { canonAuthorities } from "./canon/authority";
import type { Database } from "bun:sqlite";
import {
  derivedMetaNeedsRebuild,
  readDerivedMeta,
  stampDerived,
} from "./derived-meta";
import {
  rebuildGraphLayer,
  refreshPageEdges,
  removePageEdges,
} from "./graph/graph";
import type { GraphRebuildResult } from "./graph/graph";
import { graphSchemaNeedsRebuild, initGraph } from "./graph/schema";
import { tableExists } from "./ledger/schema";
import {
  projectSearchDocs,
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
  const hadFts = tableExists(db, "search_docs");
  const hadCompanion = tableExists(db, "search_documents");
  const hadSearchMeta = readDerivedMeta(db, "search") !== null;
  const hadGraph = tableExists(db, "graph_edges");
  const searchRestored = !hadFts && hadCompanion;
  const searchWiped =
    (hadFts && !hadCompanion) || (!hadFts && !hadCompanion && hadSearchMeta);
  const graphWiped = graphSchemaNeedsRebuild(db);
  const metaWiped = derivedMetaNeedsRebuild(db);
  // A ledger-only vault stays ledger-only. Derived tables appear when a
  // layer already existed, a companion can restore it, or a wipe left a stamp.
  if (hadFts || hadCompanion || searchWiped || searchRestored || metaWiped) {
    initSearch(db);
  }
  if (hadGraph || graphWiped || metaWiped) {
    initGraph(db);
  }
  if (searchRestored) projectSearchDocs(db);
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
  if (report.skipped.length > 0) throw new Error("canon is unreadable; derived rebuild refused");
  const live = report.pages.filter(isLiveCanonPage);
  const generation = ulid();
  const rebuiltAt = new Date().toISOString();
  const input = {
    generation,
    authorities:canonAuthorities(db,live),
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
  const report = listCanonPagesReport(vaultPath);
  db.transaction(() => {
    const authorities=canonAuthorities(db,report.pages);
    replacePage(db, page,authorities.get(page.relPath)??"model_inference");
    refreshPageEdges(db, page, report.pages, report.skipped.length,authorities);
  }).immediate();
}

export function removeDerivedPage(
  db: Database,
  pageId: string,
  vaultPath: string,
): void {
  initSearch(db);
  initGraph(db);
  const report = listCanonPagesReport(vaultPath);
  db.transaction(() => {
    removeDoc(db, "canon", pageId);
    removePageEdges(db, pageId, report.pages, report.skipped.length);
  }).immediate();
}
