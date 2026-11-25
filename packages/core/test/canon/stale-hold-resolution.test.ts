import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { getCanonReceipt, listCanonReceipts, readReceiptsLog, RECEIPTS_PATH } from "../../src/canon/receipts";
import { recoverCanonWrites, resolveStaleCanonHold } from "../../src/canon/recovery";
import {
  CANON_RECOVERY_HOLD_PATH,
  CANON_RECOVERY_RESOLUTIONS_PATH,
  readCanonRecoveryHold,
  readCanonRecoveryResolutions,
} from "../../src/canon/stage-recovery";
import { inspectCanonRecovery, readCanonWriteIntent } from "../../src/canon/write-intent";
import { getClaim } from "../../src/claims/store";
import { tempVault } from "../helpers/vault";
import { putEvent, storeClaim, write } from "./helpers";
import { truncateSync } from "node:fs";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

async function editHoldFixture() {
  const vault = tempVault("canon-stale-hold-");
  cleanup.push(vault.dispose);
  const dbPath = join(vault.path, ".kizuki", "kizuki.db");
  const db = openLedger(dbPath);
  cleanup.push(() => db.close());
  const eventId = putEvent(db);
  const initialClaim = await storeClaim(db, eventId);
  const initialReceipt = write({ db, vault_path: vault.path }, initialClaim);
  const beforeBytes = readFileSync(join(vault.path, initialReceipt.page_path));

  const editClaim = await storeClaim(db, eventId, {
    kind: "edit",
    predicate: null,
    object: null,
    body: "Grace now leads platform strategy at Acme.",
    frontmatter: {},
  });

  // Interrupt completion after publication so we can test both published ("after")
  // and unapplied ("before" on disk + leftover stage) crash states.
  db.exec(
    "CREATE TRIGGER synthetic_hold_fail BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic hold interruption'); END",
  );
  expect(() => write({ db, vault_path: vault.path }, editClaim)).toThrow("synthetic hold interruption");
  db.exec("DROP TRIGGER synthetic_hold_fail");

  const intent = readCanonWriteIntent(db)!;
  expect(intent).not.toBeNull();
  return { vault: vault.path, db, io: { db, vault_path: vault.path }, eventId, initialClaim, initialReceipt, beforeBytes, editClaim, intent };
}

describe("resolveStaleCanonHold", () => {
  test("safely previews (dry-run default) and aborts an unapplied authority_changed hold, preserving before bytes and allowing re-evaluation", async () => {
    const f = await editHoldFixture();
    const pageAbs = join(f.vault, f.intent.receipt.page_path);
    const stageAbs = join(f.vault, f.intent.stages.live_stage);
    const archiveAbs = join(f.vault, f.intent.receipt.archive_path!);
    const logAbs = join(f.vault, RECEIPTS_PATH);

    // Simulate crash BEFORE live/archive publication: live page still has exact beforeBytes,
    // leftover .tmp live stage has after-image, archive absent, receipt log still at checkpoint.
    renameSync(pageAbs, stageAbs);
    writeFileSync(pageAbs, f.beforeBytes, { mode: 0o600 });
    if (existsSync(archiveAbs)) renameSync(archiveAbs, join(f.vault, f.intent.stages.archive_stage!));
    truncateSync(logAbs, f.intent.checkpoint.byte_length);

    // Trigger authority_changed (e.g. a subsequent claim mutation / supersession after admission).
    const replacementClaim = await storeClaim(f.db, f.eventId, {
      kind: "edit",
      predicate: null,
      object: null,
      body: "Grace leads global partnerships and platform strategy at Acme.",
      frontmatter: {},
    });
    f.db.query("UPDATE claims SET status='superseded' WHERE claim_id=?").run(f.editClaim.claim_id);

    // Ordinary recovery now deadlocks with authority_changed and writes canon-recovery-hold.json.
    expect(() => recoverCanonWrites(f.io)).toThrow("authority_changed");
    expect(readCanonRecoveryHold(f.vault)).toMatchObject({
      receipt_id: f.intent.receipt.receipt_id,
      reason: "authority_changed",
    });

    // 1. Default call is dry-run: mutates nothing, verifies before-image.
    const preview = resolveStaleCanonHold(f.io);
    expect(preview).toMatchObject({
      status: "resolvable",
      dry_run: true,
      receipt_id: f.intent.receipt.receipt_id,
      page_path: f.intent.receipt.page_path,
      hold_reason: "authority_changed",
      refusal_reason: null,
      before_verified: true,
      claim_ids: [f.editClaim.claim_id],
    });
    expect(inspectCanonRecovery(f.db).pending).toBe(true);
    expect(existsSync(stageAbs)).toBe(true);
    expect(existsSync(join(f.vault, CANON_RECOVERY_HOLD_PATH))).toBe(true);

    // 2. Explicit apply aborts unapplied intent, cleans stage, writes 0600 audit record, clears hold.
    const applied = resolveStaleCanonHold(f.io, { dryRun: false });
    expect(applied).toMatchObject({
      status: "resolved",
      dry_run: false,
      receipt_id: f.intent.receipt.receipt_id,
      hold_reason: "authority_changed",
      refusal_reason: null,
      before_verified: true,
    });
    expect(applied.audit_record).not.toBeNull();
    expect(inspectCanonRecovery(f.db).pending).toBe(false);
    expect(readCanonWriteIntent(f.db)).toBeNull();
    expect(existsSync(stageAbs)).toBe(false);
    expect(existsSync(join(f.vault, CANON_RECOVERY_HOLD_PATH))).toBe(false);
    expect(readFileSync(pageAbs)).toEqual(f.beforeBytes);
    expect(getCanonReceipt(f.db, f.intent.receipt.receipt_id)).toBeNull();

    // Audit log is 0600 and contains no page path or secret prose.
    const resolutionsPath = join(f.vault, CANON_RECOVERY_RESOLUTIONS_PATH);
    expect(lstatSync(resolutionsPath).mode & 0o777).toBe(0o600);
    const rawAudit = readFileSync(resolutionsPath, "utf8");
    expect(rawAudit).not.toContain(f.intent.receipt.page_path);
    expect(rawAudit).not.toContain("platform strategy");
    expect(readCanonRecoveryResolutions(f.vault, f.intent.receipt.receipt_id)).toHaveLength(1);

    // 3. Idempotent when run again, and next write pass cleanly evaluates live replacement claim!
    expect(resolveStaleCanonHold(f.io, { dryRun: false }).status).toBe("none");
    expect(getClaim(f.db, replacementClaim.claim_id)?.status).toBe("live");
    const nextReceipt = write(f.io, replacementClaim);
    expect(listCanonReceipts(f.db).map(r => r.receipt_id)).toEqual([
      f.initialReceipt.receipt_id,
      nextReceipt.receipt_id,
    ]);
    expect(readReceiptsLog(f.vault).map(r => r.receipt_id)).toEqual([
      f.initialReceipt.receipt_id,
      nextReceipt.receipt_id,
    ]);
    expect(readFileSync(pageAbs, "utf8")).toContain("global partnerships and platform strategy");
  });

  test("refuses to abort when the postimage was already published on disk (zero data loss)", async () => {
    const f = await editHoldFixture();
    const pageAbs = join(f.vault, f.intent.receipt.page_path);
    const publishedAfterBytes = readFileSync(pageAbs);

    // Mutate claim so authority_changed holds recovery, while live file on disk ALREADY has after-image!
    f.db.query("UPDATE claims SET status='reverted' WHERE claim_id=?").run(f.editClaim.claim_id);
    expect(() => recoverCanonWrites(f.io)).toThrow("authority_changed");

    const preview = resolveStaleCanonHold(f.io, { dryRun: true });
    expect(preview).toMatchObject({
      status: "refused",
      dry_run: true,
      receipt_id: f.intent.receipt.receipt_id,
      refusal_reason: "already_published",
      before_verified: false,
    });

    const attempted = resolveStaleCanonHold(f.io, { dryRun: false });
    expect(attempted).toMatchObject({
      status: "refused",
      dry_run: false,
      receipt_id: f.intent.receipt.receipt_id,
      refusal_reason: "already_published",
      before_verified: false,
    });
    expect(inspectCanonRecovery(f.db).pending).toBe(true);
    expect(readFileSync(pageAbs)).toEqual(publishedAfterBytes);
    expect(readCanonRecoveryResolutions(f.vault)).toEqual([]);
  });

  test("refuses when admission is still valid so normal recovery completes instead of aborting", async () => {
    const f = await editHoldFixture();
    const pageAbs = join(f.vault, f.intent.receipt.page_path);
    writeFileSync(pageAbs, f.beforeBytes, { mode: 0o600 });

    const preview = resolveStaleCanonHold(f.io, { dryRun: false });
    expect(preview).toMatchObject({
      status: "refused",
      refusal_reason: "not_stale_hold",
    });
    expect(recoverCanonWrites(f.io).completed).toEqual([f.intent.receipt.receipt_id]);
  });
});
