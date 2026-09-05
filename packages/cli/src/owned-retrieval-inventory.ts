import { lstatSync, opendirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bindLocalSourcePort, openOwnedDirectory, createFts5RetrievalPort, eraseOwnedFts5Generation, Fts5RetrievalPort, FTS5_RETRIEVAL_ID } from "@kizuki/core";
import type { OwnedSourceRetrievalInventory, OwnedSourceRetrievalStore, PortContext, RetrievalPort } from "@kizuki/core";
import { EmbeddedRetrievalPort, EMBEDDED_RETRIEVAL_ID, eraseOwnedEmbeddedGeneration, openEmbeddedRetrievalPort } from "@kizuki/retrieval-pg";

const KNOWN = [FTS5_RETRIEVAL_ID, EMBEDDED_RETRIEVAL_ID] as const;
export class OwnedRetrievalInventoryError extends Error {
  constructor() { super("owned_retrieval_inventory_unavailable: unknown, unsafe, or inaccessible managed root; revocation remains pending"); }
}
function directory(path: string): boolean {
  try { if (!lstatSync(path).isDirectory()) throw new OwnedRetrievalInventoryError(); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new OwnedRetrievalInventoryError(); }
}
/** Absence is proved from an existing safe ancestor, never from configuration. */
function present(path: string): boolean {
  const chain: string[] = [];
  for (let part = resolve(path); ; part = dirname(part)) {
    if (chain.length >= 256) throw new OwnedRetrievalInventoryError(); chain.push(part);
    if (part === dirname(part)) break;
  }
  for (const part of chain.reverse()) if (!directory(part)) return false;
  return true;
}
function context(vaultPath: string, id: string): PortContext {
  return { vault_path: vaultPath, data_dir: join(vaultPath, ".kizuki/retrieval", id), config: {}, secrets: async () => { throw new Error("owned maintenance has no secrets"); }, clock: () => new Date().toISOString(), logger: () => {} };
}
export function createOwnedRetrievalInventory(vaultPath: string, current?: RetrievalPort): OwnedSourceRetrievalInventory & { close(): Promise<void>; diagnostic(): string | null } {
  const opened: RetrievalPort[] = [];
  const emptyRoots: ReturnType<typeof openOwnedDirectory>[] = [];
  let listing: Awaited<ReturnType<OwnedSourceRetrievalInventory["stores"]>> | undefined;
  let closed = false;
  let diagnostic: string | null = null;
  return {
    async stores() {
      if (closed) throw new OwnedRetrievalInventoryError();
      if (listing) return listing;
      const root = resolve(vaultPath, ".kizuki/retrieval");
      if (present(root)) {
        const dir = opendirSync(root); let count = 0;
        try { for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++count > KNOWN.length || !KNOWN.includes(entry.name as typeof KNOWN[number])) throw new OwnedRetrievalInventoryError();
          if (!present(join(root, entry.name))) throw new OwnedRetrievalInventoryError();
        } } finally { dir.closeSync(); }
      }
      const stores: OwnedSourceRetrievalStore[] = [], absent_store_ids: string[] = [];
      for (const id of KNOWN) {
        const ctx = context(resolve(vaultPath), id), storeId = `local:${id}`;
        if (!present(ctx.data_dir)) { absent_store_ids.push(storeId); continue; }
        // Preflight before SQL construction: opening must not follow attacker-replaced children.
        try {
          if (id === FTS5_RETRIEVAL_ID) Fts5RetrievalPort.validateOwnedGeneration(ctx);
          else EmbeddedRetrievalPort.validateOwnedGeneration(ctx);
        } catch { stores.push({ id: storeId }); continue; }
        let port: Fts5RetrievalPort | EmbeddedRetrievalPort | undefined;
        if (id === FTS5_RETRIEVAL_ID && current instanceof Fts5RetrievalPort || id === EMBEDDED_RETRIEVAL_ID && current instanceof EmbeddedRetrievalPort) {
          if (!current.ownsGeneration(vaultPath)) throw new OwnedRetrievalInventoryError();
          port = current;
        }
        else if (present(join(ctx.data_dir, "store"))) {
          // A previous maintenance pass may have erased this generation while
          // another store remained busy. Opening SQL here would recreate it.
          // Retain the root's SQL-free maintenance handle for resumable proof.
          try { port = id === FTS5_RETRIEVAL_ID ? createFts5RetrievalPort(ctx) : await openEmbeddedRetrievalPort(ctx); opened.push(port); }
          catch { /* A busy or broken generation must remain reachable by SQL-free recovery. */ }
        }
        // Init reserves an empty FTS directory even when only the ledger floor
        // has ever run. It contains no generation and has no writer lock yet.
        // Prove literal emptiness through a captured fd; never create SQL/locks
        // or treat a missing store inside a nonempty root as proof of absence.
        if (id === FTS5_RETRIEVAL_ID && current?.descriptor.id !== id && port === undefined) {
          let emptyRoot: ReturnType<typeof openOwnedDirectory> | undefined;
          try {
            emptyRoot = openOwnedDirectory(ctx.data_dir);
            if (emptyRoot.isEmpty()) {
              const root = emptyRoot;
              emptyRoots.push(root);
              emptyRoot = undefined;
              stores.push({ id: storeId, maintain: async () => {
                try { return { owned_file_maintenance: root.isEmpty() ? "complete" : "pending" }; }
                catch { return { owned_file_maintenance: "pending" }; }
              } });
              continue;
            }
          } catch { /* Unsupported or unverifiable roots retain pending maintenance. */ }
          finally { emptyRoot?.close(); }
        }

        const active = port;
        if (active) bindLocalSourcePort(active, { store_id: storeId });
        stores.push({ id: storeId, ...(active ? { port: active } : {}), maintain: async () => {
          try {
            if (active) await active.eraseOwnedGeneration();
            else if (id === FTS5_RETRIEVAL_ID) await eraseOwnedFts5Generation(ctx);
            else await eraseOwnedEmbeddedGeneration(ctx);
            return { owned_file_maintenance: "complete" };
          } catch (error) {
            if (error instanceof Error && error.message.includes("owned_generation_changed_restart_required")) diagnostic = error.message.includes("active_sql_uncontained") ? "process_restart_required_active_sql_uncontained" : "process_restart_required";
            return { owned_file_maintenance: "pending" };
          }
        } });
      }
      return listing = { stores, absent_store_ids };
    },
    diagnostic() { return diagnostic; },
    async close() {
      if (closed) return; closed = true;
      const results = await Promise.allSettled(opened.map(port => port.close()));
      for (const root of emptyRoots) root.close();
      if (results.some(result => result.status === "rejected")) throw new OwnedRetrievalInventoryError();
    },
  };
}
