import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { insertClaim } from "../../src/claims/store";
import { validateAbsenceProof } from "../../src/contracts/retrieval";
import type { AbsenceProof, RetrievalPort } from "../../src/contracts/retrieval";
import { rebuildDerived, refreshDerivedPage } from "../../src/derived";
import { readDerivedMeta } from "../../src/derived-meta";
import { neighbors, rebuildGraph, refreshPageEdges, removePageEdges, replacePageEdges } from "../../src/graph/graph";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { createVaultFts5Port, isHeld, purgeEvents, resumePurge, runPurge, verifyPurge } from "../../src/ledger/purge";
import { indexPage, rebuildSearch } from "../../src/search/indexer";
import { search } from "../../src/search/query";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { listCanonPagesReport } from "../../src/vault/pages";
import { validEvent } from "../fixtures";
import { tempVault, writeCanon } from "../helpers/vault";

const AT = "2026-09-06T12:00:00.000Z";
const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function fixture() {
  const disk = tempVault("kizuki-purge-completion-");
  const db = openLedger(":memory:");
  disposers.push(disk.dispose, () => db.close());
  const event = (name: string) => {
    const accepted = accept(db, { ...validEvent(), source_record_id: name, text: name });
    if (accepted.status !== "stored") throw new Error("fixture event not stored");
    return accepted.event;
  };
  const erased = event("Retired Atlas note");
  const kept = event("Current Atlas note");
  const body = "Retiredword Atlas fixture.";
  await insertClaim({ db, now: () => AT }, {
    kind: "claim", target: "facts/atlas", body, provenance: [erased.event_id],
    producer: "deterministic", confidence: 0.8, sensitivity: "personal", taint: "quoted",
  });
  writeCanon(disk.path, "facts/atlas.md", {
    id: "atlas", title: "Atlas", type: "fact", status: "active", sensitivity: "personal", taint: "quoted",
    sources: [`event:${erased.event_id}`, kept.event_id], subjects: ["person:ada"],
  }, `${body}\nCurrent Atlas notes.\n`);
  writeCanon(disk.path, "facts/reference.md", {
    id: "reference", title: "Reference", type: "fact", status: "active", sensitivity: "personal", taint: "quoted",
    sources: [kept.event_id],
  }, "See [[Atlas]]. Current reference.\n");
  rebuildDerived(db, disk.path);
  const port = createVaultFts5Port(disk.path, () => AT);
  disposers.push(() => port.close());
  return { db, vaultPath: disk.path, erased, kept, port, body };
}

function opState(db: ReturnType<typeof openLedger>, opId: string) {
  return db.query<{ state: string; proof: string | null; done_at: string | null }, [string]>(
    "SELECT state, proof, done_at FROM purge_ops WHERE op_id=?",
  ).get(opId);
}

describe("purge completion is scoped to validated store evidence", () => {
  const defects: [string, (proof: AbsenceProof) => AbsenceProof][] = [
    ["incomplete count", proof => ({ ...proof, checked: 0 })],
    ["different store", proof => ({ ...proof, store: "kizuki.retrieval.unbound-fixture" })],
    ["invalid timestamp", proof => ({ ...proof, at: "unknown" })],
    ["unrequested result", proof => ({ ...proof, found: ["page:unrequested-fixture"] })],
  ];
  for (const [name, alter] of defects) {
    test(`${name} keeps the operation and page pending until a valid proof arrives`, async () => {
      const { db, vaultPath, erased, port } = await fixture();
      const verify = port.verifyAbsent.bind(port);
      port.verifyAbsent = async ids => alter(await verify(ids));
      const outcome = await runPurge(db, vaultPath, { event_id: erased.event_id }, "retire fixture", { retrieval: port, now: () => AT });
      const op = outcome.purge_ops[0]!;
      expect(opState(db, op.op_id)).toEqual({ state: "pending", proof: null, done_at: null });
      expect(outcome.rewritten).toEqual([]);
      expect(isHeld(db, "facts/atlas.md")).toBe(true);
      expect((await verifyPurge(db, vaultPath, outcome.receipts[0]!.receipt_id, { retrieval: port, now: () => AT })).ok).toBe(false);
      expect(opState(db, op.op_id)?.state).toBe("pending");
      port.verifyAbsent = verify;
      const complete = await resumePurge(db, vaultPath, outcome.receipts[0]!.receipt_id, { retrieval: port, now: () => AT });
      expect(complete.ok).toBe(true);
      expect(complete.pages_rewritten).toBe(1);
      expect(isHeld(db, "facts/atlas.md")).toBe(false);
    });
  }

  test("a different binding is never asked to remove the recorded store's documents", async () => {
    const { db, vaultPath, erased, port } = await fixture();
    const outcome = purgeEvents(db, vaultPath, { event_id: erased.event_id }, "retire fixture", {
      retrieval_store: port.descriptor.id, now: () => AT,
    });
    let removals = 0;
    let verifications = 0;
    const other: RetrievalPort = {
      descriptor: { ...port.descriptor, id: "kizuki.retrieval.unbound-fixture" },
      upsert: docs => port.upsert(docs), search: query => port.search(query),
      neighbors: (entity, options) => port.neighbors(entity, options),
      health: () => port.health(), close: () => port.close(),
      remove: async ids => { removals += 1; return port.remove(ids); },
      verifyAbsent: async ids => { verifications += 1; return port.verifyAbsent(ids); },
    };
    expect((await resumePurge(db, vaultPath, outcome.receipts[0]!.receipt_id, { retrieval: other, now: () => AT })).ok).toBe(false);
    expect([removals, verifications]).toEqual([0, 0]);
    expect(isHeld(db, "facts/atlas.md")).toBe(true);
    expect(opState(db, outcome.purge_ops[0]!.op_id)?.state).toBe("pending");
  });

  test("a later invalid verification reopens a previously done operation", async () => {
    const { db, vaultPath, erased, port } = await fixture();
    const outcome = await runPurge(db, vaultPath, { event_id: erased.event_id }, "retire fixture", { retrieval: port, now: () => AT });
    expect(opState(db, outcome.purge_ops[0]!.op_id)?.state).toBe("done");
    const verify = port.verifyAbsent.bind(port);
    port.verifyAbsent = async ids => ({ ...await verify(ids), checked: 0 });
    expect((await verifyPurge(db, vaultPath, outcome.receipts[0]!.receipt_id, { retrieval: port, now: () => AT })).ok).toBe(false);
    expect(opState(db, outcome.purge_ops[0]!.op_id)).toEqual({ state: "pending", proof: null, done_at: null });
  });

  test("overlapping page holds wait for every receipt's store proof", async () => {
    const { db, vaultPath, erased, kept, port } = await fixture();
    const first = purgeEvents(db, vaultPath, { event_id: erased.event_id }, "retire first fixture", {
      retrieval_store: port.descriptor.id, now: () => AT,
    });
    const second = purgeEvents(db, vaultPath, { event_id: kept.event_id }, "retire second fixture", {
      retrieval_store: port.descriptor.id, now: () => AT,
    });
    const waiting = await resumePurge(db, vaultPath, first.receipts[0]!.receipt_id, { retrieval: port, now: () => AT });
    expect(waiting.ok).toBe(false);
    expect(waiting.pages_rewritten).toBe(0);
    expect(opState(db, first.purge_ops[0]!.op_id)?.state).toBe("done");
    expect(opState(db, second.purge_ops[0]!.op_id)?.state).toBe("pending");
    expect(isHeld(db, "facts/atlas.md")).toBe(true);
    const complete = await resumePurge(db, vaultPath, second.receipts[0]!.receipt_id, { retrieval: port, now: () => AT });
    expect(complete.ok).toBe(true);
    expect(isHeld(db, "facts/atlas.md")).toBe(false);
    expect(isHeld(db, "facts/reference.md")).toBe(false);
  });

  test("a large negative proof is bounded by its exact request without truncating findings", () => {
    const ids = Array.from({ length: 10_025 }, (_, index) => `claim:ordinary-${index}`);
    const proof = { checked: ids.length, found: ids, store: "kizuki.retrieval.fixture", method: "fixture-lookup", at: AT };
    expect(validateAbsenceProof(proof, ids).found).toEqual(ids);
    expect(() => validateAbsenceProof(proof)).toThrow("absence proof");
    expect(() => validateAbsenceProof(proof, ids.slice(1))).toThrow("absence proof");
    expect(() => validateAbsenceProof({ ...proof, found: ["claim:outside"] }, ids)).toThrow("absence proof scope");
  });
});

test("pending canon with event references stays absent through every local rebuild and refresh", async () => {
  const { db, vaultPath, erased, kept, port, body } = await fixture();
  const pages = listCanonPagesReport(vaultPath).pages;
  const atlas = pages.find(page => page.id === "atlas")!;
  const reference = pages.find(page => page.id === "reference")!;
  const outcome = purgeEvents(db, vaultPath, { event_id: erased.event_id }, "retire referenced fixture", {
    retrieval_store: port.descriptor.id, now: () => AT,
  });
  expect(outcome.canon_holds.map(hold => hold.page_path)).toContain(atlas.relPath);
  const assertWithheld = () => {
    expect(search(db, "Retiredword", { ceiling: "private" })).toEqual([]);
    expect(db.query("SELECT 1 FROM search_documents WHERE doc_id='page:atlas'").all()).toEqual([]);
    expect(neighbors(db, "atlas").edges).toEqual([]);
    expect(db.query("SELECT 1 FROM graph_edges WHERE dst IN ('Atlas','facts/atlas','atlas') OR src='atlas'").all()).toEqual([]);
    expect(readDerivedMeta(db, "search")?.status).toBe("degraded");
    expect(readDerivedMeta(db, "graph")?.status).toBe("degraded");
    expect(search(db, "Current reference", { ceiling: "private" }).some(hit => hit.doc_id === "page:reference")).toBe(true);
  };
  assertWithheld();
  const rebuilt = rebuildDerived(db, vaultPath);
  expect([rebuilt.search.status, rebuilt.graph.status]).toEqual(["degraded", "degraded"]);
  assertWithheld();
  expect(rebuildSearch(db, vaultPath).status).toBe("degraded");
  expect(rebuildGraph(db, vaultPath).status).toBe("degraded");
  assertWithheld();
  indexPage(db, atlas);
  refreshDerivedPage(db, atlas, vaultPath);
  refreshDerivedPage(db, reference, vaultPath);
  refreshPageEdges(db, atlas, pages, 1);
  refreshPageEdges(db, reference, pages, 1);
  replacePageEdges(db, pages);
  assertWithheld();
  // An incomplete snapshot cannot know the held page's title aliases.
  refreshPageEdges(db, reference, [reference], 1);
  expect(db.query("SELECT 1 FROM graph_edges").all()).toEqual([]);
  replacePageEdges(db, [reference]);
  expect(db.query("SELECT 1 FROM graph_edges").all()).toEqual([]);
  removePageEdges(db, reference.id, [reference], 1);
  assertWithheld();
  const complete = await resumePurge(db, vaultPath, outcome.receipts[0]!.receipt_id, { retrieval: port, now: () => AT });
  expect(complete.ok).toBe(true);
  const rewritten = parseFrontmatter(readFileSync(join(vaultPath, atlas.relPath), "utf8"));
  expect(rewritten.data["sources"]).toEqual([kept.event_id]);
  expect(rewritten.body).not.toContain(body);
  expect(rewritten.body).toContain("Current Atlas notes.");
  const after = {
    search: db.query("SELECT * FROM search_documents ORDER BY doc_id").all(),
    graph: db.query("SELECT * FROM graph_edges ORDER BY src,dst,kind").all(),
  };
  const fresh = rebuildDerived(db, vaultPath);
  expect([fresh.search.status, fresh.graph.status]).toEqual(["ok", "ok"]);
  expect({
    search: db.query("SELECT * FROM search_documents ORDER BY doc_id").all(),
    graph: db.query("SELECT * FROM graph_edges ORDER BY src,dst,kind").all(),
  }).toEqual(after);
  expect(search(db, "Retiredword", { ceiling: "private" })).toEqual([]);
});

test("an ambiguous held title cannot return as an unresolved graph target", async () => {
  const { db, vaultPath, erased, kept, port } = await fixture();
  writeCanon(vaultPath, "facts/other-atlas.md", {
    id: "other-atlas", title: "Atlas", type: "fact", status: "active", sensitivity: "personal", taint: "quoted",
    sources: [kept.event_id],
  }, "Another ordinary Atlas fixture.\n");
  rebuildGraph(db, vaultPath);
  purgeEvents(db, vaultPath, { event_id: erased.event_id }, "retire ambiguous fixture", {
    retrieval_store: port.descriptor.id, now: () => AT,
  });
  expect(db.query("SELECT 1 FROM graph_edges WHERE dst IN ('Atlas','atlas') OR src='atlas'").all()).toEqual([]);
  const pages = listCanonPagesReport(vaultPath).pages;
  const reference = pages.find(page => page.id === "reference")!;
  replacePageEdges(db, pages);
  refreshPageEdges(db, reference, pages, 1);
  expect(db.query("SELECT 1 FROM graph_edges WHERE dst IN ('Atlas','atlas') OR src='atlas'").all()).toEqual([]);
  expect(readDerivedMeta(db, "graph")?.status).toBe("degraded");
});

test("readable inactive held aliases preserve unrelated live graph edges in both rebuild paths", async () => {
  const { db, vaultPath, erased, kept, port } = await fixture();
  writeCanon(vaultPath, "facts/atlas.md", {
    id: "atlas", title: "Atlas", type: "fact", status: "archived", sensitivity: "personal", taint: "quoted",
    sources: [erased.event_id],
  }, "Retired ordinary Atlas fixture.\n");
  writeCanon(vaultPath, "facts/keeper.md", {
    id: "keeper", title: "Keeper", type: "fact", status: "active", sensitivity: "personal", taint: "quoted",
    sources: [kept.event_id],
  }, "Current keeper fixture.\n");
  writeCanon(vaultPath, "facts/reference.md", {
    id: "reference", title: "Reference", type: "fact", status: "active", sensitivity: "personal", taint: "quoted",
    sources: [kept.event_id],
  }, "See [[Atlas]] and [[Keeper]].\n");
  purgeEvents(db, vaultPath, { event_id: erased.event_id }, "retire inactive fixture", {
    retrieval_store: port.descriptor.id, now: () => AT,
  });
  expect(isHeld(db, "facts/atlas.md")).toBe(true);
  for (const rebuild of [() => rebuildDerived(db, vaultPath).graph, () => rebuildGraph(db, vaultPath)]) {
    expect(rebuild()).toMatchObject({ pages: 2, edges: 3, status: "degraded" });
    expect(db.query("SELECT src,dst,kind FROM graph_edges ORDER BY src,kind").all()).toEqual([
      { src: "keeper", dst: kept.event_id, kind: "source" },
      { src: "reference", dst: kept.event_id, kind: "source" },
      { src: "reference", dst: "keeper", kind: "wikilink" },
    ]);
    expect(readDerivedMeta(db, "graph")).toMatchObject({ source_count: 2, canon_hash: null, status: "degraded" });
  }
});
