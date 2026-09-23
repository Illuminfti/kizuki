import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { getCanonReceiptRecord, isErasedReceipt, listCanonReceipts, readReceiptsLog } from "../../src/canon/receipts";
import { recoverCanonWrites } from "../../src/canon/recovery";
import { asCanonRecoveryError } from "../../src/canon/recovery-failure";
import { CanonRecoveryError, inspectCanonRecovery, readCanonWriteIntent, type CanonRecoveryReason } from "../../src/canon/write-intent";
import { CANON_STAGE_QUARANTINE_PATH, CANON_STAGE_RECOVERIES_PATH, canonRecoveryNextStep, inspectCanonRecoveryDetail, readCanonRecoveryHold, readCanonStageRecoveries } from "../../src/canon/stage-recovery";
import { applyCanonWrite } from "../../src/canon/apply";
import { getClaim } from "../../src/claims/store";
import { correct } from "../../src/correction/correct";
import { worldCanonPath, worldClaimHandle } from "../../src/canon/world-materialization";
import { runPurge } from "../../src/ledger/purge";
import { initSearch } from "../../src/search";
import { initGraph } from "../../src/graph";
import { CanonFilesError } from "../../src/vault/canon-files";
import { VaultMutationError } from "../../src/vault/mutation-scope";
import { budget, canonFixture, putEvent, storeClaim, write } from "./helpers";
import { worldFixture } from "../serving/world-fixture";
import { tempVault } from "../helpers/vault";
import { CORE_SRC, killAfterStage, killAtCanonCreate, stagePattern } from "./stage-kill";
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

/** A file-backed ledger, so a real child process can share it. */
async function worldFileFixture() {
  const vault = tempVault("canon-world-stage-"); cleanup.push(vault.dispose);
  const dbPath = join(vault.path, ".kizuki", "kizuki.db");
  let db = openLedger(dbPath); cleanup.push(() => db.close());
  initSearch(db); initGraph(db);
  const world = await worldFixture(db), claims = world.claims.map(id => getClaim(db, id)!);
  const path = worldCanonPath(worldClaimHandle(db, claims[0]!.claim_id)!);
  return { vault: vault.path, dbPath, world, claims, path,
    get db() { return db; }, get io() { return { db, vault_path: vault.path }; },
    reopen() { db.close(); db = openLedger(dbPath); },
  };
}

function quarantineOf(receiptId: string, stage: "live" | "archive"): string {
  return `${CANON_STAGE_QUARANTINE_PATH}/${receiptId}/${stage}.stage`;
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
    const action = spec.classification === "foreign" ? "quarantined" : "removed";
    expect(records.map(item => [item.stage, item.classification, item.action, item.outcome])).toEqual([[spec.stage, spec.classification, action, "done"]]);
    // The record names the stage role only: no page path, stage name or content hash.
    const log = readFileSync(join(f.vault, CANON_STAGE_RECOVERIES_PATH), "utf8");
    for (const secret of [pending.receipt.page_path, stagePath, hashBytes(observed), hashBytes(staged), pending.receipt.after_hash]) expect(log).not.toContain(secret);
    expect(lstatSync(join(f.vault, CANON_STAGE_RECOVERIES_PATH)).mode & 0o777).toBe(0o600);
    if (spec.classification === "foreign") {
      expect(records[0]!.quarantine_path).toBe(quarantineOf(pending.receipt.receipt_id, spec.stage));
      const quarantine = join(f.vault, records[0]!.quarantine_path!);
      expect(readFileSync(quarantine)).toEqual(foreign);
      expect(lstatSync(quarantine).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(f.vault, CANON_STAGE_QUARANTINE_PATH, pending.receipt.receipt_id)).mode & 0o777).toBe(0o700);
      expect(inspectCanonRecoveryDetail(f.db, f.vault)).toMatchObject({ quarantined: 1, quarantine: { state: "private", files: 1 } });
    } else expect(records[0]!.quarantine_path).toBeNull();
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

test("a typed world write (intent v2) killed by a real process exit after its stage fsync completes with its after-image", async () => {
  const f = await worldFileFixture();
  killAtCanonCreate(f, `
    import { openLedger } from ${JSON.stringify(join(CORE_SRC, "ledger/db.ts"))};
    import { getClaim } from ${JSON.stringify(join(CORE_SRC, "claims/store.ts"))};
    import { applyCanonWrite } from ${JSON.stringify(join(CORE_SRC, "canon/apply.ts"))};
    import { createBudgetTracker } from ${JSON.stringify(join(CORE_SRC, "canon/budget.ts"))};
  `, `
    const db = openLedger(${JSON.stringify(f.dbPath)});
    const claims = ${JSON.stringify(f.claims.map(claim => claim.claim_id))}.map(id => getClaim(db, id));
    applyCanonWrite({ db, vault_path: ${JSON.stringify(f.vault)} }, claims, { action: "create", rel_path: ${JSON.stringify(f.path)} },
      { writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 10 }) });
  `, stagePattern(f.path));
  const intent = readCanonWriteIntent(f.db)!;
  expect(intent.version).toBe(2);
  expect(existsSync(join(f.vault, f.path))).toBe(false);
  expect(hashBytes(readFileSync(join(f.vault, intent.stages.live_stage)))).toBe(intent.receipt.after_hash);
  const report = recoverCanonWrites(f.io);
  expect(report.completed).toEqual([intent.receipt.receipt_id]);
  expect(report.stage_recoveries.map(item => [item.stage, item.classification, item.action, item.outcome])).toEqual([["live", "exact", "removed", "done"]]);
  expect(hashBytes(readFileSync(join(f.vault, f.path)))).toBe(intent.receipt.after_hash);
  expect(existsSync(join(f.vault, intent.stages.live_stage))).toBe(false);
  expect(readReceiptsLog(f.vault).filter(item => item.receipt_id === intent.receipt.receipt_id)).toHaveLength(1);
}, 90_000);

test("a typed erasure (intent v3) killed by a real process exit with its own stage on disk converges", async () => {
  const f = await worldFileFixture();
  const original = applyCanonWrite(f.io, f.claims, { action: "create", rel_path: f.path }, { writer: "loop", budget: budget() });
  // A native correction survives the purge, so the erasure publishes a rewritten page through its own stage.
  await correct(f.io, { statement: "Use prior odds and the likelihood ratio.", target: { claim_id: f.world.claims[2]! } });
  killAtCanonCreate(f, `
    import { openLedger } from ${JSON.stringify(join(CORE_SRC, "ledger/db.ts"))};
    import { runPurge } from ${JSON.stringify(join(CORE_SRC, "ledger/purge.ts"))};
  `, `
    const db = openLedger(${JSON.stringify(f.dbPath)});
    await runPurge(db, ${JSON.stringify(f.vault)}, { event_id: ${JSON.stringify(f.world.eventId)} }, "killed world erasure");
  `, stagePattern(f.path));
  const intent = readCanonWriteIntent(f.db)!;
  expect(intent.version).toBe(3);
  const staged = readFileSync(join(f.vault, intent.stages.live_stage));
  expect(hashBytes(staged)).toBe(intent.receipt.after_hash);
  const report = recoverCanonWrites(f.io);
  expect(report.completed).toEqual([intent.receipt.receipt_id]);
  expect(report.stage_recoveries.map(item => [item.stage, item.classification, item.action, item.outcome])).toEqual([["live", "exact", "removed", "done"]]);
  expect(existsSync(join(f.vault, intent.stages.live_stage))).toBe(false);
  const page = readFileSync(join(f.vault, f.path));
  expect(page).toEqual(staged);
  expect(page.toString("utf8")).not.toContain("Bayesian updating");
  expect(isErasedReceipt(getCanonReceiptRecord(f.db, original.receipt_id)!)).toBe(true);
  expect(inspectCanonRecovery(f.db).pending).toBe(false);
  expect(existsSync(join(f.vault, CANON_STAGE_QUARANTINE_PATH))).toBe(false);
}, 90_000);

test("a typed erasure (intent v3) erases foreign stage bytes instead of quarantining them", async () => {
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
  expect(inspectCanonRecoveryDetail(f.db, f.vault).stages[0]).toMatchObject({ classification: "foreign", action_on_next_start: "remove" });
  const report = recoverCanonWrites(f.io);
  expect(report.completed).toEqual([intent.receipt.receipt_id]);
  expect(report.stage_recoveries.map(item => [item.stage, item.classification, item.action, item.quarantine_path])).toEqual([["live", "foreign", "removed", null]]);
  expect(existsSync(join(f.vault, path))).toBe(false);
  expect(existsSync(join(f.vault, intent.stages.live_stage))).toBe(false);
  expect(existsSync(join(f.vault, CANON_STAGE_QUARANTINE_PATH))).toBe(false);
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

async function pendingWithForeignStage() {
  const f = await fixture();
  killAfterStage(f, f.claim.claim_id, 1);
  const pending = readCanonWriteIntent(f.db)!, foreign = Buffer.from("synthetic foreign bytes\n");
  writeFileSync(join(f.vault, pending.stages.live_stage), foreign, { mode: 0o600 });
  return { ...f, pending, foreign, receiptId: pending.receipt.receipt_id };
}

test("a taken quarantine name holds as quarantine_conflict; retries add no records and the stage stays", async () => {
  const f = await pendingWithForeignStage();
  const directory = join(f.vault, CANON_STAGE_QUARANTINE_PATH, f.receiptId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const path of [".kizuki/quarantine", CANON_STAGE_QUARANTINE_PATH]) chmodSync(join(f.vault, path), 0o700);
  const earlier = join(f.vault, quarantineOf(f.receiptId, "live"));
  writeFileSync(earlier, "an earlier quarantined copy\n", { mode: 0o600 });
  for (let attempt = 1; attempt <= 3; attempt++) {
    let error: unknown;
    try { recoverCanonWrites(f.io); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(CanonRecoveryError);
    expect((error as CanonRecoveryError).reason).toBe("quarantine_conflict");
  }
  expect(readFileSync(join(f.vault, f.pending.stages.live_stage))).toEqual(f.foreign);
  expect(readFileSync(earlier, "utf8")).toBe("an earlier quarantined copy\n");
  // One planned record, never a false "done" line per retry.
  expect(readCanonStageRecoveries(f.vault).map(item => [item.receipt_id, item.stage, item.action, item.outcome]))
    .toEqual([[f.receiptId, "live", "quarantined", "planned"]]);
  const detail = inspectCanonRecoveryDetail(f.db, f.vault);
  expect(detail).toMatchObject({ reason: "quarantine_conflict", last_attempt: { reason: "quarantine_conflict", attempts: 3 } });
  expect(detail.next).toContain(`${CANON_STAGE_QUARANTINE_PATH}/${f.receiptId}/`);
  expect(detail.next).not.toContain("completes automatically");
  expect(detail.next).not.toContain("not a private regular file");
  // After the owner moves the earlier copy away, the planned record completes.
  rmSync(earlier);
  expect(recoverCanonWrites(f.io).completed).toEqual([f.receiptId]);
  expect(readCanonStageRecoveries(f.vault).map(item => [item.action, item.outcome])).toEqual([["quarantined", "done"]]);
  expect(readFileSync(earlier)).toEqual(f.foreign);
}, 60_000);

test("a quarantine directory with the wrong mode holds as quarantine_unsafe before any record or move", async () => {
  const f = await pendingWithForeignStage();
  mkdirSync(join(f.vault, ".kizuki/quarantine"), { mode: 0o755 }); chmodSync(join(f.vault, ".kizuki/quarantine"), 0o755);
  expect(() => recoverCanonWrites(f.io)).toThrow("quarantine_unsafe");
  expect(readFileSync(join(f.vault, f.pending.stages.live_stage))).toEqual(f.foreign);
  expect(readCanonStageRecoveries(f.vault)).toEqual([]);
  const detail = inspectCanonRecoveryDetail(f.db, f.vault);
  expect(detail).toMatchObject({ pending: true, reason: "quarantine_unsafe", quarantine: { state: "unsafe" } });
  expect(detail.next).toContain("chmod 700");
  expect(detail.next).not.toContain("completes automatically");
  chmodSync(join(f.vault, ".kizuki/quarantine"), 0o700);
  expect(recoverCanonWrites(f.io).completed).toEqual([f.receiptId]);
  expect(inspectCanonRecoveryDetail(f.db, f.vault).quarantine).toEqual({ state: "private", files: 1 });
}, 60_000);

test("a quarantine path that is not a directory is reported unsafe by inspection", async () => {
  const f = await fixture();
  writeFileSync(join(f.vault, ".kizuki/quarantine"), "not a directory", { mode: 0o600 });
  expect(inspectCanonRecoveryDetail(f.db, f.vault).quarantine).toEqual({ state: "unsafe", files: 0 });
});

test("an inspection failure is reported as inspection_unavailable, never as an automatic completion", async () => {
  const f = await pendingWithForeignStage();
  const mode = statSync(f.vault).mode & 0o7777;
  chmodSync(f.vault, 0o777);
  try {
    const detail = inspectCanonRecoveryDetail(f.db, f.vault);
    expect(detail).toMatchObject({ pending: true, reason: "inspection_unavailable", stages: [] });
    expect(detail.next).not.toContain("completes automatically");
  } finally { chmodSync(f.vault, mode); }
});

test("every reason that never clears by itself names a real next step", () => {
  const steps: [CanonRecoveryReason, string][] = [
    ["receipt_stream_refused", ".kizuki/receipts/promotions.jsonl"],
    ["write_refused", "kizuki recover --json"],
    ["intent_invalid", "restore --from"],
    ["receipt_changed", "restore --from"],
    ["historical_orphan", "recorded receipt"],
    ["quarantine_conflict", "quarantine"],
    ["quarantine_unsafe", "chmod 700"],
    ["storage_full", "free space"],
    ["storage_refused", "write access"],
    ["writer_busy", "another kizuki process"],
    ["inspection_unavailable", "kizuki recover --json"],
  ];
  for (const [reason, expected] of steps) {
    const next = canonRecoveryNextStep(reason, []);
    expect({ reason, automatic: next.includes("completes automatically") }).toEqual({ reason, automatic: false });
    expect(next).toContain(expected);
  }
  expect(new Set(steps.map(([reason]) => canonRecoveryNextStep(reason, []))).size).toBe(steps.length);
  expect(canonRecoveryNextStep(null, [])).toContain("completes automatically");
});

test("raw storage errors and a busy writer become typed recovery reasons", () => {
  const errno = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });
  const cases: [unknown, CanonRecoveryReason][] = [
    [errno("ENOSPC"), "storage_full"],
    [errno("EDQUOT"), "storage_full"],
    [new CanonFilesError("io", undefined, { cause: errno("ENOSPC") }), "storage_full"],
    [errno("EACCES"), "storage_refused"],
    [new CanonFilesError("io", undefined, { cause: errno("EROFS") }), "storage_refused"],
    [new VaultMutationError("writer_busy"), "writer_busy"],
    [new CanonFilesError("io"), "write_refused"],
  ];
  for (const [error, reason] of cases) {
    const typed = asCanonRecoveryError(error, "synthetic-receipt");
    expect(typed).toBeInstanceOf(CanonRecoveryError);
    expect({ reason: typed!.reason, receipt: typed!.receipt_id }).toEqual({ reason, receipt: "synthetic-receipt" });
  }
  expect(asCanonRecoveryError(new Error("unrelated"), null)).toBeNull();
});

test("the record log and hold file never write through a symlink or a planted temporary", async () => {
  const f = await pendingWithForeignStage();
  const outside = join(f.vault, "synthetic-outside-target"), planted = join(f.vault, "synthetic-planted-target");
  writeFileSync(outside, "outside bytes\n", { mode: 0o600 });
  writeFileSync(planted, "planted bytes\n", { mode: 0o600 });
  symlinkSync(outside, join(f.vault, CANON_STAGE_RECOVERIES_PATH));
  symlinkSync(planted, join(f.vault, ".kizuki/.canon-recovery-hold.json.tmp"));
  let error: unknown;
  try { recoverCanonWrites(f.io); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(CanonRecoveryError);
  expect((error as CanonRecoveryError).reason).toBe("write_refused");
  expect(readFileSync(outside, "utf8")).toBe("outside bytes\n");
  expect(readFileSync(planted, "utf8")).toBe("planted bytes\n");
  expect(readlinkSync(join(f.vault, CANON_STAGE_RECOVERIES_PATH))).toBe(outside);
  // The foreign stage is untouched, and no hold record was written through the planted name.
  expect(readFileSync(join(f.vault, f.pending.stages.live_stage))).toEqual(f.foreign);
  expect(existsSync(join(f.vault, ".kizuki/canon-recovery-hold.json"))).toBe(false);
  expect(inspectCanonRecovery(f.db).pending).toBe(true);
}, 60_000);
