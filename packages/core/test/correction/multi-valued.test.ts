import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCanonWrite, createBudgetTracker, resolveTarget, undoReceipt } from "../../src/canon";
import { getClaim, listClaims, listSupersessions } from "../../src/claims/store";
import { correct } from "../../src/correction/correct";
import { canonFixture, putEvent, storeClaim } from "../canon/helpers";

async function fixture() {
  const f = canonFixture(), event = putEvent(f.db);
  const prior = await storeClaim(f.db, event, { predicate: "preference.prefers", object: "rushed reviews", body: "Grace prefers rushed reviews." });
  const other = await storeClaim(f.db, event, { predicate: "preference.prefers", object: "written notes", body: "Grace prefers written notes." });
  const receipt = applyCanonWrite(f.io, [prior, other], resolveTarget(f.io, prior), { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 4 }) });
  return { ...f, prior, other, page: receipt.page_path, before: readFileSync(join(f.vault, receipt.page_path), "utf8") };
}
test("ordinary correct retires a multi-valued claim by exact target and supports undo", async () => {
  const f = await fixture(); try {
    const result = await correct(f.io, { statement: "Grace prefers careful reviews.", target: { claim_id: f.prior.claim_id } });
    expect(result.superseded.map(row => row.claim_id)).toEqual([f.prior.claim_id]);
    expect(getClaim(f.db, f.prior.claim_id)?.status).toBe("superseded");
    expect(getClaim(f.db, f.other.claim_id)?.status).toBe("live");
    expect(result.receipt_id).not.toBeNull();
    const after = readFileSync(join(f.vault, f.page), "utf8");
    expect(after).toContain("Grace prefers written notes.");
    expect(after).toContain("Grace prefers careful reviews.");
    expect(after).not.toContain("Grace prefers rushed reviews.");
    await undoReceipt(f.io, result.receipt_id!);
    expect(getClaim(f.db, f.prior.claim_id)?.status).toBe("live");
    expect(getClaim(f.db, f.other.claim_id)?.status).toBe("live");
    expect(readFileSync(join(f.vault, f.page), "utf8")).toBe(f.before);
  } finally { f.dispose(); }
});
test("ordinary exact multi-valued retirement rolls back the replacement with its journal", async () => {
  const f = await fixture(); try {
    const before = listClaims(f.db);
    f.db.exec("CREATE TRIGGER fail_exact_retirement BEFORE INSERT ON claim_supersessions BEGIN SELECT RAISE(ABORT, 'fixture journal failure'); END");
    await expect(correct(f.io, { statement: "Grace prefers careful reviews.", target: { claim_id: f.prior.claim_id } })).rejects.toThrow();
    expect(listClaims(f.db)).toEqual(before);
    expect(listSupersessions(f.db)).toEqual([]);
  } finally { f.dispose(); }
});

test("an explicit claim key still replaces its whole group, while exact replay reuses its result", async () => {
  const f = await fixture(); try {
    const input = { statement: "Grace prefers careful reviews.", target: { claim_key: f.prior.claim_key! } };
    const result = await correct(f.io, input);
    expect(result.superseded.map(row => row.claim_id).sort()).toEqual([f.prior.claim_id, f.other.claim_id].sort());
    expect(getClaim(f.db, f.prior.claim_id)?.status).toBe("superseded");
    expect(getClaim(f.db, f.other.claim_id)?.status).toBe("superseded");
    const before = listClaims(f.db);
    const replay = await correct(f.io, input);
    expect(replay.claim_ids).toEqual(result.claim_ids);
    expect(replay.event_id).toBe(result.event_id);
    expect(listClaims(f.db)).toEqual(before);
  } finally { f.dispose(); }
});

test("a non-relay correction refuses an owner multi-valued target before native capture", async () => {
  const f = await fixture(); try {
    const first = await correct(f.io, { statement: "Grace prefers careful reviews.", target: { claim_id: f.prior.claim_id } });
    const before = listClaims(f.db);
    const events = f.db.query("SELECT event_id FROM events ORDER BY event_id").all();
    await expect(correct({ ...f.io, relay_owner_corrections: false }, { statement: "Grace prefers immediate reviews.", target: { claim_id: first.claim_ids[0]! } })).rejects.toMatchObject({ code: "below_authority" });
    expect(listClaims(f.db)).toEqual(before);
    expect(f.db.query("SELECT event_id FROM events ORDER BY event_id").all()).toEqual(events);
    expect(getClaim(f.db, f.other.claim_id)?.status).toBe("live");
  } finally { f.dispose(); }
});
