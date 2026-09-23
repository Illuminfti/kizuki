import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openLedger } from "../../../core/src/ledger/db";
import { worldFixture } from "../../../core/test/serving/world-fixture";
import { getClaim } from "../../../core/src/claims/store";
import { applyCanonWrite } from "../../../core/src/canon/apply";
import { createBudgetTracker } from "../../../core/src/canon/budget";
import { worldClaimHandle, worldCanonPath } from "../../../core/src/canon/world-materialization";
import { runPurge } from "../../../core/src/ledger/purge";
import { createHelpers } from "../helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

test("doctor reads the erased record a typed purge leaves as a reconciled receipt", async () => {
  const setup = tempVault();
  const db = openLedger(join(setup.vault, ".kizuki/kizuki.db"));
  try {
    const world = await worldFixture(db);
    const claims = world.claims.map(id => getClaim(db, id)!);
    const path = worldCanonPath(worldClaimHandle(db, claims[0]!.claim_id)!);
    applyCanonWrite({ db, vault_path: setup.vault }, claims, { action: "create", rel_path: path },
      { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 10 }) });
    expect((await runPurge(db, setup.vault, { event_id: world.eventId }, "erase world fixture")).rewritten).toHaveLength(1);
  } finally { db.close(); }
  const doctor = runCli(setup.env, "doctor", "--json");
  const report = JSON.parse(doctor.stdout) as { data: { receipts: number; orphans: string[] } };
  expect(report.data.receipts).toBeGreaterThan(0);
  expect(report.data.orphans).toEqual([]);
  expect(doctor.stdout).not.toContain("orphan receipt");
});
