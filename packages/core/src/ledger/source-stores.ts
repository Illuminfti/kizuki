import type { Database } from "bun:sqlite";
import type { RetrievalPort } from "../contracts/retrieval";
import { validateAbsenceProof } from "../contracts/retrieval";
import { isLocalSourcePort } from "./source-grants";

export interface OwnedSourceRetrievalStore {
  id: string;
  /** Omitted only for trusted whole-generation erasure of a broken store. */
  port?: RetrievalPort;
  /** Last operation: may close the port and erase its entire disposable generation. */
  maintain?: () => Promise<{ owned_file_maintenance: "complete" | "pending" }>;
}
export interface OwnedSourceRetrievalInventory {
  stores(): Promise<{
    stores: readonly OwnedSourceRetrievalStore[];
    absent_store_ids: readonly string[];
  }>;
}
export interface SourceStoreStatus {
  store_id: string;
  status: "pending" | "logical_absence" | "maintained" | "absent";
}
const storeIds = new WeakMap<object, string>();
function validStoreId(id: string): boolean {
  return /^local:[a-z0-9][a-z0-9._-]{0,127}$/.test(id);
}
export function bindSourceStoreId(port: object, id: string): void {
  if (!validStoreId(id)) throw new Error("invalid owned retrieval identity");
  const prior = storeIds.get(port);
  if (prior !== undefined && prior !== id)
    throw new Error("owned retrieval identity conflict");
  storeIds.set(port, id);
}
export function sourceStoreStatuses(
  db: Database,
  source: string,
): SourceStoreStatus[] {
  return db
    .query<SourceStoreStatus, [string]>(
      "SELECT store_id,status FROM source_retrieval_stores WHERE source_key=? ORDER BY store_id",
    )
    .all(source);
}
/** Durable before the external write, including successful writes and crash-uncertain writes. */
export function recordSourceStoreWrite(
  db: Database,
  port: RetrievalPort,
  evidence: readonly string[],
): void {
  const sources = new Set<string>();
  for (const event of evidence) {
    const row = db
      .query<{ source_key: string }, [string]>(
        "SELECT source_key FROM source_event_bindings WHERE event_id=?",
      )
      .get(event);
    if (row !== null) sources.add(row.source_key);
  }
  if (sources.size === 0) return;
  const id = storeIds.get(port);
  if (id === undefined || !isLocalSourcePort(port))
    throw new Error("owned retrieval identity required");
  db.transaction(() => {
    for (const source of sources) {
      db.query(
        "INSERT INTO source_retrieval_stores VALUES (?,?,'pending') ON CONFLICT(source_key,store_id) DO UPDATE SET status='pending'",
      ).run(source, id);
      db.query(
        "INSERT INTO source_store_inventory (source_key,checked) VALUES (?,0) ON CONFLICT(source_key) DO UPDATE SET checked=0",
      ).run(source);
    }
  }).immediate();
}
export function sourceStoresPending(db: Database, source: string): boolean {
  const bound =
    db
      .query("SELECT 1 FROM source_event_bindings WHERE source_key=? LIMIT 1")
      .get(source) !== null;
  return (
    (bound &&
      db
        .query(
          "SELECT 1 FROM source_store_inventory WHERE source_key=? AND checked=1",
        )
        .get(source) === null) ||
    sourceStoreStatuses(db, source).some(
      (row) => row.status !== "maintained" && row.status !== "absent",
    )
  );
}
/** Caller holds the native writer fence until every awaited operation settles. */
export async function eraseOwnedSourceStores(
  db: Database,
  source: string,
  inventory?: OwnedSourceRetrievalInventory,
): Promise<void> {
  if (inventory === undefined) return;
  const listing = await inventory.stores();
  if (
    !Array.isArray(listing.stores) ||
    !Array.isArray(listing.absent_store_ids) ||
    listing.stores.length > 100 ||
    listing.absent_store_ids.length > 100
  )
    throw new Error("invalid owned retrieval inventory");
  const allIds = [
    ...listing.stores.map((store) => store.id),
    ...listing.absent_store_ids,
  ];
  if (
    allIds.some((id) => !validStoreId(id)) ||
    new Set(allIds).size !== allIds.length
  )
    throw new Error("invalid owned retrieval inventory");
  for (const store of listing.stores) {
    if (
      store.port !== undefined &&
      (!isLocalSourcePort(store.port) || storeIds.get(store.port) !== store.id)
    )
      throw new Error("owned retrieval identity mismatch");
    db.query(
      "INSERT INTO source_retrieval_stores VALUES (?,?,'pending') ON CONFLICT(source_key,store_id) DO NOTHING",
    ).run(source, store.id);
  }
  const ids = db
    .query<{ event_id: string }, [string]>(
      "SELECT event_id FROM source_event_bindings WHERE source_key=?",
    )
    .all(source)
    .map((row) => `event:${row.event_id}`);
  const claims = db
    .query<{ claim_id: string }, [string]>(
      "SELECT DISTINCT c.claim_id FROM claims c JOIN json_each(c.provenance) p JOIN source_event_bindings b ON b.event_id=p.value WHERE b.source_key=?",
    )
    .all(source)
    .map((row) => `claim:${row.claim_id}`);
  const affected = [...ids, ...claims];
  for (const known of sourceStoreStatuses(db, source)) {
    if (listing.absent_store_ids.includes(known.store_id)) {
      db.query(
        "UPDATE source_retrieval_stores SET status='absent' WHERE source_key=? AND store_id=?",
      ).run(source, known.store_id);
      continue;
    }
    if (known.status === "maintained" || known.status === "absent") continue;
    const store = listing.stores.find((store) => store.id === known.store_id);
    if (store === undefined) continue;
    if (store.port !== undefined) {
      if (store.port.rebuildFromDocuments === undefined) continue;
      await store.port.rebuildFromDocuments([]);
      for (let offset = 0; offset < affected.length; offset += 100) {
        const batch = affected.slice(offset, offset + 100);
        const proof = validateAbsenceProof(
          await store.port.verifyAbsent(batch),
          batch,
        );
        if (
          proof.store !== store.port.descriptor.id ||
          proof.found.length !== 0
        )
          throw new Error("owned retrieval absence unproven");
      }
      db.query(
        "UPDATE source_retrieval_stores SET status='logical_absence' WHERE source_key=? AND store_id=?",
      ).run(source, store.id);
    }
    if (
      store.maintain !== undefined &&
      (await store.maintain()).owned_file_maintenance === "complete"
    )
      db.query(
        "UPDATE source_retrieval_stores SET status='maintained' WHERE source_key=? AND store_id=?",
      ).run(source, store.id);
  }
  db.query(
    "INSERT INTO source_store_inventory (source_key,checked) VALUES (?,1) ON CONFLICT(source_key) DO UPDATE SET checked=1",
  ).run(source);
}
