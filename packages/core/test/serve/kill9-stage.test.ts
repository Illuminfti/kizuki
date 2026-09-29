import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { runServeDaemon } from "../../src/serve/daemon";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { listRunReceipts } from "../../src/serve/receipts";
import { CANON_INTENT_SLA_SECONDS } from "../../src/serve/canon-intent-health";
import { listCanonReceipts, readReceiptsLog } from "../../src/canon/receipts";
import { inspectCanonRecovery, readCanonWriteIntent } from "../../src/canon/write-intent";
import { CANON_STAGE_QUARANTINE_PATH, readCanonStageRecoveries } from "../../src/canon/stage-recovery";
import { hashBytes } from "../../src/vault/write";
import { putEvent, storeClaim } from "../canon/helpers";
import { killAfterStage } from "../canon/stage-kill";
import { tempVault } from "../helpers/vault";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

/** A real child process dies right after the canon stage is created and synced. */
async function killedAtStageCreation() {
  const vault = tempVault("kill-stage-"); cleanup.push(vault.dispose);
  const dbPath = join(vault.path, ".kizuki", "kizuki.db");
  let db = openLedger(dbPath); cleanup.push(() => db.close());
  const claim = await storeClaim(db, putEvent(db));
  killAfterStage({ dbPath, vault: vault.path, reopen() { db.close(); db = openLedger(dbPath); } }, claim.claim_id, 1);
  const intent = readCanonWriteIntent(db)!;
  return { vault: vault.path, get db() { return db; }, intent, stage: join(vault.path, intent.stages.live_stage), page: join(vault.path, intent.receipt.page_path) };
}

const restart = (f: Awaited<ReturnType<typeof killedAtStageCreation>>) => {
  const lines: string[] = [];
  const result = runServeDaemon(f.db, f.vault, { once: true, http: false, rails: ["doctor-sweep"], log: line => lines.push(line) });
  return result.then(done => ({ done, lines }));
};

for (const kind of ["exact", "prefix"] as const) {
  test(`a ${kind} stage left by a kill at stage creation is removed and the write completes on restart`, async () => {
    const f = await killedAtStageCreation();
    if (kind === "prefix") truncateSync(f.stage, Math.floor(readFileSync(f.stage).length / 2));
    expect(existsSync(f.page)).toBe(false);
    const { lines } = await restart(f);
    expect(lines).toEqual([]);
    expect(inspectCanonRecovery(f.db).pending).toBe(false);
    expect(hashBytes(readFileSync(f.page))).toBe(f.intent.receipt.after_hash);
    expect(existsSync(f.stage)).toBe(false);
    expect(listCanonReceipts(f.db).map(item => item.receipt_id)).toEqual([f.intent.receipt.receipt_id]);
    expect(readReceiptsLog(f.vault).map(item => item.receipt_id)).toEqual([f.intent.receipt.receipt_id]);
    expect(readCanonStageRecoveries(f.vault).map(item => [item.classification, item.action])).toEqual([[kind, "removed"]]);
  }, 60_000);
}

test("a foreign stage left at the stage name is quarantined, not published, and the write completes", async () => {
  const f = await killedAtStageCreation();
  const foreign = Buffer.from("synthetic foreign bytes\n");
  writeFileSync(f.stage, foreign);
  const { lines } = await restart(f);
  expect(lines).toEqual([]);
  expect(inspectCanonRecovery(f.db).pending).toBe(false);
  expect(hashBytes(readFileSync(f.page))).toBe(f.intent.receipt.after_hash);
  expect(existsSync(f.stage)).toBe(false);
  const [record] = readCanonStageRecoveries(f.vault);
  expect(record).toMatchObject({ classification: "foreign", action: "quarantined" });
  expect(readFileSync(join(f.vault, record!.quarantine_path!))).toEqual(foreign);
  expect(readdirSync(join(f.vault, CANON_STAGE_QUARANTINE_PATH))).toEqual([f.intent.receipt.receipt_id]);
}, 60_000);

for (const kind of ["symlink", "hardlink"] as const) {
  test(`a ${kind} at the stage name holds the write while the daemon keeps running, and doctor flags it once stale`, async () => {
    const f = await killedAtStageCreation();
    const outside = join(f.vault, "synthetic-outside");
    if (kind === "symlink") { renameSync(f.stage, outside); symlinkSync(outside, f.stage); }
    else linkSync(f.stage, outside);
    const { done, lines } = await restart(f);
    expect(done.receipts).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "canon_recovery_held", reason: "stage_custody_unknown", receipt_id: f.intent.receipt.receipt_id });
    expect(listRunReceipts(f.db).map(item => item.rail)).toEqual(["doctor-sweep"]);
    expect(inspectCanonRecovery(f.db)).toMatchObject({ pending: true, receipt_id: f.intent.receipt.receipt_id });
    expect(existsSync(f.page)).toBe(false);
    expect(lstatSync(f.stage).isSymbolicLink()).toBe(kind === "symlink");
    expect(readCanonStageRecoveries(f.vault)).toEqual([]);

    const receiptAt = Date.parse(f.intent.receipt.at);
    const soon = new Date(receiptAt + 60_000).toISOString();
    const stale = new Date(receiptAt + (CANON_INTENT_SLA_SECONDS + 60) * 1000).toISOString();
    expect(inspectServeDoctor(f.db, f.vault, { now: soon }).failures.filter(item => item.startsWith("canon write intent"))).toEqual([]);
    expect(inspectServeDoctor(f.db, f.vault, { now: stale }).failures).toContain(
      `canon write intent ${f.intent.receipt.receipt_id} pending for ${CANON_INTENT_SLA_SECONDS + 60}s (SLA ${CANON_INTENT_SLA_SECONDS}s); run: kizuki recover --json`);

    // Once the owner clears the entry, the next start completes the same write.
    rmSync(f.stage);
    await restart(f);
    expect(inspectCanonRecovery(f.db).pending).toBe(false);
    expect(hashBytes(readFileSync(f.page))).toBe(f.intent.receipt.after_hash);
    expect(inspectServeDoctor(f.db, f.vault, { now: stale }).failures.filter(item => item.startsWith("canon write intent"))).toEqual([]);
  }, 60_000);
}

test("doctor reports an unreadable canon write intent with the same next step", async () => {
  const f = await killedAtStageCreation();
  f.db.query("UPDATE canon_write_intents SET digest = ?").run("0".repeat(64));
  const failures = inspectServeDoctor(f.db, f.vault).failures.filter(item => item.startsWith("canon write intent"));
  expect(failures).toEqual(["canon write intent unreadable (intent_invalid); run: kizuki recover --json"]);
}, 60_000);
