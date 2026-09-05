import { sourcePolicyEpoch, isLocalSourcePort, sourceSensitivity, requireSourceEvents } from "../ledger/source-grants";
import type { Database } from "bun:sqlite";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OWNER, sensitivity } from "../agents";
import { claimRetrievalDoc, listClaims } from "../claims/store";
import { PortError } from "../contracts/ports";
import { validateRetrievalDoc } from "../contracts/retrieval";
import type { RetrievalDoc, RetrievalPort } from "../contracts/retrieval";
import { rebuildDerived } from "../derived";
import { loadCanon, pageDecision } from "../serving/canon";
import { claimReader } from "../serving/claims";
import { currentQuotedSource, eventDecision } from "../serving/ledger";
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

/** A bounded owner-authorized snapshot; dates come only from authoritative records. */
export function readRetrievalDocuments(db: Database, vaultPath: string): RetrievalDoc[] {
  boundCanon(vaultPath);
  return db.transaction(() => {
    const totals = db.query<{ n: number; bytes: number }, []>(
      "SELECT count(*) AS n,coalesce(sum(length(CAST(text AS BLOB))),0) AS bytes FROM events",
    ).get()!;
    const claimTotal = db.query<{ n: number; bytes: number }, []>(
      "SELECT count(*) AS n,coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM claims WHERE status='live'",
    ).get()!;
    if (totals.n + claimTotal.n > MAX_REBUILD_RECORDS || totals.bytes + claimTotal.bytes > MAX_SOURCE_BYTES) tooLarge();
    const index = loadCanon({ db, vaultPath, principal: OWNER });
    if (index.pages.length + totals.n + claimTotal.n > MAX_REBUILD_RECORDS) tooLarge();
    const docs: RetrievalDoc[] = [];
    for (const page of index.pages) {
      if (!isLiveCanonPage(page)) continue;
      const decision = pageDecision(index, OWNER.grant, page);
      if (!decision.allow) continue;
      const receipt = db.query<{ at: string }, [string, string]>(
        "SELECT at FROM canon_receipts WHERE page_path=? AND after_hash=? ORDER BY at DESC,receipt_id DESC LIMIT 1",
      ).get(page.relPath, page.contentHash);
      docs.push({
        doc_id: `page:${page.id}`, kind: "page",
        title: typeof page.data["title"] === "string" ? page.data["title"] : page.id,
        text: page.body, sensitivity: decision.sensitivity, taint: decision.taint,
        authority: index.authority.get(page.relPath) ?? "model_inference",
        subjects: [...new Set([
          ...stringArray(page.data["subjects"]),
          ...(typeof page.data["x-subject-id"] === "string" ? [page.data["x-subject-id"]] : []),
        ])],
        provenance: stringArray(page.data["sources"]), occurred_at: null,
        updated_at: receipt !== null && isRfc3339(receipt.at) ? receipt.at : null,
      });
    }
    for (const row of db.query<{ event_id: string; observed_at: string }, []>(
      "SELECT event_id,observed_at FROM events ORDER BY event_id",
    ).all()) {
      const source = currentQuotedSource(db, row.event_id);
      if (source === null) continue;
      const access = eventDecision(OWNER.grant, source, { db, vaultPath, principal: OWNER });
      if (!access.allow) continue;
      docs.push({ doc_id: `event:${source.event_id}`, kind: "event", title: source.connector_id,
        text: source.text, sensitivity: access.sensitivity, taint: "quoted",
        authority: "connector_evidence", subjects: source.subjects, provenance: [source.event_id],
        occurred_at: source.occurred_at, updated_at: row.observed_at });
    }
    const reader = claimReader(db, OWNER.grant);
    for (const claim of listClaims(db, { status: "live", limit: MAX_REBUILD_RECORDS })) {
      if (reader.canRead(claim)) docs.push({ ...claimRetrievalDoc(claim), sensitivity: sourceSensitivity(db, claim.provenance, claim.sensitivity) });
    }
    return docs.map(validateRetrievalDoc).sort((a, b) => a.doc_id.localeCompare(b.doc_id));
  }).deferred();
}

/** Atomic inside each derived store; the stores do not share a distributed transaction. */
export async function rebuildRetrieval(db: Database, vaultPath: string, port?: RetrievalPort) {
  if (port !== undefined && sourcePolicyEpoch(db) > 0 && !isLocalSourcePort(port)) throw new PortError("unavailable", "source egress authorization unavailable", false);
  const docs = readRetrievalDocuments(db, vaultPath);
  if (port !== undefined) {
    for (const doc of docs) requireSourceEvents(db, doc.provenance, { owner: true, purpose: "derive", port });
    if (port.rebuildFromDocuments === undefined) {
      throw new PortError("not_supported", "configured retrieval does not support atomic authoritative rebuild", false);
    }
    await port.rebuildFromDocuments(docs);
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
