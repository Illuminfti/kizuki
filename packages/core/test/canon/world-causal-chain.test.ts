import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonFixture, budget } from "./helpers";
import { worldFixture } from "../serving/world-fixture";
import { getClaim } from "../../src/claims/store";
import { applyCanonWrite } from "../../src/canon/apply";
import { correct } from "../../src/correction/correct";
import { undoReceipt } from "../../src/canon/undo";
import { getCanonReceipt, latestReceiptForPage, laterReceiptsForPage, worldReceiptChain, isErasedReceipt } from "../../src/canon/receipts";
import { rebuildPageIndex } from "../../src/canon/store";
import { worldCanonPath, worldClaimHandle } from "../../src/canon/world-materialization";
import { initSearch } from "../../src/search";
import { initGraph } from "../../src/graph";
import { runPurge } from "../../src/ledger/purge";
import { ulid } from "../../src/util/ulid";

test("backdated typed correction and undo keep the actual current head and prior authority", async () => {
  let now = "2026-09-21T10:00:00.000Z";
  const f = canonFixture({ now: () => now });
  try {
    initSearch(f.db); initGraph(f.db);
    const world = await worldFixture(f.db);
    const claims = world.claims.map(id => getClaim(f.db, id)!);
    const path = worldCanonPath(worldClaimHandle(f.db, claims[0]!.claim_id)!);
    const first = applyCanonWrite(f.io, claims, { action: "create", rel_path: path }, { writer: "loop", budget: budget() });
    const bytes = readFileSync(join(f.vault, path));
    now = "2026-09-20T10:00:00.000Z";
    const changed = await correct(f.io, { statement: "Use independent evidence.", target: { claim_id: world.claims[2]! } });
    expect(changed.receipt_id).toBeString();
    const second = getCanonReceipt(f.db, changed.receipt_id!)!;
    expect(laterReceiptsForPage(f.db, path, first).map(row => row.receipt_id)).toEqual([second.receipt_id]);
    now = "2026-09-19T10:00:00.000Z";
    const third = await undoReceipt(f.io, second.receipt_id);
    expect(third.authority).toBe(first.authority);
    expect(readFileSync(join(f.vault, path))).toEqual(bytes);
    rebuildPageIndex(f.io);
    expect(latestReceiptForPage(f.db, path)?.receipt_id).toBe(third.receipt_id);
    expect(worldReceiptChain(f.db, path).map(row => [row.receipt_id, row.prior_receipt_id])).toEqual([
      [first.receipt_id, null], [second.receipt_id, first.receipt_id], [third.receipt_id, second.receipt_id],
    ]);
  } finally { f.dispose(); }
});

test("an erased middle revision preserves authorized earlier history and one current head", async () => {
  const f = canonFixture();
  try {
    initSearch(f.db); initGraph(f.db);
    const world = await worldFixture(f.db), claims = world.claims.map(id => getClaim(f.db, id)!);
    const path = worldCanonPath(worldClaimHandle(f.db, claims[0]!.claim_id)!);
    const first = applyCanonWrite(f.io, claims, { action: "create", rel_path: path }, { writer: "loop", budget: budget() });
    const changed = await correct(f.io, { statement: "Independent native assertion.", target: { claim_id: world.claims[2]! } });
    const second = getCanonReceipt(f.db, changed.receipt_id!)!;
    await runPurge(f.db, f.vault, { event_id: changed.event_id! }, "erase independent native statement");
    const chain = worldReceiptChain(f.db, path);
    expect(chain).toHaveLength(3);
    expect(chain[0]!.receipt_id).toBe(first.receipt_id);
    expect(isErasedReceipt(chain[0]!)).toBe(false);
    expect(chain[1]).toMatchObject({ state: "erased", receipt_id: second.receipt_id, prior_receipt_id: first.receipt_id });
    expect(chain[2]!.prior_receipt_id).toBe(second.receipt_id);
    expect(isErasedReceipt(chain[2]!)).toBe(false);
    rebuildPageIndex(f.io);
    expect(latestReceiptForPage(f.db, path)?.receipt_id).toBe(chain[2]!.receipt_id);
    expect(readFileSync(join(f.vault, path), "utf8")).not.toContain("Independent native assertion.");
    // The bridge's integrity is necessary even though it contains no content.
    f.db.query("UPDATE canon_receipts SET erasure_integrity=? WHERE receipt_id=?").run("0".repeat(64), second.receipt_id);
    expect(() => worldReceiptChain(f.db, path)).toThrow();
  } finally { f.dispose(); }
});

test.each(["missing", "cycle", "cross-page", "disconnected"])("typed lineage rejects %s predecessors", async (mode) => {
  const f = canonFixture();
  try {
    const world = await worldFixture(f.db), claims = world.claims.map(id => getClaim(f.db, id)!);
    const path = worldCanonPath(worldClaimHandle(f.db, claims[0]!.claim_id)!);
    const first = applyCanonWrite(f.io, claims, { action: "create", rel_path: path }, { writer: "loop", budget: budget() });
    const pageId = f.db.query<{ page_id: string }, [string]>("SELECT page_id FROM page_index WHERE rel_path=?").get(path)!.page_id;
    const second = applyCanonWrite(f.io, claims, { action: "edit", rel_path: path, page_id: pageId, reason: "explicit" }, { writer: "loop", budget: budget() });
    expect(second.after_hash).toBe(first.after_hash);
    expect(latestReceiptForPage(f.db, path)?.receipt_id).toBe(second.receipt_id);
    if (mode === "missing") f.db.query("UPDATE canon_receipts SET prior_receipt_id=? WHERE receipt_id=?").run(ulid(), first.receipt_id);
    if (mode === "cycle") f.db.query("UPDATE canon_receipts SET prior_receipt_id=? WHERE receipt_id=?").run(second.receipt_id, first.receipt_id);
    if (mode === "cross-page") f.db.query("UPDATE canon_receipts SET page_path=? WHERE receipt_id=?").run("auto/world/" + "f".repeat(32) + ".md", first.receipt_id);
    if (mode === "disconnected") f.db.query("UPDATE canon_receipts SET prior_receipt_id=NULL WHERE receipt_id=?").run(second.receipt_id);
    expect(() => worldReceiptChain(f.db, path)).toThrow("lineage invalid");
  } finally { f.dispose(); }
});

test("cascade follows backdated children and the storage index rejects forks", async () => {
  let now = "2026-09-21T10:00:00.000Z";
  const f = canonFixture({ now: () => now });
  try {
    initSearch(f.db); initGraph(f.db);
    const world = await worldFixture(f.db), claims = world.claims.map(id => getClaim(f.db, id)!);
    const path = worldCanonPath(worldClaimHandle(f.db, claims[0]!.claim_id)!);
    const first = applyCanonWrite(f.io, claims, { action: "create", rel_path: path }, { writer: "loop", budget: budget() });
    now = "2026-09-20T10:00:00.000Z";
    await correct(f.io, { statement: "Use independent evidence.", target: { claim_id: world.claims[2]! } });
    now = "2026-09-19T10:00:00.000Z";
    const reverted = await undoReceipt(f.io, first.receipt_id, { cascade: true });
    expect(existsSync(join(f.vault, path))).toBe(false);
    const chain = worldReceiptChain(f.db, path);
    expect(chain).toHaveLength(4);
    expect(chain.at(-1)!.receipt_id).toBe(reverted.receipt_id);
    // The index enforces one child independently of the read-time graph guard.
    expect(() => f.db.query("UPDATE canon_receipts SET prior_receipt_id=? WHERE receipt_id=?")
      .run(first.receipt_id, reverted.receipt_id)).toThrow("UNIQUE constraint failed");
  } finally { f.dispose(); }
});
