import { search } from "../../src/search/query";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { correct } from "../../src/correction/correct";
import { initAgents } from "../../src/agents";
import { serveGetPage } from "../../src/serving/page";
import { serveContextPacket } from "../../src/serving/packet";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { listCanonPages } from "../../src/vault/pages";
import { validatePage } from "../../src/vault/schema";
import { readPage, CanonPageUnreadable } from "../../src/canon/store";
import { isAuthorityTier } from "../../src/contracts/proposal";
import type { AuthorityTier } from "../../src/contracts/proposal";
import { corroboratedFacts, nativeOwnerEvent } from "../claims/helpers";
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER } from "../../src/agents";
import { applyPurgeRewrite } from "../../src/canon/apply";
import { undoReceipt } from "../../src/canon/undo";
import { rebuildDerived } from "../../src/derived";
import { loadCanon } from "../../src/serving/canon";
import { canonFixture, putEvent, storeClaim, write } from "./helpers";
import type { CanonFixture } from "./helpers";
const fixtures: CanonFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) {
  f.dispose();
} });
function fixture() { const f = canonFixture(); fixtures.push(f); return f; }
function authorities(f: CanonFixture, path: string) {
  const index = loadCanon({ db: f.db, vaultPath: f.vault, principal: OWNER });
  return { serving: index.authority.get(path), search: f.db.query<{
      authority: string;
    }, [
      string
    ]>("SELECT authority FROM search_documents WHERE path=?").get(path)?.authority,
    hit: search(f.db, "Grace", { scope: "canon", ceiling: "private" }).find(hit => hit.path === path)?.authority,
    graph: f.db.query<{
      authority: string;
    }, [
      string
    ]>("SELECT DISTINCT authority FROM graph_edges WHERE src=(SELECT page_id FROM page_index WHERE rel_path=?)").all(path).map(r => r.authority) };
}
function expectAuthority(f: CanonFixture, path: string, authority: AuthorityTier) { expect(authorities(f, path)).toEqual({ serving: authority, search: authority, hit: authority, graph: [authority] }); }
test("model canon has the same authority in incremental serving/search/graph and rebuild", async () => {
  const f = fixture();
  const event = putEvent(f.db);
  const claim = await storeClaim(f.db, event, { producer: "model", model_ref: "fixture:model" });
  const receipt = write(f.io, claim);
  expectAuthority(f, receipt.page_path, "model_inference");
  const before = { search: f.db.query("SELECT * FROM search_documents WHERE scope='canon' ORDER BY doc_id").all(), graph: f.db.query("SELECT * FROM graph_edges ORDER BY src,dst,kind").all() };
  rebuildDerived(f.db, f.vault);
  expectAuthority(f, receipt.page_path, "model_inference");
  expect({ search: f.db.query("SELECT * FROM search_documents WHERE scope='canon' ORDER BY doc_id").all(), graph: f.db.query("SELECT * FROM graph_edges ORDER BY src,dst,kind").all() }).toEqual(before);
});
test("undo and undo of revert preserve the authority of the restored bytes", async () => {
  const f = fixture();
  const event = putEvent(f.db);
  const second = putEvent(f.db, { connector_id: "other-fixture" });
  const first = write(f.io, await storeClaim(f.db, event, { provenance: [event, second], events: corroboratedFacts(event, second) }));
  const edited = write(f.io, await storeClaim(f.db, event, { kind: "edit", predicate: null, object: null, body: "A model edit of Grace.", frontmatter: {}, producer: "model", model_ref: "fixture:model" }));
  const reverted = await undoReceipt(f.io, edited.receipt_id);
  expect(reverted.authority).toBe("connector_evidence");
  expectAuthority(f, first.page_path, "connector_evidence");
  const restored = await undoReceipt(f.io, reverted.receipt_id);
  expect(restored.authority).toBe("model_inference");
  expectAuthority(f, first.page_path, "model_inference");
  rebuildDerived(f.db, f.vault);
  expectAuthority(f, first.page_path, "model_inference");
});
test("purge cannot elevate a model page and hand edits do not inherit its receipt", async () => {
  const f = fixture();
  const event = putEvent(f.db);
  const receipt = write(f.io, await storeClaim(f.db, event, { producer: "model", model_ref: "fixture:model", body: "A model note. Grace retained context." }));
  const purged = applyPurgeRewrite(f.io, { rel_path: receipt.page_path, purged_event_ids: [], purged_claim_ids: [], purged_claim_bodies: ["A model note."] });
  expect(purged.authority).toBe("model_inference");
  expectAuthority(f, receipt.page_path, "model_inference");
  f.db.query("UPDATE canon_receipts SET authority='owner_correction' WHERE receipt_id=?").run(purged.receipt_id);
  rebuildDerived(f.db, f.vault);
  expectAuthority(f, receipt.page_path, "model_inference");
  const path = join(f.vault, receipt.page_path);
  writeFileSync(path, readFileSync(path, "utf8") + "\nOwner hand edit.\n");
  rebuildDerived(f.db, f.vault);
  expectAuthority(f, receipt.page_path, "owner_authored");
});
test("public correction, page and context preserve owner correction through purge", async () => {
  const f = fixture();
  initAgents(f.db);
  const claim = await storeClaim(f.db, putEvent(f.db), { producer: "model", model_ref: "fixture:model" });
  const receipt = write(f.io, claim);
  await correct(f.io, { statement: "Grace works at Northwind.", target: { claim_id: claim.claim_id } });
  expectAuthority(f, receipt.page_path, "owner_correction");
  const ctx = { db: f.db, vaultPath: f.vault, principal: OWNER };
  expect(serveGetPage(ctx, { path: receipt.page_path }).canon[0]?.authority).toBe("owner_correction");
  expect((await serveContextPacket(ctx, { query: "Grace", budget_tokens: 1000 })).canon.find(page => page.path === receipt.page_path)?.authority).toBe("owner_correction");
  const purge = applyPurgeRewrite(f.io, { rel_path: receipt.page_path, purged_event_ids: [], purged_claim_ids: [], purged_claim_bodies: ["Northwind"] });
  expect(purge.authority).toBe("owner_correction");
  rebuildDerived(f.db, f.vault);
  expectAuthority(f, receipt.page_path, "owner_correction");
});
test("legacy revert fields and invalid or missing references cannot inflate current authority", async () => {
  const f = fixture();
  const event = putEvent(f.db);
  const first = write(f.io, await storeClaim(f.db, event, { producer: "model", model_ref: "fixture:model" }));
  const edit = write(f.io, await storeClaim(f.db, event, { kind: "edit", predicate: null, object: null, body: "Different model text about Grace.", frontmatter: {}, producer: "model", model_ref: "fixture:model" }));
  const revert = await undoReceipt(f.io, edit.receipt_id);
  f.db.query("UPDATE canon_receipts SET authority='owner_correction' WHERE receipt_id=?").run(revert.receipt_id);
  rebuildDerived(f.db, f.vault);
  expectAuthority(f, first.page_path, "model_inference");
  f.db.query("UPDATE canon_receipts SET reverts=? WHERE receipt_id=?").run(revert.receipt_id, revert.receipt_id);
  rebuildDerived(f.db, f.vault);
  expectAuthority(f, first.page_path, "model_inference");
  f.db.query("UPDATE canon_receipts SET reverts='missing' WHERE receipt_id=?").run(revert.receipt_id);
  rebuildDerived(f.db, f.vault);
  expectAuthority(f, first.page_path, "model_inference");
  f.db.query("UPDATE canon_receipts SET receipt_kind='write',authority='invalid' WHERE receipt_id=?").run(revert.receipt_id);
  rebuildDerived(f.db, f.vault);
  expectAuthority(f, first.page_path, "model_inference");
});
test("export, clean restore and rebuild preserve effective model authority", async () => {
  const f = fixture();
  const first = write(f.io, await storeClaim(f.db, putEvent(f.db), { producer: "model", model_ref: "fixture:model" }));
  const parent = mkdtempSync(join(tmpdir(), "kizuki-authority-export-"));
  try {
    const backup = join(parent, "backup");
    exportVault(f.db, f.vault, backup);
    const target = join(parent, "restored");
    restoreVault(backup, target);
    const db = openLedger(join(target, ".kizuki", "kizuki.db"));
    try {
      rebuildDerived(db, target);
      expectAuthority({ ...f, db, vault: target }, first.page_path, "model_inference");
    }
    finally {
      db.close();
    }
  }
  finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
test("model create infers page type only from its grounded subject and snapshots exact bytes", async () => {
  const f = fixture();
  const receipt = write(f.io, await storeClaim(f.db, putEvent(f.db), { frontmatter: {}, producer: "model", model_ref: "fixture:model" }));
  const page = listCanonPages(f.vault)[0]!;
  expect(page.data["type"]).toBe("person");
  expect(page.data["x-subject-id"]).toBe("person:grace");
  expect(page.contentHash).toBe(receipt.after_hash);
  expect(validatePage({ ...page.data, authority: "owner_correction" })).toContain('authority: unknown key; extensions must start with "x-"');
});
test("unreadable page is distinct from an absent page", () => {
  const f = fixture();
  expect(readPage(f.io, "people/missing.md")).toBeNull();
  mkdirSync(join(f.vault, "people", "directory.md"), { recursive: true });
  expect(() => readPage(f.io, "people/directory.md")).toThrow(CanonPageUnreadable);
});

test("writer rejects forged claim content before writing a receipt", async () => {
  const f = fixture();
  const claim = await storeClaim(f.db, putEvent(f.db), {
    producer: "model", model_ref: "fixture:model", frontmatter: {},
  });
  for (const forged of [
    { ...claim, authority: "owner_correction" as const },
    { ...claim, subject: "person:invented" },
    { ...claim, body: "Unreceipted replacement prose" },
    { ...claim, provenance: ["forged-event"] },
    { ...claim, sensitivity: "public" as const },
    { ...claim, frontmatter: { type: "org" } },
  ]) {
    expect(() => write(f.io, forged)).toThrow("differs from its stored row");
  }
  expect(f.db.query("SELECT receipt_id FROM canon_receipts").all()).toEqual([]);
});

test("writer uses fresh lifecycle values without trusting forged metadata", async () => {
  const f = fixture();
  const claim = await storeClaim(f.db, putEvent(f.db), { producer: "model", model_ref: "fixture:model" });
  f.db.query("UPDATE claims SET corroboration=2,last_confirmed_at=? WHERE claim_id=?")
    .run("2026-09-05T00:00:00.000Z", claim.claim_id);
  const receipt = write(f.io, claim);
  expect(receipt.authority).toBe("model_inference");
  expectAuthority(f, receipt.page_path, "model_inference");
});

test("prototype property names are never authority tiers in any projection", async () => {
  const f = fixture();
  const receipt = write(f.io, await storeClaim(f.db, putEvent(f.db), {
    producer: "model", model_ref: "fixture:model",
  }));
  for (const authority of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    expect(isAuthorityTier(authority)).toBe(false);
    f.db.query("UPDATE canon_receipts SET authority=? WHERE receipt_id=?")
      .run(authority, receipt.receipt_id);
    rebuildDerived(f.db, f.vault);
    expectAuthority(f, receipt.page_path, "model_inference");
  }
});

test("a revert must begin at the after-hash of the write it names", async () => {
  const f = fixture();
  const event = nativeOwnerEvent(f.db, "Grace runs partnerships at Acme.");
  const first = write(f.io, await storeClaim(f.db, event, { producer: "owner", intent: "correct" }));
  expect(first.authority).toBe("owner_correction");
  const originalBytes = readFileSync(join(f.vault, first.page_path));
  const edit = async (body: string) => write(f.io, await storeClaim(f.db, event, {
    kind: "edit", predicate: null, object: null, frontmatter: {}, body,
    producer: "model", model_ref: "fixture:model",
  }));
  const target = await edit("Grace has a first model update.");
  const later = await edit("Grace has a later model update.");
  const revert = await undoReceipt(f.io, later.receipt_id);
  // Corrupt H3 -> H1 names the H1 -> H2 target, although it never starts at H2.
  f.db.query("UPDATE canon_receipts SET reverts=?,after_hash=? WHERE receipt_id=?")
    .run(target.receipt_id, first.after_hash, revert.receipt_id);
  writeFileSync(join(f.vault, first.page_path), originalBytes);
  rebuildDerived(f.db, f.vault);
  expectAuthority(f, first.page_path, "model_inference");
});


test("equal corrupt revert hashes cannot recover owner authority", async () => {
  const f = fixture();
  const event = putEvent(f.db);
  const first = write(f.io, await storeClaim(f.db, event, { producer: "owner", intent: "correct" }));
  const target = write(f.io, await storeClaim(f.db, event, {
    kind: "edit", predicate: null, object: null, frontmatter: {}, body: "Grace has a model update.",
    producer: "model", model_ref: "fixture:model",
  }));
  const reverted = await undoReceipt(f.io, target.receipt_id);
  f.db.query("UPDATE canon_receipts SET after_hash=? WHERE receipt_id=?").run("not-a-sha256", target.receipt_id);
  f.db.query("UPDATE canon_receipts SET before_hash=? WHERE receipt_id=?").run("not-a-sha256", reverted.receipt_id);
  rebuildDerived(f.db, f.vault);
  expectAuthority(f, first.page_path, "model_inference");
});
