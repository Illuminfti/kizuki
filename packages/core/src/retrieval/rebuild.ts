import { recordSourceStoreWrite } from "../ledger/source-stores";
import { assertVaultMutationScope, VaultMutationError, withVaultMutationAsync, type VaultMutationScope } from "../vault/mutation-scope";
import { sourcePolicyEpoch, isLocalSourcePort, sourceSensitivity, requireSourceEvents, sourceEventsAllowed, invalidateLocalSourcePort } from "../ledger/source-grants";
import type { Database } from "bun:sqlite";
import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { OWNER, sensitivity } from "../agents";
import { claimRetrievalDoc, listClaims } from "../claims/store";
import { PortError } from "../contracts/ports";
import { validateRetrievalDoc, validateAbsenceProof } from "../contracts/retrieval";
import type { RetrievalDoc, RetrievalPort } from "../contracts/retrieval";
import { rebuildDerived } from "../derived";
import { loadCanon, pageDecision } from "../serving/canon";
import { claimReader } from "../serving/claims";
import { currentQuotedSource, eventDecision } from "../serving/ledger";
import { sha256Hex } from "../util/hash";
import { isRfc3339 } from "../util/time";
import { isLiveCanonPage, stringArray } from "../vault/pages";

export const MAX_REBUILD_RECORDS = 10_000;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

function tooLarge(): never {
  throw new PortError("config_invalid", "rebuild corpus exceeds 10000 records, 20000 filesystem entries, or 64 MiB of source text", false);
}

/** Inspect only the named vault; refuse oversized or linked canon before reading it. */
function boundCanon(vaultPath: string): void {
  let entries = 0;
  let bytes = 0;
  const pending = [vaultPath];
  while (pending.length > 0) {
    for (const entry of readdirSync(pending.pop()!, { withFileTypes: true })) {
      if (++entries > MAX_REBUILD_RECORDS * 2) tooLarge();
      if (entry.name === ".kizuki" || entry.name === "archive") continue;
      const path = join(entry.parentPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new PortError("config_invalid", "rebuild refuses linked canon entries", false);
      }
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        bytes += lstatSync(path).size;
        if (bytes > MAX_SOURCE_BYTES) tooLarge();
      }
    }
  }
}

interface RebuildSnapshot {
  epoch: number;
  docs: RetrievalDoc[];
  revisions: Map<string, string>;
}

/** No database transaction spans a port call. Revision hashes stay host-owned. */
function readRebuildSnapshot(db: Database, vaultPath: string): RebuildSnapshot {
  boundCanon(vaultPath);
  return db.transaction(() => {
    const totals = db.query<{ n: number; bytes: number }, []>(
      "SELECT count(*) AS n,coalesce(sum(length(CAST(text AS BLOB))),0) AS bytes FROM events",
    ).get()!;
    const claimTotal = db.query<{ n: number; bytes: number }, []>(
      "SELECT count(*) AS n,coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM claims WHERE status='live'",
    ).get()!;
    if (totals.n + claimTotal.n > MAX_REBUILD_RECORDS || totals.bytes + claimTotal.bytes > MAX_SOURCE_BYTES) tooLarge();
    const ctx = { db, vaultPath, principal: OWNER, sourcePurpose: "derive" as const };
    const index = loadCanon(ctx);
    if (index.pages.length + totals.n + claimTotal.n > MAX_REBUILD_RECORDS) tooLarge();
    const docs: RetrievalDoc[] = [];
    const revisions = new Map<string, string>();
    const admit = (input: RetrievalDoc, revision: unknown): void => {
      const doc = validateRetrievalDoc(input);
      docs.push(doc);
      revisions.set(doc.doc_id, sha256Hex(JSON.stringify([doc, revision])));
    };
    for (const page of index.pages) {
      if (!isLiveCanonPage(page)) continue;
      const decision = pageDecision(index, OWNER.grant, page);
      if (!decision.allow) continue;
      admit({
        doc_id: `page:${page.id}`, kind: "page",
        title: typeof page.data["title"] === "string" ? page.data["title"] : page.id,
        text: page.body, sensitivity: decision.sensitivity, taint: decision.taint,
        authority: decision.evidence.revision.authority,
        subjects: [...new Set([
          ...stringArray(page.data["subjects"]),
          ...(typeof page.data["x-subject-id"] === "string" ? [page.data["x-subject-id"]] : []),
        ])],
        provenance: decision.evidence.sourceIds, occurred_at: null,
        updated_at: isRfc3339(decision.evidence.revision.at) ? decision.evidence.revision.at : null,
      }, { path: page.relPath, hash: page.contentHash, receipt: decision.evidence.revision });
    }
    for (const row of db.query<{ event_id: string; observed_at: string }, []>(
      "SELECT event_id,observed_at FROM events ORDER BY event_id",
    ).all()) {
      const source = currentQuotedSource(db, row.event_id);
      if (source === null) continue;
      const access = eventDecision(OWNER.grant, source, ctx);
      if (!access.allow) continue;
      admit({ doc_id: `event:${source.event_id}`, kind: "event", title: source.connector_id,
        text: source.text, sensitivity: access.sensitivity, taint: "quoted",
        authority: "connector_evidence", subjects: source.subjects, provenance: [source.event_id],
        occurred_at: source.occurred_at, updated_at: row.observed_at }, null);
    }
    const reader = claimReader(db, OWNER.grant, { owner: true, purpose: "derive" });
    for (const claim of listClaims(db, { status: "live", limit: MAX_REBUILD_RECORDS })) {
      if (reader.canRead(claim)) admit({ ...claimRetrievalDoc(claim), sensitivity: sourceSensitivity(db, claim.provenance, claim.sensitivity) }, claim);
    }
    return { epoch: sourcePolicyEpoch(db), docs: docs.sort((a, b) => a.doc_id.localeCompare(b.doc_id)), revisions };
  }).deferred();
}

/** A bounded owner-authorized snapshot; dates come only from authoritative records. */
export function readRetrievalDocuments(db: Database, vaultPath: string): RetrievalDoc[] {
  return readRebuildSnapshot(db, vaultPath).docs;
}

/** Atomic inside each derived store; the stores do not share a distributed transaction. */
async function rebuildUnderFence(scope: VaultMutationScope, db: Database, vaultPath: string, port: RetrievalPort | undefined, expired: () => boolean) {
  assertVaultMutationScope(scope, { db, vault_path: vaultPath });
  if (port !== undefined && sourcePolicyEpoch(db) > 0 && !isLocalSourcePort(port)) throw new PortError("unavailable", "source egress authorization unavailable", false);
  const snapshot = readRebuildSnapshot(db, vaultPath);
  const { docs } = snapshot;
  if (port !== undefined) {
    for (const doc of docs) requireSourceEvents(db, doc.provenance, { owner: true, purpose: "derive", port });
    if (port.rebuildFromDocuments === undefined) {
      throw new PortError("not_supported", "configured retrieval does not support atomic authoritative rebuild", false);
    }
    const store = port.descriptor.id;
    recordSourceStoreWrite(db, port, docs.flatMap(doc => doc.provenance));
    let failure: unknown;
    try { await port.rebuildFromDocuments(structuredClone(docs)); } catch (error) { failure = error; }
    // Keep final admission and the floor rebuild in one synchronous continuation.
    const remaining = new Map(snapshot.docs.map(doc => [doc.doc_id, doc]));
    let refused = false;
    let unreadable: unknown;
    do {
      let current: RebuildSnapshot | undefined;
      try { current = readRebuildSnapshot(db, vaultPath); }
      catch (error) { unreadable = error; }
      const discardAll = expired() || port.descriptor.id !== store || current === undefined;
      if (discardAll || snapshot.epoch !== current?.epoch) refused = true;
      const invalid = [...remaining.values()].filter(doc => discardAll ||
        current!.revisions.get(doc.doc_id) !== snapshot.revisions.get(doc.doc_id) ||
        !sourceEventsAllowed(db, doc.provenance, { owner: true, purpose: "derive", port }));
      if (invalid.length === 0) break;
      refused = true;
      const ids = invalid.slice(0, 100).map(doc => doc.doc_id);
      try {
        await port.remove(ids);
        const proof = validateAbsenceProof(await port.verifyAbsent(ids), ids);
        if (proof.found.length !== 0 || proof.store !== store || port.descriptor.id !== store) {
          throw new PortError("unavailable", "source rebuild cleanup could not establish absence", true);
        }
      } catch (error) {
        // recordSourceStoreWrite's durable pending obligation is deliberately retained.
        invalidateLocalSourcePort(port);
        throw new PortError("unavailable", "source rebuild cleanup could not establish absence", true, { cause: error });
      }
      for (const id of ids) remaining.delete(id);
    } while (remaining.size > 0);
    if (refused) throw new PortError("unavailable", "source authorization changed during rebuild; current evidence must be rebuilt", true,
      unreadable === undefined ? undefined : { cause: unreadable });
    if (failure !== undefined) throw failure;
  }
  const floor = rebuildDerived(db, vaultPath);
  const floorDocuments = floor.search.pages + floor.search.events;
  return {
    backend: port === undefined ? "sqlite-floor" as const : "retrieval-port" as const,
    documents: port === undefined ? floorDocuments : docs.length,
    floor_documents: floorDocuments,
    store: port?.descriptor.id ?? "kizuki.retrieval.fts5",
    generation: floor.generation,
  };
}

/** The bounded caller response may expire, but the writer fence remains until the late write and cleanup settle. */
export async function rebuildRetrieval(db: Database, vaultPath: string, port?: RetrievalPort) {
  vaultPath = resolve(vaultPath);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const configured = port?.descriptor?.method_timeouts_ms?.["rebuildFromDocuments"];
  const deadline = typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? Math.min(configured, 30_000) : 30_000;
  const operation = withVaultMutationAsync({ db, vault_path: vaultPath }, scope => rebuildUnderFence(scope, db, vaultPath, port, () => timedOut))
    .catch(error => {
      if (error instanceof VaultMutationError && error.code === "writer_busy") {
        throw new PortError("unavailable", "canon writer is busy; retry rebuild", true);
      }
      throw error;
    }).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (port !== undefined) invalidateLocalSourcePort(port);
      reject(new PortError("unavailable", "rebuild timed out; writer remains fenced until settlement", true));
    }, deadline);
  });
  return Promise.race([operation, timeout]);
}
