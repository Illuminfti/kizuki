import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openLedger } from "../../src/ledger/db";
import { inspectSourceGrant, revokeSourceGrant } from "../../src/ledger/source-grants";
import { serveWorldView } from "../../src/serving/world-view";
import { serveCorrect } from "../../src/serving/correct";
import { undoReceipt } from "../../src/canon/undo";
import { newReadFrame } from "../../src/world/pipeline/frame";
import { worldNamespace } from "../../src/world/references";
import { handleFor } from "../../src/world/relation";
import { collectConsolidationBasis } from "../../src/world/consolidation/basis";
import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";
import { correctionKit } from "../helpers/world-correct-kit";
import { cardFixture } from "./card-fixture";
import { tempVault } from "../helpers/vault";

test("complete-null prerequisite retains revision-one capture and revocation CAS", async () => {
  const f = await cardFixture(undefined, { model: EMPTY_SUMMARY_MODEL });
  try {
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    expect(inspectSourceGrant(f.db, f.sourceKey)?.revision).toBe(1);
    expect(f.card().coverage.status).toBe("complete_for_query");
    await f.write("concept.example", { kind: "literal", value: "A later visible example." });
    expect(f.card().coverage.gaps).toContain("stale_dependencies");
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    expect(f.card().coverage.status).toBe("complete_for_query");
    revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "summary-fixture-revoke" });
    expect(f.db.query("SELECT 1 FROM world_consolidation").get()).toBeNull();
  } finally { f.dispose(); }
});

function afterProjection(db: Database, mutate: () => void): Database {
  let fired = false;
  return new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === "transaction") return (run: () => unknown) => {
      const tx = target.transaction(run), finish = (result: unknown) => {
        if (!fired && !target.inTransaction && result !== null && typeof result === "object" && "withheld" in result) { fired = true; mutate(); }
        return result;
      };
      return Object.assign(() => finish(tx()), { immediate: () => finish(tx.immediate()) });
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("summary erasure after projection wins before public publication", async () => {
  const f = await cardFixture(undefined, { model: EMPTY_SUMMARY_MODEL });
  try {
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    expect(f.card().coverage.status).toBe("complete_for_query");
    const input = f.input("concept", { concept: f.find() });
    const db = afterProjection(f.db, () => f.db.exec("DELETE FROM world_consolidation"));
    const result = serveWorldView({ ...f.ctx, db }, input).data;
    expect(result).toMatchObject({ result: { status: "incomplete", data: { summary: null, coverage: { gaps: ["pending_consolidation"] } } } });
  } finally { f.dispose(); }
});

test("exact identity proof changes the summary basis even when an alternate path retains every member", async () => {
  const vault = tempVault(), db = openLedger(":memory:"), kit = correctionKit(db, vault.path);
  try {
    for (const id of ["one", "two", "three"]) await kit.declare("concept", `topic:${id}`, `Identity ${id}`);
    const refs = ["one", "two", "three"].map(id => kit.find(kit.ctx, "concept", id));
    const receipts: string[] = [];
    for (const [left, right] of [[0, 1], [1, 2], [0, 2]]) {
      const result = await serveCorrect(kit.ctx, { target: { world_claim: kit.card(kit.ctx, "concept", refs[left!]!).concept.classificationClaims[0] },
        mode: "merge_identity", object: { kind: "node", ref: refs[right!]! }, statement: `Synthetic identity link ${left} to ${right}.` });
      receipts.push(result.data!.receipt_id!);
    }
    const anchor = handleFor(db, kit.ref("topic:one"))!;
    const basis = () => db.transaction(() => collectConsolidationBasis(newReadFrame(kit.ctx, worldNamespace(db, kit.ctx.principal), { kind: "all" }), anchor, "concept")!).immediate();
    const before = basis();
    expect(before.members).toHaveLength(3);
    await undoReceipt({ db, vault_path: vault.path }, receipts.at(-1)!);
    const after = basis();
    expect(after.members).toEqual(before.members);
    expect(after.digest).not.toBe(before.digest);
    expect(after.eventIds.length).toBeLessThan(before.eventIds.length);
  } finally { db.close(); vault.dispose(); }
}, 120_000);
