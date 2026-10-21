import { expect, test } from "bun:test";
import { applyCanonWrite, getClaim, recoverCanonWrites, resumePurge, runPurge, verifyPurge } from "../../src";
import { worldCanonTarget } from "../../src/canon/world-materialization";
import { rebuildDerived } from "../../src/derived";
import { budget, canonFixture } from "../canon/helpers";
import { recordedPage } from "../helpers/recorded-page";
import { worldFixture } from "../serving/world-fixture";

for (const rollback of [false, true]) {
test(`typed page erasure preserves unrelated graph edges${rollback ? " after receipt completion rollback and recovery" : " before any rebuild"}`, async () => {
  const f = canonFixture();
  try {
    await recordedPage(f.db, f.vault, "facts/keeper.md", {
      id: "keeper", title: "Lighthouse", type: "fact", status: "active",
      sensitivity: "private", taint: "clean",
    }, "The lighthouse uses a blue lamp.");
    const world = await worldFixture(f.db, { connector: "retired.fixture", floor: "private" });
    const claims = world.claims.map(id => getClaim(f.db, id)!);
    applyCanonWrite(f.io, claims, worldCanonTarget(f.db, claims[0]!.claim_id), { writer: "loop", budget: budget() });
    rebuildDerived(f.db, f.vault);
    const keeper = f.db.query("SELECT * FROM graph_edges WHERE src='keeper' ORDER BY dst,kind").all();
    expect(keeper.length).toBeGreaterThan(0);

    const purge = () => runPurge(f.db, f.vault, { connector_id: "retired.fixture" }, "retire synthetic evidence");
    let receiptId: string;
    if (rollback) {
      // Fail at completion's intent retirement, immediately before derived
      // removal. Earlier eligibility work can already empty the graph registry,
      // so a graph INSERT is not a reliable fault at this transaction boundary.
      // Both receipt insertion and intent retirement must roll back together.
      expect(f.db.query("SELECT count(*) AS n FROM canon_receipts WHERE receipt_state='erased'").get()).toEqual({ n: 0 });
      f.db.exec("CREATE TRIGGER fail_completion AFTER DELETE ON canon_write_intents WHEN EXISTS (SELECT 1 FROM canon_receipts WHERE receipt_state='erased') BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END");
      await expect(purge()).rejects.toThrow("synthetic completion failure");
      expect(f.db.query("SELECT count(*) AS n FROM canon_write_intents").get()).toEqual({ n: 1 });
      expect(f.db.query("SELECT count(*) AS n FROM canon_receipts WHERE receipt_state='erased'").get()).toEqual({ n: 0 });
      receiptId = f.db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM event_purges LIMIT 1").get()!.receipt_id;
      f.db.exec("DROP TRIGGER fail_completion");
      expect(recoverCanonWrites(f.io).pending).toBe(false);
      expect((await resumePurge(f.db, f.vault, receiptId)).ok).toBe(true);
    } else {
      const result = await purge();
      expect(result.receipts).toHaveLength(1);
      receiptId = result.receipts[0]!.receipt_id;
    }
    expect((await verifyPurge(f.db, f.vault, receiptId)).ok).toBe(true);
    expect(f.db.query("SELECT * FROM graph_edges ORDER BY src,dst,kind").all()).toEqual(keeper);
    const search = f.db.query("SELECT * FROM search_documents ORDER BY doc_id").all();
    rebuildDerived(f.db, f.vault);
    expect(f.db.query("SELECT * FROM graph_edges ORDER BY src,dst,kind").all()).toEqual(keeper);
    expect(f.db.query("SELECT * FROM search_documents ORDER BY doc_id").all()).toEqual(search);
  } finally { f.dispose(); }
});
}
