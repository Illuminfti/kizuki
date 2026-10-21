import { expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../../packages/core/src/agents";
import { serveContextPacket } from "../../../packages/core/src/serving/packet";
import { issueWorldRef, worldNamespace } from "../../../packages/core/src/world/references";
import { cardFixture } from "../../../packages/core/test/world/card-fixture";
import { baselineReadState, baselineReadUnchanged } from "./read-state";

test("baseline permits only exact current-principal typed issuance and still rejects evidence, grant and canon mutations", async () => {
  const f = await cardFixture(undefined, { purposes: ["capture", "derive", "recall"] });
  try {
    const agent = addAgent(f.db, "baseline-reader", { ...OWNER_AGENT_GRANT, rate_limit_per_minute: 1000 });
    const ctx = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const before = baselineReadState(ctx);
    await serveContextPacket(ctx, { purpose: "recall", query: "Bayesian", budget_tokens: 2000 });
    expect(baselineReadUnchanged(before, ctx)).toBe(true);
    const stable = baselineReadState(ctx), rollback = new Error("synthetic rollback");
    for (const sql of [
      "UPDATE claims SET body=body||' tampered'",
      "UPDATE events SET text=text||' tampered'",
      "UPDATE agent_grants SET ceiling='public'",
    ]) {
      expect(() => f.db.transaction(() => {
        f.db.exec(sql);
        expect(baselineReadUnchanged(stable, ctx)).toBe(false);
        throw rollback;
      })()).toThrow(rollback.message);
      expect(baselineReadUnchanged(stable, ctx)).toBe(true);
    }
    const file = join(f.ctx.vaultPath, "tampered-canon.md");
    writeFileSync(file, "unreceipted change\n");
    expect(baselineReadUnchanged(stable, ctx)).toBe(false);
    rmSync(file);
    expect(baselineReadUnchanged(stable, ctx)).toBe(true);
    if (f.definition.stored.outcome !== "stored") throw new Error("definition missing");
    const claimId = f.definition.stored.claim.claim_id;
    f.db.transaction(() => issueWorldRef(f.db, worldNamespace(f.db, f.ctx.principal), "claim", claimId))();
    expect(baselineReadUnchanged(stable, ctx)).toBe(false);
  } finally { f.dispose(); }
}, 120000);
