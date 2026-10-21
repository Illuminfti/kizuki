import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { purgeDiscoveryPending } from "../derived-holds";
import { checkpointGraphEvidence, graphEvidenceChanges, graphRegistryReady, rebuildGraph, refreshRegisteredPage } from "../graph/graph";
import { initGraph } from "../graph/schema";
import { CanonPageUnreadable, readPage, type ExistingPage } from "./store";

/** Disposable graph maintenance runs outside canon writer ownership. */
export function reconcileCanonGraph(db: Database, vaultPath: string): void {
  if (db.inTransaction || purgeDiscoveryPending(db)) return;
  initGraph(db);
  if (!graphRegistryReady(db)) { rebuildGraph(db, vaultPath); return; }
  if (graphEvidenceChanges(db).length === 0) return;
  db.transaction(() => {
    for (const id of graphEvidenceChanges(db)) {
      const row = db.query<{ rel_path: string }, [string]>("SELECT rel_path FROM graph_pages WHERE page_id=?").get(id);
      if (row === null) continue;
      let read: ExistingPage | null;
      try { read = readPage({ db, vault_path: vaultPath }, row.rel_path); }
      catch (error) {
        if (!(error instanceof CanonPageUnreadable)) throw error;
        // Maintenance runs after the write committed. Reconcile an unreadable
        // cached path through the existing partial-walk rules rather than
        // replacing the successful writer result with this read failure.
        rebuildGraph(db, vaultPath);
        return;
      }
      if (read === null || read.page.data["id"] !== id) { rebuildGraph(db, vaultPath); return; }
      refreshRegisteredPage(db, { id, relPath: row.rel_path, path: join(vaultPath, row.rel_path),
        data: read.page.data, body: read.page.body, contentHash: read.hash });
      if (!graphRegistryReady(db)) return;
    }
    checkpointGraphEvidence(db);
  }).immediate();
}
