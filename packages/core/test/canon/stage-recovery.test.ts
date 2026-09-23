import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { listCanonReceipts, readReceiptsLog } from "../../src/canon/receipts";
import { recoverCanonWrites } from "../../src/canon/recovery";
import { CanonRecoveryError, inspectCanonRecovery, readCanonWriteIntent } from "../../src/canon/write-intent";
import { CANON_STAGE_QUARANTINE_PATH, inspectCanonRecoveryDetail, readCanonRecoveryHold, readCanonStageRecoveries } from "../../src/canon/stage-recovery";
import { applyCanonWrite } from "../../src/canon/apply";
import { getClaim } from "../../src/claims/store";
import { worldCanonPath, worldClaimHandle } from "../../src/canon/world-materialization";
import { runPurge } from "../../src/ledger/purge";
import { budget, canonFixture, putEvent, storeClaim, write } from "./helpers";
import { worldFixture } from "../serving/world-fixture";
import { tempVault } from "../helpers/vault";
import { killAfterStage } from "./stage-kill";
import { hashBytes } from "../../src/vault/write";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

async function fixture() {
  const vault = tempVault("canon-stage-"); cleanup.push(vault.dispose);
  const dbPath = join(vault.path, ".kizuki", "kizuki.db");
  let db = openLedger(dbPath); cleanup.push(() => db.close());
  const eventId = putEvent(db), claim = await storeClaim(db, eventId);
  return { vault: vault.path, dbPath, eventId, claim,
    get db() { return db; }, get io() { return { db, vault_path: vault.path }; },
    reopen() { db.close(); db = openLedger(dbPath); },
  };
}

type Phase = "torn_stage" | "complete_archive_stage" | "torn_archive_stage" | "revision_stage_before_replace" | "foreign_stage";
const phases: Record<Phase, { edit: boolean; create: number; stage: "live" | "archive"; classification: "exact" | "prefix" | "foreign" }> = {
  torn_stage: { edit: false, create: 1, stage: "live", classification: "prefix" },
  complete_archive_stage: { edit: true, create: 1, stage: "archive", classification: "exact" },
  torn_archive_stage: { edit: true, create: 1, stage: "archive", classification: "prefix" },
  revision_stage_before_replace: { edit: true, create: 2, stage: "live", classification: "exact" },
  foreign_stage: { edit: false, create: 1, stage: "live", classification: "foreign" },
};

for (const [phase, spec] of Object.entries(phases) as [Phase, typeof phases[Phase]][]) {
  test(`a kill with a ${phase} converges on the next recovery with the original receipt`, async () => {
    const f = await fixture();
    let claim = f.claim;
    if (spec.edit) {
      write(f.io, f.claim);
      claim = await storeClaim(f.db, f.eventId, { kind: "edit", predicate: null, object: null, body: "Grace studies astronomy.", frontmatter: {} });
    }
    const prior = listCanonReceipts(f.db);
    killAfterStage(f, claim.claim_id, spec.create);
    const pending = readCanonWriteIntent(f.db)!;
    const stagePath = spec.stage === "live" ? pending.stages.live_stage : pending.stages.archive_stage!;
    const absolute = join(f.vault, stagePath), staged = readFileSync(absolute);
    const foreign = Buffer.from("synthetic foreign stage bytes\n");
    if (spec.classification === "prefix") truncateSync(absolute, Math.floor(staged.length / 2));
    if (spec.classification === "foreign") writeFileSync(absolute, foreign);
    const observed = readFileSync(absolute);
    const detail = inspectCanonRecoveryDetail(f.db, f.vault);
    expect(detail.stages.find(item => item.stage === spec.stage)).toMatchObject({ present: true, classification: spec.classification,
      action_on_next_start: spec.classification === "foreign" ? "quarantine" : "remove" });
    expect(detail.next).toContain("completes automatically");

    const report = recoverCanonWrites(f.io);
    expect(report.completed).toEqual([pending.receipt.receipt_id]);
    expect(inspectCanonRecovery(f.db).pending).toBe(false);
    expect(listCanonReceipts(f.db)).toEqual([...prior, pending.receipt]);
    expect(readReceiptsLog(f.vault)).toEqual([...prior, pending.receipt]);
    expect(hashBytes(readFileSync(join(f.vault, pending.receipt.page_path)))).toBe(pending.receipt.after_hash);
    expect(existsSync(absolute)).toBe(false);
    const records = readCanonStageRecoveries(f.vault, pending.receipt.receipt_id);
    expect(records).toEqual(report.stage_recoveries);
    expect(records.map(item => [item.stage, item.path, item.classification, item.bytes, item.sha256])).toEqual([[spec.stage, stagePath, spec.classification, observed.length, hashBytes(observed)]]);
    if (spec.classification === "foreign") {
      const quarantine = join(f.vault, records[0]!.quarantine_path!);
      expect(records[0]!.action).toBe("quarantined");
      expect(readFileSync(quarantine)).toEqual(foreign);
      expect(lstatSync(quarantine).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(f.vault, CANON_STAGE_QUARANTINE_PATH, pending.receipt.receipt_id)).mode & 0o777).toBe(0o700);
      expect(inspectCanonRecoveryDetail(f.db, f.vault).quarantined).toBe(1);
    } else expect(records[0]!.action).toBe("removed");
    expect(recoverCanonWrites(f.io)).toMatchObject({ completed: [], pending: false, stage_recoveries: [] });
  }, 60_000);
}

for (const kind of ["symlink", "directory"] as const) {
  test(`an unsafe ${kind} stage is left untouched and holds the write with a typed reason`, async () => {
    const f = await fixture();
    killAfterStage(f, f.claim.claim_id, 1);
    const pending = readCanonWriteIntent(f.db)!, absolute = join(f.vault, pending.stages.live_stage);
    rmSync(absolute);
    const target = join(f.vault, "synthetic-outside");
    writeFileSync(target, "synthetic outside bytes", { mode: 0o600 });
    if (kind === "symlink") symlinkSync(target, absolute);
    else mkdirSync(absolute, { mode: 0o700 });
    const detail = inspectCanonRecoveryDetail(f.db, f.vault);
    expect(detail.stages[0]).toMatchObject({ stage: "live", present: true, classification: "unsafe", action_on_next_start: "hold" });
    expect(detail.next).toContain("move it out of the vault");
    let error: unknown;
    try { recoverCanonWrites(f.io); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CanonRecoveryError);
    expect((error as CanonRecoveryError).reason).toBe("stage_custody_unknown");
    expect((error as CanonRecoveryError).receipt_id).toBe(pending.receipt.receipt_id);
    expect(inspectCanonRecovery(f.db).pending).toBe(true);
    if (kind === "symlink") expect(readlinkSync(absolute)).toBe(target);
    else expect(readdirSync(absolute)).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("synthetic outside bytes");
    expect(existsSync(join(f.vault, pending.receipt.page_path))).toBe(false);
    expect(readCanonStageRecoveries(f.vault)).toEqual([]);
    expect(readCanonRecoveryHold(f.vault)).toMatchObject({ reason: "stage_custody_unknown", receipt_id: pending.receipt.receipt_id, attempts: 1 });
    expect(() => recoverCanonWrites(f.io)).toThrow("stage_custody_unknown");
    expect(inspectCanonRecoveryDetail(f.db, f.vault).last_attempt).toMatchObject({ reason: "stage_custody_unknown", attempts: 2 });
    // Once the owner moves the entry away, the next attempt completes and clears the hold.
    rmSync(absolute, { recursive: true });
    expect(recoverCanonWrites(f.io).completed).toEqual([pending.receipt.receipt_id]);
    expect(readCanonRecoveryHold(f.vault)).toBeNull();
  }, 60_000);
}

test("a typed world write (intent v2) killed between stage fsync and publish completes with its after-image", async () => {
  const f = canonFixture(); cleanup.push(f.dispose);
  const world = await worldFixture(f.db), claims = world.claims.map(id => getClaim(f.db, id)!);
  const path = worldCanonPath(worldClaimHandle(f.db, claims[0]!.claim_id)!);
  f.db.exec("CREATE TRIGGER interrupt_world_write BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt interruption'); END");
  expect(() => applyCanonWrite(f.io, claims, { action: "create", rel_path: path }, { writer: "loop", budget: budget() })).toThrow("fixture receipt interruption");
  f.db.exec("DROP TRIGGER interrupt_world_write");
  const intent = readCanonWriteIntent(f.db)!;
  expect(intent.version).toBe(2);
  // Reconstruct the kill point: the fsynced stage holds the after-image and the page is absent.
  renameSync(join(f.vault, path), join(f.vault, intent.stages.live_stage));
  const report = recoverCanonWrites(f.io);
  expect(report.completed).toEqual([intent.receipt.receipt_id]);
  expect(report.stage_recoveries.map(item => [item.stage, item.classification, item.action])).toEqual([["live", "exact", "removed"]]);
  expect(hashBytes(readFileSync(join(f.vault, path)))).toBe(intent.receipt.after_hash);
  expect(existsSync(join(f.vault, intent.stages.live_stage))).toBe(false);
  expect(readReceiptsLog(f.vault).filter(item => item.receipt_id === intent.receipt.receipt_id)).toHaveLength(1);
}, 60_000);

test("a typed erasure (intent v3) quarantines foreign stage bytes and still erases the page", async () => {
  const f = canonFixture(); cleanup.push(f.dispose);
  const world = await worldFixture(f.db), claims = world.claims.map(id => getClaim(f.db, id)!);
  const path = worldCanonPath(worldClaimHandle(f.db, claims[0]!.claim_id)!);
  applyCanonWrite(f.io, claims, { action: "create", rel_path: path }, { writer: "loop", budget: budget() });
  f.db.exec("CREATE TRIGGER interrupt_world_erasure BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(ABORT,'fixture receipt interruption'); END");
  await expect(runPurge(f.db, f.vault, { event_id: world.eventId }, "interrupted world erasure")).rejects.toThrow("fixture receipt interruption");
  f.db.exec("DROP TRIGGER interrupt_world_erasure");
  const intent = readCanonWriteIntent(f.db)!;
  expect(intent.version).toBe(3);
  const foreign = Buffer.from("synthetic foreign erasure stage\n");
  writeFileSync(join(f.vault, intent.stages.live_stage), foreign, { mode: 0o600 });
  const report = recoverCanonWrites(f.io);
  expect(report.completed).toEqual([intent.receipt.receipt_id]);
  expect(report.stage_recoveries).toHaveLength(1);
  expect(report.stage_recoveries[0]).toMatchObject({ stage: "live", classification: "foreign", action: "quarantined" });
  expect(readFileSync(join(f.vault, report.stage_recoveries[0]!.quarantine_path!))).toEqual(foreign);
  expect(existsSync(join(f.vault, path))).toBe(false);
  expect(existsSync(join(f.vault, intent.stages.live_stage))).toBe(false);
}, 60_000);

test("a file-level copy with a pending write refuses before any page or stage action", async () => {
  const f = await fixture();
  killAfterStage(f, f.claim.claim_id, 1);
  const pending = readCanonWriteIntent(f.db)!, staged = readFileSync(join(f.vault, pending.stages.live_stage));
  // Replace the receipt log with a same-bytes copy: a new inode, as cp -a or a restore produces.
  const log = join(f.vault, ".kizuki/receipts/promotions.jsonl"), bytes = readFileSync(log);
  rmSync(log); writeFileSync(log, bytes, { mode: 0o600 });
  let error: unknown;
  try { recoverCanonWrites(f.io); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(CanonRecoveryError);
  expect((error as CanonRecoveryError).reason).toBe("receipt_stream_changed");
  expect(readFileSync(join(f.vault, pending.stages.live_stage))).toEqual(staged);
  expect(existsSync(join(f.vault, pending.receipt.page_path))).toBe(false);
  expect(readCanonStageRecoveries(f.vault)).toEqual([]);
  expect(inspectCanonRecoveryDetail(f.db, f.vault)).toMatchObject({ pending: true, reason: "receipt_stream_changed",
    next: expect.stringContaining("copied at file level") });
}, 60_000);
