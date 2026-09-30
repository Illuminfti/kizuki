import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATIONS, random, runCampaign } from "./harness";
import { ledger, prepare } from "./fixture";
import { checkVault } from "./invariants";

test("seeded SIGKILL smoke exercises every durable operation and checks recovery", async () => {
  const report = await runCampaign({ seed: 17, trials: 1, maxDelayMs: 4 });
  expect(report.trials.map(trial => trial.operation)).toEqual([...OPERATIONS]);
  expect(report.trials.every(trial => trial.killed)).toBe(true);
  expect(report.trials.filter(trial => trial.failure !== null)).toEqual([]);
}, 120_000);

test("a seed reproduces kill delays; invalid budgets refuse before creating vaults", async () => {
  const first = random(0), second = random(0);
  expect(Array.from({ length: 16 }, first)).toEqual(Array.from({ length: 16 }, second));
  await expect(runCampaign({ seed: -1, trials: 1 })).rejects.toThrow("seed_must_be_uint32");
  await expect(runCampaign({ seed: 1, trials: 0 })).rejects.toThrow("trials_must_be_1_to_10000");
  await expect(runCampaign({ seed: 1, trials: 1, maxDelayMs: 1001 })).rejects.toThrow("delay_must_be_0_to_1000");
  await expect(runCampaign({ seed: 1, trials: 1, operations: ["purge"], cut: "acknowledged" })).rejects.toThrow("acknowledged_cut_requires_repeated_writes");
});

test("the oracle refuses unrelated file changes and projection loss before rebuilding", async () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-chaos-oracle-"));
  const fixture = await prepare(root, "rebuild");
  const vault = join(root, "vault"), db = ledger(vault);
  try {
    await checkVault(db, vault, fixture);
    writeFileSync(join(vault, fixture.sentinelPath), fixture.sentinelBytes + "\nChanged independent text.\n");
    await expect(checkVault(db, vault, fixture)).rejects.toThrow("unrelated_file_changed");
    writeFileSync(join(vault, fixture.sentinelPath), fixture.sentinelBytes);
    db.query("DELETE FROM search_documents WHERE scope='canon'").run();
    await expect(checkVault(db, vault, fixture)).rejects.toThrow("rebuild_not_equal");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("SIGKILL after a real retrieval upsert reproduces the unknown-execution recovery hold", async () => {
  const report = await runCampaign({ seed: 17, trials: 1, operations: ["canon"], cut: "projection-started" });
  expect(report.trials[0]?.killed).toBe(true);
  expect(report.trials[0]?.failure).toBe("canon_recovery_needed");
  expect(report.ok).toBe(false);
}, 60_000);

test("acknowledged writes survive SIGKILL before the next write", async () => {
  for (const operation of ["capture", "canon", "correction", "undo"] as const) {
    const report = await runCampaign({ seed: 17, trials: 1, operations: [operation], cut: "acknowledged" });
    expect(report.ok).toBe(true);
    expect(report.trials[0]).toMatchObject({ killed: true, failure: null, acknowledgments: 1 });
  }
}, 120_000);

test.skip("DEFECT: local retrieval started operations cannot recover automatically after SIGKILL (requires fenced replay contract)", async () => {
  const report = await runCampaign({ seed: 17, trials: 1, operations: ["canon"], cut: "projection-started" });
  expect(report.ok).toBe(true);
});
