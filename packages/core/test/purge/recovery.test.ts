import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER, initAgents } from "../../src/agents";
import { loadCanon, pageDecision, canonChunk } from "../../src/serving/canon";
import { serveGetPage } from "../../src/serving/page";
import { serveSearch } from "../../src/serving/search";
import { serveEntities } from "../../src/serving/entities";
import { serveGraph } from "../../src/serving/graph";
import { serveHealth } from "../../src/serving/health";
import { serveContextPacket } from "../../src/serving/packet";
import { gateAsync } from "../../src/serving/gate";
import { ServeError } from "../../src/serving/types";
import { runRail } from "../../src/serve/rails";
import { insertClaim } from "../../src/claims/store";
import { PROVENANCE_ERASURE_CAPABILITY, type RetrievalDoc, type RetrievalPort } from "../../src/contracts/retrieval";
import { rebuildDerived, refreshDerivedPage } from "../../src/derived";
import { rebuildGraph, refreshPageEdges, replacePageEdges, removePageEdges } from "../../src/graph/graph";
import { indexPage, rebuildSearch, projectSearchDocs } from "../../src/search/indexer";
import { listCanonPagesReport } from "../../src/vault/pages";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { sourcePolicyEpoch } from "../../src/ledger/source-grants";
import { createVaultFts5Port, inspectPurgeHealth, isHeld, purgeEvents, resumePurge, runPurge, setAfterCanonSnapshot, setPurgeRecoveryHook, verifyPurge } from "../../src/ledger/purge";
import { search } from "../../src/search/query";
import { DIRECT_RETRIEVAL_DESCRIPTOR, ReferenceRetrievalPort } from "../contracts/reference-retrieval";
import { temporaryPortContext } from "../contracts/fixtures";
import { validEvent } from "../fixtures";
import { tempVault, writeCanon } from "../helpers/vault";

const AT = "2026-09-06T15:00:00.000Z";
const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  setAfterCanonSnapshot(); setPurgeRecoveryHook();
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function fixture() {
  const disk = tempVault("kizuki-purge-recovery-");
  const path = join(disk.path, ".kizuki", "kizuki.db");
  let db = openLedger(path);
  initAgents(db);
  disposers.push(disk.dispose, () => db.close());
  const event = (name: string, connector: string) => {
    const result = accept(db, { ...validEvent(), connector_id: connector, source_record_id: name, text: name });
    if (result.status !== "stored") throw new Error("ordinary fixture event was not stored");
    return result.event;
  };
  const erased = event("Retired Atlas note", "fixture");
  const second = event("Retired Beacon note", "fixture");
  const kept = event("Current Atlas note", "fixture-kept");
  const body = "Retiredword Atlas fixture.";
  await insertClaim({ db, now: () => AT }, {
    kind: "claim", target: "facts/atlas", body, provenance: [erased.event_id],
    producer: "deterministic", confidence: 0.8, sensitivity: "personal", taint: "quoted",
  });
  const page = (id: string) => writeCanon(disk.path, `facts/${id}.md`, {
    id, title: id, type: "fact", status: "active", sensitivity: "personal", taint: "quoted",
    sources: [`event:${erased.event_id}`, kept.event_id],
  }, `${body}\nCurrent Atlas notes.\n`);
  page("atlas");
  rebuildDerived(db, disk.path);
  const port = createVaultFts5Port(disk.path, () => AT);
  disposers.push(() => port.close());
  return {
    get db() { return db; }, vaultPath: disk.path, path, erased, second, kept, body, page, port,
    reopen() { db.close(); db = openLedger(path); },
  };
}

function operation(db: ReturnType<typeof openLedger>) {
  return db.query<{ receipt_id: string; ids: string; state: string; proof: string | null }, []>(
    "SELECT receipt_id,ids,state,proof FROM purge_ops ORDER BY created_at,op_id LIMIT 1",
  ).get()!;
}

function exportTarget() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-purge-backup-"));
  disposers.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, backup: join(root, "backup"), restored: join(root, "restored") };
}

describe("durable purge discovery", () => {
  for (const cut of ["phase-one-committed", "discovery-held"] as const) {
    test(`reopen after ${cut} rediscovers the whole batch before proving or rewriting`, async () => {
      const f = await fixture();
      const target = exportTarget();
      setAfterCanonSnapshot(() => f.page("late-atlas"));
      setPurgeRecoveryHook(stage => { if (stage === cut) throw new Error("ordinary recovery fixture interruption"); });
      expect(() => purgeEvents(f.db, f.vaultPath, { connector_id: "fixture" }, "retire fixture", {
        retrieval_store: f.port.descriptor.id, now: () => AT,
      })).toThrow("ordinary recovery fixture interruption");
      setAfterCanonSnapshot(); setPurgeRecoveryHook();
      const op = operation(f.db);
      expect(f.db.query("SELECT state FROM purge_batches").all()).toEqual([{ state: "discovering" }]);
      expect(f.db.query("SELECT 1 FROM events WHERE connector_id='fixture'").all()).toEqual([]);
      expect(f.db.query("SELECT 1 FROM purge_batch_receipts").all()).toHaveLength(2);
      // Discovery's hold insert and operation extension share one transaction.
      expect(isHeld(f.db, "facts/late-atlas.md")).toBe(false);
      expect(JSON.parse(op.ids)).not.toContain("page:late-atlas");
      expect((await verifyPurge(f.db, f.vaultPath, op.receipt_id, { retrieval: f.port })).ok).toBe(false);
      let progress = 0;
      expect(() => exportVault(f.db, f.vaultPath, target.backup, { onProgress: () => { progress += 1; } })).toThrow("purge_recovery_pending");
      expect(progress).toBe(0);
      expect(existsSync(target.backup)).toBe(false);
      f.reopen();
      expect(() => serveGetPage({ db: f.db, vaultPath: f.vaultPath, principal: OWNER }, { id: "late-atlas" })).toThrow("canon unavailable during purge recovery");
      const pages = listCanonPagesReport(f.vaultPath).pages;
      const late = pages.find(page => page.id === "late-atlas")!;
      for (const rebuild of [
        () => rebuildDerived(f.db, f.vaultPath), () => rebuildSearch(f.db, f.vaultPath), () => rebuildGraph(f.db, f.vaultPath),
        () => indexPage(f.db, late), () => refreshDerivedPage(f.db, late, f.vaultPath), () => projectSearchDocs(f.db),
        () => refreshPageEdges(f.db, late, pages, 1), () => replacePageEdges(f.db, pages), () => removePageEdges(f.db, late.id, pages, 1),
      ]) expect(rebuild).toThrow("purge_discovery_pending");
      expect(inspectPurgeHealth(f.db, "2026-09-06T17:00:00.000Z").failures.some(failure => failure.kind === "batch_discovery_stale")).toBe(true);
      const aliases = f.db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM purge_batch_receipts ORDER BY receipt_id").all();
      const result = await resumePurge(f.db, f.vaultPath, aliases[1]!.receipt_id, { retrieval: f.port, now: () => AT });
      expect(result.ok).toBe(true);
      expect(result.pages_rewritten).toBe(2);
      const served = serveGetPage({ db: f.db, vaultPath: f.vaultPath, principal: OWNER }, { id: "late-atlas" });
      expect(served.canon[0]?.excerpt).toContain("Current Atlas notes.");
      expect(served.canon[0]?.excerpt).not.toContain(f.body);
      expect(JSON.parse(operation(f.db).ids)).toContain("page:late-atlas");
      expect(isHeld(f.db, "facts/late-atlas.md")).toBe(false);
      for (const id of ["atlas", "late-atlas"]) {
        const text = readFileSync(join(f.vaultPath, `facts/${id}.md`), "utf8");
        expect(text).not.toContain(f.body);
        expect(text).not.toContain(f.erased.event_id);
        expect(text).toContain(f.kept.event_id);
      }
      const after = readFileSync(join(f.vaultPath, "facts/atlas.md"), "utf8");
      expect((await resumePurge(f.db, f.vaultPath, aliases[0]!.receipt_id, { retrieval: f.port, now: () => AT })).ok).toBe(true);
      expect(readFileSync(join(f.vaultPath, "facts/atlas.md"), "utf8")).toBe(after);
      rebuildDerived(f.db, f.vaultPath);
      expect(search(f.db, "Retiredword", { ceiling: "private" })).toEqual([]);
      expect(exportVault(f.db, f.vaultPath, target.backup).schema).toBe("kizuki.backup/v3");
      restoreVault(target.backup, target.restored);
      const restored = openLedger(join(target.restored, ".kizuki", "kizuki.db"));
      try {
        rebuildDerived(restored, target.restored);
        expect(search(restored, "Retiredword", { ceiling: "private" })).toEqual([]);
      } finally { restored.close(); }
    });
  }

  test("every event receipt resolves to the same pending and completed store proof", async () => {
    const f = await fixture();
    const verify = f.port.verifyProvenanceAbsent!.bind(f.port);
    f.port.verifyProvenanceAbsent = async ids => ({ ...await verify(ids), checked: 0 });
    const outcome = await runPurge(f.db, f.vaultPath, { connector_id: "fixture" }, "retire fixture", { retrieval: f.port, now: () => AT });
    expect(outcome.receipts).toHaveLength(2);
    for (const receipt of outcome.receipts) {
      expect((await verifyPurge(f.db, f.vaultPath, receipt.receipt_id, { retrieval: f.port, now: () => AT })).ok).toBe(false);
    }
    expect(operation(f.db)).toMatchObject({ state: "pending", proof: null });
    expect(isHeld(f.db, "facts/atlas.md")).toBe(true);
    f.port.verifyProvenanceAbsent = verify;
    expect((await resumePurge(f.db, f.vaultPath, outcome.receipts[1]!.receipt_id, { retrieval: f.port, now: () => AT })).ok).toBe(true);
    const first = verifyPurge(f.db, f.vaultPath, outcome.receipts[0]!.receipt_id, { retrieval: f.port, now: () => AT });
    const contended = verifyPurge(f.db, f.vaultPath, outcome.receipts[1]!.receipt_id, { retrieval: f.port, now: () => AT })
      .then(() => null, error => error);
    expect(await contended).toMatchObject({ code: "canon_changed" });
    const reports = [await first, await verifyPurge(f.db, f.vaultPath, outcome.receipts[1]!.receipt_id, { retrieval: f.port, now: () => AT })];
    expect(reports.every(report => report.ok)).toBe(true);
    expect(reports[0]!.proofs).toEqual(reports[1]!.proofs);
    expect(JSON.parse(operation(f.db).proof!)).toMatchObject({ schema: "kizuki.purge-proof/v1", provenance: { scope: "event-provenance/v1", checked: 2, found: [] } });
  });

  test("a completed discovery is repeated when a later page expands the closure", async () => {
    const f = await fixture();
    const outcome = await runPurge(f.db, f.vaultPath, { event_id: f.erased.event_id }, "retire fixture", { retrieval: f.port, now: () => AT });
    f.page("late-atlas");
    const exact = f.port.verifyAbsent.bind(f.port);
    f.port.verifyAbsent = async ids => ({ ...await exact(ids), checked: 0 });
    expect((await resumePurge(f.db, f.vaultPath, outcome.receipts[0]!.receipt_id, { retrieval: f.port, now: () => AT })).ok).toBe(false);
    expect(isHeld(f.db, "facts/late-atlas.md")).toBe(true);
    expect(JSON.parse(operation(f.db).ids)).toContain("page:late-atlas");
    expect(operation(f.db)).toMatchObject({ state: "pending", proof: null });
    f.port.verifyAbsent = exact;
    expect((await resumePurge(f.db, f.vaultPath, outcome.receipts[0]!.receipt_id, { retrieval: f.port, now: () => AT })).ok).toBe(true);
  });

  test("export retains its writer while a progress callback receives bounded purge contention", async () => {
    const f = await fixture();
    const target = exportTarget();
    let cut = false;
    const before = f.db.query("SELECT * FROM event_purges").all();
    const manifest = exportVault(f.db, f.vaultPath, target.backup, {
      onProgress: label => {
        if (label !== "ledger" || cut) return;
        cut = true;
        try {
          purgeEvents(f.db, f.vaultPath, { event_id: f.erased.event_id }, "retire fixture", { retrieval_store: f.port.descriptor.id, now: () => AT });
          throw new Error("nested public purge unexpectedly acquired the exporter writer");
        } catch (error) { expect(error).toMatchObject({ code: "canon_changed" }); }
      },
    });
    expect(cut).toBe(true);
    expect(manifest.complete).toBe(true);
    expect(f.db.query("SELECT * FROM event_purges").all()).toEqual(before);
    expect(existsSync(target.backup)).toBe(true);
  });
});

for (const advertised of [false, true]) {
  test(`an exact-ID port with ${advertised ? "an incomplete advertised" : "no"} provenance extension keeps canon held`, async () => {
    const f = await fixture();
    const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
    disposers.push(temporary.cleanup);
    const reference = new ReferenceRetrievalPort(temporary.ctx);
    disposers.push(() => reference.close());
    const descriptor = { ...reference.descriptor, supports: advertised ? ["lexical", PROVENANCE_ERASURE_CAPABILITY] : ["lexical"] };
    const port: RetrievalPort = {
      descriptor, upsert: docs => reference.upsert(docs), search: query => reference.search(query),
      remove: ids => reference.remove(ids), verifyAbsent: ids => reference.verifyAbsent(ids),
      neighbors: () => reference.neighbors(), health: () => reference.health(), close: () => reference.close(),
    };
    const doc: RetrievalDoc = {
      doc_id: "page:external-copy", kind: "page", title: "Atlas", text: "Ordinary Atlas fixture", sensitivity: "personal", taint: "quoted",
      authority: "connector_evidence", subjects: [], provenance: [f.erased.event_id], occurred_at: AT, updated_at: AT,
    };
    await port.upsert([doc]);
    expect((await port.verifyAbsent([`event:${f.erased.event_id}`])).found).toEqual([]);
    const outcome = await runPurge(f.db, f.vaultPath, { event_id: f.erased.event_id }, "retire fixture", { retrieval: port, now: () => AT });
    expect(outcome.purge_ops[0]?.state).toBe("pending");
    expect(outcome.rewritten).toEqual([]);
    expect(isHeld(f.db, "facts/atlas.md")).toBe(true);
    expect((await port.verifyAbsent([doc.doc_id])).found).toEqual([doc.doc_id]);
  });
}

test("canon admission withholds direct readers and cached snapshots until fresh ready-batch bytes are loaded", async () => {
  const f = await fixture();
  expect(sourcePolicyEpoch(f.db)).toBe(0);
  const ctx = { db: f.db, vaultPath: f.vaultPath, principal: OWNER };
  let cached: ReturnType<typeof loadCanon> | undefined;
  setAfterCanonSnapshot(() => { f.page("late-atlas"); cached = loadCanon(ctx); });
  setPurgeRecoveryHook(stage => { if (stage === "phase-one-committed") throw new Error("ordinary recovery fixture interruption"); });
  expect(() => purgeEvents(f.db, f.vaultPath, { event_id: f.erased.event_id }, "retire ordinary fixture", {
    retrieval_store: f.port.descriptor.id, now: () => AT,
  })).toThrow("ordinary recovery fixture interruption");
  setAfterCanonSnapshot(); setPurgeRecoveryHook();
  if (cached === undefined) throw new Error("fixture canon snapshot was not loaded");
  const late = cached.byId.get("late-atlas")!;
  expect(isHeld(f.db, late.relPath)).toBe(false);
  for (const read of [
    () => serveGetPage(ctx, { id: "late-atlas" }), () => serveEntities(ctx, {}),
    () => serveGraph(ctx, { id: "late-atlas" }), () => serveHealth(ctx),
    () => canonChunk(cached!, late, { sensitivity: "personal", taint: "quoted" }, late.body, false),
  ]) {
    try { read(); throw new Error("fixture read should be refused"); }
    catch (error) {
      expect(error).toBeInstanceOf(ServeError);
      expect(error).toMatchObject({ code: "held", message: "canon unavailable during purge recovery" });
    }
  }
  expect(pageDecision(cached, OWNER.grant, late)).toEqual({ allow: false, reason: "held" });
  await expect(serveSearch(ctx, { query: "Atlas", scope: "canon" })).rejects.toMatchObject({ code: "held" });
  const packet = await serveContextPacket(ctx, { query: "Atlas", include: ["canon"], budget_tokens: 1000 });
  expect(packet.canon).toEqual([]);
  expect(packet.data?.packet_md).not.toContain(f.body);
  expect(packet.data?.retrieval_degraded).toContain("context-unavailable");
  const complete = await resumePurge(f.db, f.vaultPath, operation(f.db).receipt_id, { retrieval: f.port, now: () => AT });
  expect(complete.ok).toBe(true);
  // The earlier snapshot still contains retired support after the hold lifts.
  expect(pageDecision(cached, OWNER.grant, late)).toEqual({ allow: false, reason: "held" });
  expect(() => canonChunk(cached!, late, { sensitivity: "personal", taint: "quoted" }, late.body, false)).toThrow("canon unavailable during purge recovery");
  const current = serveGetPage(ctx, { id: "late-atlas" });
  expect(current.canon[0]?.excerpt).toContain("Current Atlas notes.");
  expect(current.canon[0]?.excerpt).not.toContain(f.body);
});

test("unresolved legacy discovery refuses canon before walking the vault", async () => {
  const f = await fixture();
  const outcome = purgeEvents(f.db, f.vaultPath, { event_id: f.erased.event_id }, "retire ordinary fixture", { retrieval_store: f.port.descriptor.id, now: () => AT });
  f.db.query("UPDATE purge_batches SET state='legacy_unresolved' WHERE batch_id=?").run(outcome.receipts[0]!.receipt_id);
  const context = { db: f.db, vaultPath: join(f.vaultPath, "ordinary-unavailable-vault"), principal: OWNER };
  expect(() => loadCanon(context)).toThrow("canon unavailable during purge recovery");
  expect(() => serveGetPage(context, { id: "atlas" })).toThrow("canon unavailable during purge recovery");
  const swept = await runRail(f.db, f.vaultPath, "purge-sweep", { now: () => AT, hooks: { claims: { db: f.db, retrieval: f.port } } });
  expect(swept.status).toBe("degraded");
  expect(swept.retrieval.pending_ops).toBe(1);
  expect(f.db.query("SELECT state FROM purge_batches").all()).toEqual([{ state: "legacy_unresolved" }]);
  expect(isHeld(f.db, "facts/atlas.md")).toBe(true);
});

for (const configured of [true, false]) {
  for (const cut of ["phase-one-committed", "discovery-held"] as const) {
    test(`scheduled purge recovery discovers ${cut} batches ${configured ? "with" : "without"} a retrieval operation`, async () => {
      const f = await fixture();
      if (!configured) {
        await f.port.close();
        rmSync(join(f.vaultPath, ".kizuki", "retrieval"), { recursive: true, force: true });
      }
      setAfterCanonSnapshot(() => f.page("late-atlas"));
      setPurgeRecoveryHook(stage => { if (stage === cut) throw new Error("ordinary recovery fixture interruption"); });
      expect(() => purgeEvents(f.db, f.vaultPath, { connector_id: "fixture" }, "retire ordinary fixture", {
        retrieval_store: configured ? f.port.descriptor.id : null, now: () => AT,
      })).toThrow("ordinary recovery fixture interruption");
      setAfterCanonSnapshot(); setPurgeRecoveryHook();
      expect(f.db.query("SELECT 1 FROM purge_ops").all()).toHaveLength(configured ? 1 : 0);
      f.reopen();
      const result = await runRail(f.db, f.vaultPath, "purge-sweep", {
        now: () => AT, ...(configured ? { hooks: { claims: { db: f.db, retrieval: f.port } } } : {}),
      });
      expect(result.status).toBe("ok");
      expect(result.retrieval.pending_ops).toBe(0);
      expect(result.retrieval.removals).toBe(1);
      expect(f.db.query("SELECT state FROM purge_batches").all()).toEqual([{ state: "ready" }]);
      expect(f.db.query("SELECT 1 FROM canon_holds").all()).toEqual([]);
      const served = serveGetPage({ db: f.db, vaultPath: f.vaultPath, principal: OWNER }, { id: "late-atlas" });
      expect(served.canon[0]?.excerpt).toContain("Current Atlas notes.");
      expect(served.canon[0]?.excerpt).not.toContain(f.body);
    });
  }
}

test("shared serving gate refuses a previously assembled canon response after an ordinary purge settles", async () => {
  const f = await fixture();
  const ctx = { db: f.db, vaultPath: f.vaultPath, principal: OWNER };
  await expect(gateAsync(ctx, "search", {}, async ({ ctx: live }) => {
    const index = loadCanon(live);
    const page = index.byId.get("atlas")!;
    const decision = pageDecision(index, OWNER.grant, page);
    if (!decision.allow) throw new Error("ordinary fixture page unexpectedly held");
    const chunk = canonChunk(index, page, decision, page.body, false);
    const outcome = await runPurge(f.db, f.vaultPath, { event_id: f.erased.event_id }, "retire fixture", { retrieval: f.port, now: () => AT });
    expect(outcome.purge_ops[0]?.state).toBe("done");
    expect(isHeld(f.db, "facts/atlas.md")).toBe(false);
    return { canon: [chunk], quoted: [], withheld: [] };
  })).rejects.toMatchObject({ code: "held", message: "canon unavailable during purge recovery" });
  expect(serveGetPage(ctx, { id: "atlas" }).canon[0]?.excerpt).not.toContain(f.body);
});
