import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { serveCorrect } from "../../src/serving/correct";
import { serveWorldView } from "../../src/serving/world-view";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { forecastJob } from "../../src/world/forecast/job";
import { situationV2Fixture, SITUATION_V2_WHEN } from "../helpers/situation-v2-fixture";

function afterSnapshot(db: Database, mutate: () => void): Database {
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
test("a stopped job does not mutate; final publication rechecks forecast input consent", async () => {
  const f = await situationV2Fixture();
  try {
    const ctx = { db: f.db, vaultPath: f.ctx.vaultPath, now: () => new Date().toISOString(), stopRequested: () => true, modelConfigured: false };
    await forecastJob.run(ctx);
    expect(f.db.query("SELECT 1 FROM world_forecasts").get()).toBeNull();
    expect(f.db.query("SELECT 1 FROM rail_cursors WHERE rail='forecast'").get()).toBeNull();
    await forecastJob.run({ ...ctx, stopRequested: () => false });
    const commitment = f.readSituation().commitments.find(c => c.due.some(d => d.object.kind === "literal" && d.object.value === "2026-10-24"))!.commitment;
    const input = { operation: "forecast", commitment, ...SITUATION_V2_WHEN };
    expect(serveWorldView(f.ctx, input).data).toHaveProperty("result.data.records");
    const db = afterSnapshot(f.db, () => revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "forecast-output-revoke" }));
    expect(serveWorldView({ ...f.ctx, db }, input).data).toEqual({ status: "not_found" });
  } finally { f.dispose(); }
}, 120_000);

test("an agent correction relay cannot manufacture independent owner forecast resolution", async () => {
  const f = await situationV2Fixture(undefined, { purposes: ["capture", "derive", "recall", "correction", "export"] });
  try {
    const run = () => forecastJob.run({ db: f.db, vaultPath: f.ctx.vaultPath, now: () => new Date().toISOString(), stopRequested: () => false, modelConfigured: false });
    await run();
    f.materialize("commitment:review");
    const agent = addAgent(f.db, "forecast-correction-relay", OWNER_AGENT_GRANT);
    const ctx = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    const target = f.readSituation(ctx).commitments.find(c => c.due.some(d => d.object.kind === "literal" && d.object.value === "2026-10-24"))!.statusBasis[0]!;
    const answer = await serveCorrect(ctx, { statement: "The owner says the review is completed.", target: { world_claim: target }, mode: "replace_object", object: { kind: "vocabulary", id: "commitment/done" } });
    expect(answer.data).toHaveProperty("receipt_id");
    await run();
    expect(f.db.query("SELECT 1 FROM world_forecast_resolutions").get()).toBeNull();
  } finally { f.dispose(); }
}, 120_000);
