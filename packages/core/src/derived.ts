import type { Database } from "bun:sqlite";
import {
  derivedMetaNeedsRebuild,
  readDerivedMeta,
  stampDerived,
} from "./derived-meta";
import {
  graphRegistryCurrent,
  graphRegistryReady,
  rebuildGraphLayer,
  refreshPageEdges,
  refreshRegisteredPage,
  removePageEdges,
  removeRegisteredPage,
} from "./graph/graph";
import type { GraphRebuildResult } from "./graph/graph";
import { graphSchemaNeedsRebuild, initGraph } from "./graph/schema";
import { readSchemaVersion } from "./ledger/integrity";
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
import { resetWorldTables } from "./world/tables/registry";
import {
  canonPagesHash,
  fatalCanonSkips,
  isLiveCanonPage,
  listCanonPagesReport,
  scanCanonSignatures,
} from "./vault/pages";
import type { CanonPage } from "./vault/pages";
import { assertVaultMutationScope, type VaultMutationScope } from "./vault/mutation-scope";

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
  if (fatalCanonSkips(report.skipped).length > 0) {
    throw new Error("canon is unreadable; derived rebuild refused");
  }
  const live = report.pages.filter(isLiveCanonPage);
  const generation = ulid();
  const rebuiltAt = new Date().toISOString();
  const input = {
    generation,
    pages: live,
    skipped: report.skipped,
    signatures: report.signatures,
    rebuilt_at: rebuiltAt,
    canon_hash: canonPagesHash(live),
  };
  initSearch(db);
  initGraph(db);
  return db.transaction(() => {
    const search = rebuildSearchLayer(db, input);
    // Held inactive pages still provide aliases needed to exclude relations.
    const graph = rebuildGraphLayer(db, { ...input, pages: report.pages });
    return { search, graph, generation };
  }).immediate();
}

/**
 * `kizuki rebuild --layer world`: derived and cache world tables return to
 * their initial state. Authority and bookkeeping tables are never touched.
 */
export function rebuildWorldLayer(db: Database): { layer: "world"; tables: string[] } {
  return db.transaction(() => ({ layer: "world" as const, tables: resetWorldTables(db, readSchemaVersion(db)) })).immediate();
}

/**
 * One incremental projection path. A live writer scope uses the reconciled
 * registry and assesses only this page. Ordinary refresh reconciles external
 * edits with a stat scan, taking a full walk when another file changed.
 */
export function refreshDerivedPage(
  db: Database,
  page: CanonPage,
  vaultPath: string,
  scope?: VaultMutationScope,
): void {
  if (scope !== undefined) assertVaultMutationScope(scope, { db, vault_path: vaultPath });
  initSearch(db);
  initGraph(db);
  // The writer already checked the exact receipted bytes and source admission.
  // Reconciliation of unrelated disk edits belongs to the normal refresh/rebuild.
  if (scope !== undefined && graphRegistryReady(db)) {
    db.transaction(() => { replacePage(db, page); refreshRegisteredPage(db, page); }).immediate();
    return;
  }
  const signatures = scanCanonSignatures(vaultPath);
  const report = graphRegistryCurrent(db, signatures, page) ? null : listCanonPagesReport(vaultPath);
  db.transaction(() => {
    replacePage(db, page);
    if (report === null) refreshRegisteredPage(db, page, signatures);
    else refreshPageEdges(db, page, report.pages, report.skipped.length, report.signatures);
  }).immediate();
}

export function removeDerivedPage(
  db: Database,
  pageId: string,
  vaultPath: string,
  scope?: VaultMutationScope,
): void {
  if (scope !== undefined) assertVaultMutationScope(scope, { db, vault_path: vaultPath });
  initSearch(db);
  initGraph(db);
  if (scope !== undefined && graphRegistryReady(db)) {
    db.transaction(() => { removeDoc(db, "canon", pageId); removeRegisteredPage(db, pageId); }).immediate();
    return;
  }
  const signatures = scanCanonSignatures(vaultPath);
  const report = graphRegistryCurrent(db, signatures, { id: pageId }) ? null : listCanonPagesReport(vaultPath);
  db.transaction(() => {
    removeDoc(db, "canon", pageId);
    if (report === null) removeRegisteredPage(db, pageId);
    else removePageEdges(db, pageId, report.pages, report.skipped.length, report.signatures);
  }).immediate();
}
