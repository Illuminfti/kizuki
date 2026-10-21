import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER } from "../../src/agents";
import { applyCanonWrite } from "../../src/canon/apply";
import { getCanonReceipt } from "../../src/canon/receipts";
import { worldCanonPath, worldClaimHandle } from "../../src/canon/world-materialization";
import * as materializer from "../../src/canon/world-materialization";
import { getClaim } from "../../src/claims/store";
import { rebuildDerived } from "../../src/derived";
import { loadCanon, pageDecision } from "../../src/serving/canon";
import { serveContextPacket } from "../../src/serving/packet";
import { budget, canonFixture } from "../canon/helpers";
import { worldFixture } from "./world-fixture";

test("pre-upgrade clean typed model pages are served quoted without rewriting receipts or canon", async () => {
  const f = canonFixture();
  try {
    const world = await worldFixture(f.db, { purposes: ["capture", "derive", "recall", "correction", "export", "session"] });
    // Reconstruct the pre-upgrade ledger classification before the real writer
    // creates a hash-bound receipt. No page or receipt is edited after admission.
    for (const id of world.claims) f.db.query("UPDATE claims SET taint='clean' WHERE claim_id=?").run(id);
    const claims = world.claims.map(id => getClaim(f.db, id)!);
    const path = worldCanonPath(worldClaimHandle(f.db, claims[0]!.claim_id)!);
    // Reproduce the old materializer's parent-taint selection, then restore the
    // current implementation before any read. All receipt/file writes remain real.
    const select = materializer.selectWorldMaterialization;
    const legacy = spyOn(materializer, "selectWorldMaterialization").mockImplementation((db, handle) => {
      const result = select(db, handle);
      return result === null ? null : { ...result, claims: result.claims.map(claim => ({ ...claim, taint: "clean" as const })) };
    });
    let receipt;
    try { receipt = applyCanonWrite(f.io, claims, { action: "create", rel_path: path }, { writer: "loop", budget: budget() }); }
    finally { legacy.mockRestore(); }
    const bytes = readFileSync(join(f.vault, path));
    expect(receipt.taint).toBe("clean");
    expect(receipt.authority).toBe("model_inference");
    rebuildDerived(f.db, f.vault);
    const ctx = { db: f.db, vaultPath: f.vault, principal: OWNER };
    const index = loadCanon(ctx);
    expect(pageDecision(index, OWNER.grant, index.byPath.get(path)!)).toMatchObject({ allow: true, taint: "quoted" });
    const packet = await serveContextPacket(ctx, { query: "Bayesian", budget_tokens: 2000 });
    expect(packet.canon).toEqual([]);
    expect(packet.quoted.filter(chunk => "page_id" in chunk)).toHaveLength(1);
    expect(packet.data!.packet_md).toContain("taint=quoted");
    expect(packet.data!.packet_md).not.toContain("taint=clean");
    expect(readFileSync(join(f.vault, path))).toEqual(bytes);
    expect(getCanonReceipt(f.db, receipt.receipt_id)).toEqual(receipt);
    expect(world.claims.map(id => getClaim(f.db, id)!.taint)).toEqual(["clean", "clean", "clean"]);
  } finally { f.dispose(); }
});
