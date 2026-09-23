import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { registerConnection } from "../../src/ledger/connections";
import { accept } from "../../src/ledger/ledger";
import { resumeSourceRevocation, revokeSourceGrant, setSourceGrant } from "../../src/ledger/source-grants";
import { runPurge } from "../../src/ledger/purge";
import { readReceiptsLog } from "../../src/canon/receipts";
import { recoverCanonWrites } from "../../src/canon/recovery";
import { inspectCanonRecovery, readCanonWriteIntent } from "../../src/canon/write-intent";
import { CANON_STAGE_QUARANTINE_PATH, CANON_STAGE_RECOVERIES_PATH, readCanonStageRecoveries } from "../../src/canon/stage-recovery";
import { ulid } from "../../src/util/ulid";
import { tempVault } from "../helpers/vault";
import { validEvent } from "../fixtures";
import { putEvent, storeClaim, write } from "./helpers";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

const retrieval = { ownedRetrieval: { stores: async () => ({ stores: [], absent_store_ids: [] }) } };

/** A write from a granted source, killed after its stage fsync and before publication. */
async function sourcedPendingWrite() {
  const vault = tempVault("stage-trace-"); cleanup.push(vault.dispose);
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db")); cleanup.push(() => db.close());
  const source = ulid();
  registerConnection(db, "fixture", source);
  setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "grant", policy: {
    purposes: ["capture", "recall", "session", "derive", "extract", "export"],
    allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked",
    egress: "local_only", sensitivity_floor: "private" } });
  const accepted = accept(db, { ...validEvent(), connector_id: "fixture" }, { source: { source_key: source, expected_revision: 1 } });
  if (accepted.status !== "stored") throw new Error("fixture event was not stored");
  const io = { db, vault_path: vault.path }, claim = await storeClaim(db, accepted.event.event_id);
  db.exec("CREATE TRIGGER synthetic_kill BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic kill'); END");
  expect(() => write(io, claim)).toThrow("synthetic kill");
  db.exec("DROP TRIGGER synthetic_kill");
  const pending = readCanonWriteIntent(db)!;
  renameSync(join(vault.path, pending.receipt.page_path), join(vault.path, pending.stages.live_stage));
  return { vault: vault.path, db, io, source, pending, stage: join(vault.path, pending.stages.live_stage) };
}

/** Every regular file under the control directory, the ledger included. */
function controlFiles(vault: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) found.push(path);
    }
  };
  walk(join(vault, ".kizuki"));
  return found;
}
function holders(vault: string, secrets: readonly string[]): string[] {
  return controlFiles(vault).filter(path => { const bytes = readFileSync(path); return secrets.some(secret => bytes.includes(Buffer.from(secret))); });
}

async function revokeUntilPurged(f: Awaited<ReturnType<typeof sourcedPendingWrite>>) {
  revokeSourceGrant(f.db, { source_key: f.source, expected_revision: 1, operation_id: "withdraw" });
  await resumeSourceRevocation(f.db, f.vault, "withdraw");
  return resumeSourceRevocation(f.db, f.vault, "withdraw", retrieval);
}

test("source purge of a pending write with an exact stage leaves no page path or after-image hash under .kizuki", async () => {
  const f = await sourcedPendingWrite();
  const done = await revokeUntilPurged(f);
  expect(done.status).toBe("purged");
  expect(inspectCanonRecovery(f.db).pending).toBe(false);
  expect(existsSync(f.stage)).toBe(false);
  expect(readReceiptsLog(f.vault).some(item => item.receipt_id === f.pending.receipt.receipt_id)).toBe(false);
  expect(readCanonStageRecoveries(f.vault, f.pending.receipt.receipt_id)).toEqual([]);
  f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(holders(f.vault, [f.pending.receipt.page_path, f.pending.receipt.after_hash, f.pending.stages.live_stage])).toEqual([]);
}, 60_000);

test("source withdrawal erases foreign stage bytes instead of quarantining them", async () => {
  const f = await sourcedPendingWrite();
  const foreign = "synthetic foreign stage bytes from a withdrawn source\n";
  writeFileSync(f.stage, foreign, { mode: 0o600 });
  expect((await revokeUntilPurged(f)).status).toBe("purged");
  expect(existsSync(f.stage)).toBe(false);
  expect(existsSync(join(f.vault, CANON_STAGE_QUARANTINE_PATH))).toBe(false);
  f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(holders(f.vault, [foreign.trim(), f.pending.receipt.page_path, f.pending.receipt.after_hash, f.pending.receipt.receipt_id])).toEqual([]);
}, 60_000);

test("a file-level copy refuses withdrawal before any stage action", async () => {
  const f = await sourcedPendingWrite(), staged = readFileSync(f.stage);
  // Same bytes, new inode: what cp -a or a file-level restore produces.
  const log = join(f.vault, ".kizuki/receipts/promotions.jsonl"), bytes = readFileSync(log);
  rmSync(log); writeFileSync(log, bytes, { mode: 0o600 });
  const result = await revokeUntilPurged(f);
  expect(result.status).not.toBe("purged");
  expect(readCanonWriteIntent(f.db)?.receipt.receipt_id).toBe(f.pending.receipt.receipt_id);
  expect(readFileSync(f.stage)).toEqual(staged);
  expect(existsSync(join(f.vault, CANON_STAGE_RECOVERIES_PATH))).toBe(false);
}, 60_000);

test("an event purge removes the quarantine entry and records of a receipt that cites the purged event", async () => {
  const vault = tempVault("stage-trace-event-"); cleanup.push(vault.dispose);
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db")); cleanup.push(() => db.close());
  const io = { db, vault_path: vault.path };
  const quarantinedWrite = async (record: string, overrides: Parameters<typeof storeClaim>[2] = {}) => {
    const eventId = putEvent(db, { source_record_id: record }), claim = await storeClaim(db, eventId, overrides);
    db.exec("CREATE TRIGGER synthetic_kill BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic kill'); END");
    expect(() => write(io, claim)).toThrow("synthetic kill");
    db.exec("DROP TRIGGER synthetic_kill");
    const pending = readCanonWriteIntent(db)!, foreign = `synthetic foreign bytes for ${record}\n`;
    writeFileSync(join(vault.path, pending.stages.live_stage), foreign, { mode: 0o600 });
    expect(recoverCanonWrites(io).completed).toEqual([pending.receipt.receipt_id]);
    const quarantined = join(vault.path, CANON_STAGE_QUARANTINE_PATH, pending.receipt.receipt_id);
    expect(readFileSync(join(quarantined, "live.stage"), "utf8")).toBe(foreign);
    return { eventId, receiptId: pending.receipt.receipt_id, foreign, quarantined };
  };
  const kept = await quarantinedWrite("kept", { target: "people/ada", subject: "person:ada", frontmatter: { type: "person", title: "Ada" }, body: "Ada keeps the lighthouse." });
  const purged = await quarantinedWrite("purged");
  await runPurge(db, vault.path, { event_id: purged.eventId }, "purge the cited event");
  expect(existsSync(purged.quarantined)).toBe(false);
  expect(readCanonStageRecoveries(vault.path, purged.receiptId)).toEqual([]);
  expect(holders(vault.path, [purged.foreign.trim()])).toEqual([]);
  // An unrelated receipt keeps its quarantined bytes and its record.
  expect(readFileSync(join(kept.quarantined, "live.stage"), "utf8")).toBe(kept.foreign);
  expect(readCanonStageRecoveries(vault.path, kept.receiptId).map(item => [item.action, item.outcome])).toEqual([["quarantined", "done"]]);
}, 60_000);
