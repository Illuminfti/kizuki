import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER, initAgents } from "../src/agents";
import { CanonAuthorityResolver } from "../src/canon/authority";
import { resolveTarget } from "../src/canon/arbiter";
import { undoReceipt } from "../src/canon/undo";
import { rebuildDerived, refreshDerivedPage } from "../src/derived";
import { exportVault, restoreVault } from "../src/export";
import { openLedger } from "../src/ledger/db";
import { registerConnection } from "../src/ledger/connections";
import { accept, readEvent, readLiveEvent } from "../src/ledger/ledger";
import { createVaultFts5Port, isHeld, purgeEvents, runPurge } from "../src/ledger/purge";
import { setSourceGrant } from "../src/ledger/source-grants";
import { refreshPageEdges, removePageEdges } from "../src/graph/graph";
import { readDerivedMeta } from "../src/derived-meta";
import { readRetrievalDocuments } from "../src/retrieval/rebuild";
import { indexPage, projectSearchDocs } from "../src/search/indexer";
import { serveGetPage } from "../src/serving/page";
import { serveSearch } from "../src/serving/search";
import { listCanonPages } from "../src/vault/pages";
import { assessLivePageEvidence } from "../src/vault/provenance";
import { serializePage } from "../src/vault/frontmatter";
import { ulid } from "../src/util/ulid";
import { validEvent } from "./fixtures";
import { canonFixture, putEvent, storeClaim, write, type CanonFixture } from "./canon/helpers";

const fixtures: CanonFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
function fixture() {
  const f = canonFixture();
  fixtures.push(f);
  initAgents(f.db);
  return f;
}
async function recorded(f: CanonFixture, title = "Atlas", body = "Atlas observes [[Meridian]].") {
  const event = putEvent(f.db, { text: `Synthetic field record: ${body}` });
  const claim = await storeClaim(f.db, event, {
    target: `facts/${title.toLowerCase()}`, subject: `topic:${title.toLowerCase()}`,
    subjects: [], predicate: null, object: null, frontmatter: { type: "fact", title },
    body, producer: "model", model_ref: "fixture:synthetic",
  });
  const receipt = write(f.io, claim);
  const page = listCanonPages(f.vault).find(page => page.relPath === receipt.page_path)!;
  return { event, claim, receipt, page };
}
function rows(f: CanonFixture) {
  return {
    search: f.db.query("SELECT * FROM search_documents WHERE scope='canon' ORDER BY doc_id").all(),
    graph: f.db.query("SELECT * FROM graph_edges ORDER BY src,dst,kind").all(),
  };
}

test("recorded source and exact revision agree across incremental, rebuild and serving", async () => {
  const f = fixture();
  const { event, receipt, page } = await recorded(f);
  const evidence = assessLivePageEvidence(f.db, page);
  expect(evidence).toEqual({ admitted: true, sourceIds: [event], revision: {
    receipt_id: receipt.receipt_id, after_hash: receipt.after_hash, at: receipt.at, authority: "model_inference",
  } });
  const incremental = rows(f);
  expect(incremental.search).toHaveLength(1);
  expect(incremental.graph).toHaveLength(2);
  rebuildDerived(f.db, f.vault);
  expect(rows(f)).toEqual(incremental);
  const ctx = { db: f.db, vaultPath: f.vault, principal: OWNER };
  expect(serveGetPage(ctx, { path: page.relPath }).canon[0]?.page_id).toBe(page.id);
  expect((await serveSearch(ctx, { query: "Atlas" })).canon.map(chunk => chunk.page_id)).toEqual([page.id]);
  expect(readRetrievalDocuments(f.db, f.vault).find(doc => doc.doc_id === `page:${page.id}`))
    .toMatchObject({ authority: "model_inference", provenance: [event], updated_at: receipt.at });
});

test("an ordinary owner edit preserves bytes and target identity while withdrawing positive projections", async () => {
  const f = fixture();
  const { claim, page } = await recorded(f);
  const path = join(f.vault, page.relPath);
  const bytes = readFileSync(path, "utf8") + "\nAn unrecorded owner note.\n";
  writeFileSync(path, bytes);
  const edited = listCanonPages(f.vault)[0]!;
  expect(assessLivePageEvidence(f.db, edited)).toEqual({ admitted: false, reason: "revision_unrecorded" });
  expect(new CanonAuthorityResolver(f.db, [edited.relPath]).resolve(edited.relPath, edited.contentHash)).toBe("owner_authored");
  const ctx = { db: f.db, vaultPath: f.vault, principal: OWNER };
  // The FTS hit still exists at this point; serving must re-read the page.
  expect((await serveSearch(ctx, { query: "Atlas" })).canon).toEqual([]);
  expect(serveGetPage(ctx, { path: edited.relPath }).canon).toEqual([]);
  expect(readRetrievalDocuments(f.db, f.vault).some(doc => doc.doc_id === `page:${page.id}`)).toBe(false);
  refreshDerivedPage(f.db, edited, f.vault);
  expect(rows(f)).toEqual({ search: [], graph: [] });
  expect(readFileSync(path, "utf8")).toBe(bytes);
  expect(f.db.query("SELECT page_id FROM page_index WHERE rel_path=?").get(page.relPath)).toEqual({ page_id: page.id });
  const next = await storeClaim(f.db, putEvent(f.db), {
    kind: "edit" as const, target: claim.target, subject: claim.subject, predicate: null, object: null,
    body: "Another synthetic update.", frontmatter: {}, producer: "model" as const, model_ref: "fixture:synthetic",
  });
  expect(resolveTarget(f.io, next)).toEqual({ action: "skip", reason: "owner_edited_body" });
  rebuildDerived(f.db, f.vault);
  expect(rows(f)).toEqual({ search: [], graph: [] });
});

test("incomplete graph refresh removes incoming aliases and outgoing edges of an unrecorded page", async () => {
  const f = fixture();
  const target = await recorded(f, "Meridian", "Meridian has a marker.");
  const origin = await recorded(f);
  rebuildDerived(f.db, f.vault);
  expect(f.db.query("SELECT dst FROM graph_edges WHERE src=? AND kind='wikilink'").get(origin.page.id))
    .toEqual({ dst: target.page.id });
  writeFileSync(target.page.path, readFileSync(target.page.path, "utf8") + "\nUnrecorded owner annotation.\n");
  const pages = listCanonPages(f.vault);
  const edited = pages.find(page => page.id === target.page.id)!;
  refreshPageEdges(f.db, edited, pages, 1);
  expect(f.db.query("SELECT 1 FROM graph_edges WHERE src=? OR dst=? OR lower(dst)='meridian'")
    .all(target.page.id, target.page.id)).toEqual([]);
  expect(f.db.query("SELECT 1 FROM graph_edges WHERE src=? AND kind='source'").all(origin.page.id)).toHaveLength(1);
});

test("missing, empty and unresolved source declarations remain owner files with no positive admission", async () => {
  const f = fixture();
  const { page } = await recorded(f);
  for (const sources of [undefined, [], ["ordinary-unresolved-source"]]) {
    const data = { ...page.data };
    if (sources === undefined) delete data["sources"];
    else data["sources"] = sources;
    writeFileSync(page.path, serializePage({ data, body: page.body }));
    const changed = listCanonPages(f.vault)[0]!;
    expect(assessLivePageEvidence(f.db, changed)).toEqual({ admitted: false, reason: "sources_unavailable" });
    indexPage(f.db, changed);
    expect(rows(f).search).toEqual([]);
  }
});

test("valid undo and undo of undo carry a recorded revision basis", async () => {
  const f = fixture();
  const { event, receipt, page } = await recorded(f);
  const edit = write(f.io, await storeClaim(f.db, event, {
    kind: "edit", target: page.id, predicate: null, object: null, frontmatter: {},
    body: "Atlas observes the second marker.", producer: "model", model_ref: "fixture:synthetic",
  }));
  const revert = await undoReceipt(f.io, edit.receipt_id);
  const restored = listCanonPages(f.vault)[0]!;
  expect(restored.contentHash).toBe(receipt.after_hash);
  expect(assessLivePageEvidence(f.db, restored)).toMatchObject({ admitted: true,
    revision: { receipt_id: revert.receipt_id, authority: "model_inference" } });
  await undoReceipt(f.io, revert.receipt_id);
  expect(assessLivePageEvidence(f.db, listCanonPages(f.vault)[0]!)).toMatchObject({ admitted: true });
  rebuildDerived(f.db, f.vault);
  expect(rows(f).search).toHaveLength(1);
  expect(readRetrievalDocuments(f.db, f.vault).some(doc => doc.kind === "page")).toBe(true);
});

test("FTS recovery requires current canon bytes and can restore a recorded snapshot", async () => {
  const f = fixture();
  const { page } = await recorded(f);
  projectSearchDocs(f.db);
  expect(rows(f).search).toEqual([]);
  projectSearchDocs(f.db, [page]);
  expect(rows(f).search).toHaveLength(1);
});

test("a clean portable restore preserves recorded basis and rechecks ordinary owner edits", async () => {
  const f = fixture();
  const { receipt, page } = await recorded(f);
  const folder = mkdtempSync(join(tmpdir(), "kizuki-positive-restore-"));
  try {
    exportVault(f.db, f.vault, join(folder, "backup"));
    const vault = join(folder, "restored");
    restoreVault(join(folder, "backup"), vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    try {
      const restored = listCanonPages(vault)[0]!;
      expect(assessLivePageEvidence(db, restored)).toMatchObject({ admitted: true,
        revision: { receipt_id: receipt.receipt_id, after_hash: receipt.after_hash } });
      rebuildDerived(db, vault);
      expect(serveGetPage({ db, vaultPath: vault, principal: OWNER }, { path: page.relPath }).canon).toHaveLength(1);
      writeFileSync(restored.path, readFileSync(restored.path, "utf8") + "\nRestored owner annotation.\n");
      rebuildDerived(db, vault);
      expect(db.query("SELECT doc_id FROM search_documents WHERE scope='canon'").all()).toEqual([]);
    } finally { db.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("completed purge preserves an unrecorded residual without admitting its redaction receipt", async () => {
  const f = fixture();
  const { event, page } = await recorded(f);
  writeFileSync(page.path, readFileSync(page.path, "utf8") + "\nAn independent unrecorded owner annotation.\n");
  const outcome = await runPurge(f.db, f.vault, { event_id: event }, "retire synthetic capture");
  expect(outcome.rewritten).toHaveLength(1);
  const residual = listCanonPages(f.vault)[0]!;
  expect(residual.body).toContain("unrecorded owner annotation");
  expect(residual.data["sources"]).toEqual([]);
  expect(assessLivePageEvidence(f.db, residual)).toEqual({ admitted: false, reason: "sources_unavailable" });
  expect(new CanonAuthorityResolver(f.db, [residual.relPath]).basis(residual.relPath, residual.contentHash)).toBeNull();
  expect(rows(f)).toEqual({ search: [], graph: [] });
  rebuildDerived(f.db, f.vault);
  expect(rows(f)).toEqual({ search: [], graph: [] });
  expect(readRetrievalDocuments(f.db, f.vault).some(doc => doc.kind === "page")).toBe(false);
});

test("recorded evidence does not override current recall or derivation permissions", async () => {
  const f = fixture();
  const sourceKey = ulid();
  registerConnection(f.db, "fixture", sourceKey);
  const policy = {
    purposes: ["capture", "recall", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
  };
  setSourceGrant(f.db, { source_key: sourceKey, expected_revision: 0, operation_id: "positive-initial", policy });
  const capture = accept(f.db, { ...validEvent(), connector_id: "fixture", text: "Atlas observes a marker." },
    { source: { source_key: sourceKey, expected_revision: 1 } });
  if (capture.status !== "stored") throw new Error("synthetic source capture was not stored");
  const receipt = write(f.io, await storeClaim(f.db, capture.event.event_id, {
    target: "facts/atlas", body: "Atlas observes a marker.", frontmatter: { type: "fact", title: "Atlas" },
    producer: "model", model_ref: "fixture:synthetic",
  }));
  const page = listCanonPages(f.vault)[0]!;
  const ctx = { db: f.db, vaultPath: f.vault, principal: OWNER };
  expect(serveGetPage(ctx, { path: receipt.page_path }).canon).toHaveLength(1);
  setSourceGrant(f.db, { source_key: sourceKey, expected_revision: 1, operation_id: "positive-no-recall",
    policy: { ...policy, purposes: ["capture", "derive"] } });
  expect(assessLivePageEvidence(f.db, page).admitted).toBe(true);
  expect((await serveSearch(ctx, { query: "Atlas" })).canon).toEqual([]);
  rebuildDerived(f.db, f.vault);
  expect(rows(f).search).toHaveLength(1);
  setSourceGrant(f.db, { source_key: sourceKey, expected_revision: 2, operation_id: "positive-no-derive",
    policy: { ...policy, purposes: ["capture", "recall"] } });
  refreshDerivedPage(f.db, page, f.vault);
  expect(rows(f)).toEqual({ search: [], graph: [] });
  rebuildDerived(f.db, f.vault);
  expect(rows(f)).toEqual({ search: [], graph: [] });
  expect(readRetrievalDocuments(f.db, f.vault).some(doc => doc.kind === "page")).toBe(false);
});

test("purge retains a separately recorded surviving claim with equal incremental and full projections", async () => {
  const f = fixture();
  const first = await recorded(f, "Atlas", "Atlas has an earlier marker.");
  const retained = putEvent(f.db, { text: "Atlas has a retained marker and observes Meridian." });
  const second = write(f.io, await storeClaim(f.db, retained, {
    target: "facts/atlas", subject: "topic:atlas", subjects: [], predicate: null, object: null,
    frontmatter: { type: "fact", title: "Atlas" }, body: "Atlas retains a marker near [[Meridian]].",
    producer: "model", model_ref: "fixture:synthetic",
  }));
  const outcome = await runPurge(f.db, f.vault, { event_id: first.event }, "retire earlier synthetic capture");
  expect(outcome.rewritten).toHaveLength(1);
  const surviving = listCanonPages(f.vault)[0]!;
  expect(surviving.id).toBe(first.page.id);
  expect(surviving.body).toContain("retains a marker");
  expect(surviving.body).not.toContain("earlier marker");
  expect(surviving.data["sources"]).toEqual([retained]);
  const evidence = assessLivePageEvidence(f.db, surviving);
  expect(evidence).toMatchObject({ admitted: true, sourceIds: [retained],
    revision: { receipt_id: outcome.rewritten[0]!.receipt_id, authority: "model_inference" } });
  expect(surviving.contentHash).not.toBe(second.after_hash);
  const incremental = rows(f);
  expect(incremental.search).toHaveLength(1);
  expect(incremental.graph).toHaveLength(2);
  rebuildDerived(f.db, f.vault);
  expect(rows(f)).toEqual(incremental);
  expect(serveGetPage({ db: f.db, vaultPath: f.vault, principal: OWNER }, { path: first.receipt.page_path }).canon)
    .toHaveLength(1);
});

test("a later source tombstone withdraws canon even while the original event row remains", async () => {
  const f = fixture();
  const { event, page } = await recorded(f);
  const original = readEvent(f.db, event)!;
  expect(readLiveEvent(f.db, event)?.event_id).toBe(event);
  const tombstone = accept(f.db, {
    ...validEvent(), connector_id: original.connector_id, source_record_id: original.source_record_id,
    text: "", deleted: true,
  });
  expect(tombstone.status).toBe("stored");
  expect(readEvent(f.db, event)?.deleted).toBe(false);
  expect(readLiveEvent(f.db, event)).toBeNull();
  expect(assessLivePageEvidence(f.db, page)).toEqual({ admitted: false, reason: "sources_unavailable" });
  expect((await serveSearch({ db: f.db, vaultPath: f.vault, principal: OWNER }, { query: "Atlas" })).canon).toEqual([]);
  refreshDerivedPage(f.db, page, f.vault);
  expect(rows(f)).toEqual({ search: [], graph: [] });
  rebuildDerived(f.db, f.vault);
  expect(rows(f)).toEqual({ search: [], graph: [] });
  expect(readRetrievalDocuments(f.db, f.vault).some(doc => doc.kind === "page")).toBe(false);
});

test("graph metadata counts each held or unrecorded page once across full and incomplete maintenance", async () => {
  const f = fixture();
  const held = await recorded(f, "Held", "Held observes a marker.");
  const unrecorded = await recorded(f, "Unrecorded", "Unrecorded observes a marker.");
  const live = await recorded(f, "Live", "Live observes [[Held]], [[Unrecorded]], and [[Elsewhere]].");
  writeFileSync(join(f.vault, unrecorded.page.relPath),
    readFileSync(join(f.vault, unrecorded.page.relPath), "utf8") + "\nAn ordinary owner note.\n");
  rebuildDerived(f.db, f.vault);
  const port = createVaultFts5Port(f.vault);
  try {
    purgeEvents(f.db, f.vault, { event_id: held.event }, "retire held synthetic evidence", {
      retrieval_store: port.descriptor.id,
    });
    expect(isHeld(f.db, held.page.relPath)).toBe(true);
    const pages = listCanonPages(f.vault);
    const metadata = () => {
      const meta = readDerivedMeta(f.db, "graph")!;
      return { doc_count: meta.doc_count, source_count: meta.source_count,
        skipped_count: meta.skipped_count, status: meta.status,
        canon_hash: meta.canon_hash, ledger_watermark: meta.ledger_watermark };
    };
    refreshDerivedPage(f.db, live.page, f.vault);
    const incremental = metadata();
    expect(incremental).toMatchObject({ doc_count: 2, source_count: 1,
      skipped_count: 2, status: "degraded", canon_hash: null });
    rebuildDerived(f.db, f.vault);
    expect(metadata()).toEqual(incremental);

    for (const snapshot of [pages, pages.filter(page => page.id !== held.page.id)]) {
      for (const maintain of [
        () => refreshPageEdges(f.db, live.page, snapshot, 1),
        () => removePageEdges(f.db, held.page.id, snapshot, 1),
      ]) {
        maintain();
        expect(metadata()).toMatchObject({ skipped_count: 3, status: "degraded", canon_hash: null });
        maintain();
        expect(metadata().skipped_count).toBe(3);
      }
    }
    refreshDerivedPage(f.db, live.page, f.vault);
    expect(metadata()).toEqual(incremental);
  } finally {
    await port.close();
  }
});
