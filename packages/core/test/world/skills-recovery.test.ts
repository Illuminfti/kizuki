import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rebuildWorldLayer } from "../../src/derived";
import { exportVault, restoreVault } from "../../src/export";
import { openLedger } from "../../src/ledger/db";
import { runPurge } from "../../src/ledger/purge";
import { serveWorldView } from "../../src/serving/world-view";
import { skillFixture, PROCEDURE, WHEN } from "../helpers/skill-fixture";

test("procedure and outcome views rebuild from claims; export after purge restores no removed outcome", async () => {
  const f = await skillFixture(), root = mkdtempSync(join(tmpdir(), "skills-recovery-"));
  let restored: ReturnType<typeof openLedger> | undefined;
  try {
    await f.file(0, "outcome.self_report");
    const observation = await f.file(1, "outcome.observation");
    await f.file(2, "outcome.review", { result: "accepted" });
    const before = f.readProcedure();
    expect(before.taskUsefulness.status).toBe("observed");
    rebuildWorldLayer(f.db);
    const after = f.readProcedure();
    expect(after.steps.map(item => item.assertion.object)).toEqual(before.steps.map(item => item.assertion.object));
    expect(after.applicability.counterexamples.map(item => item.object)).toEqual(before.applicability.counterexamples.map(item => item.object));
    expect(after.taskUsefulness).toMatchObject({ status: "observed", evaluations: [{ result: "met", conditions: { environment: "synthetic-v1" } }] });
    const purged = await runPurge(f.db, f.ctx.vaultPath, { event_id: observation.event.event_id }, "outcome-recovery-purge");
    expect(purged.erased.database_sealed).toBe(true);
    exportVault(f.db, f.ctx.vaultPath, join(root, "backup"));
    restoreVault(join(root, "backup"), join(root, "restored"));
    restored = openLedger(join(root, "restored/.kizuki/kizuki.db"));
    expect(restored.query("SELECT 1 FROM events WHERE event_id=?").get(observation.event.event_id)).toBeNull();
    const result = serveWorldView({ ...f.ctx, db: restored, vaultPath: join(root, "restored") }, { operation: "outcome", subject: PROCEDURE, ...WHEN }).data;
    if (!("result" in result) || !("data" in result.result) || result.result.data.schema !== "kizuki.outcome-card/v1") throw new Error("missing restored outcomes");
    expect(result.result.data.goalAchieved).toBe(false);
    expect(result.result.data.stages.some(stage => stage.stage === "observed")).toBe(false);
    expect(result.result.data.evaluations.every(evaluation => evaluation.result === "unknown" && !evaluation.goalAchieved)).toBe(true);
  } finally { restored?.close(); f.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 120_000);
