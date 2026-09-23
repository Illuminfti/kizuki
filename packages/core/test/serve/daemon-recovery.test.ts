import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { runServeDaemon } from "../../src/serve/daemon";
import { listRunReceipts } from "../../src/serve/receipts";
import { listCanonReceipts, readReceiptsLog } from "../../src/canon/receipts";
import { inspectCanonRecovery, readCanonWriteIntent } from "../../src/canon/write-intent";
import { readCanonStageRecoveries } from "../../src/canon/stage-recovery";
import { hashBytes } from "../../src/vault/write";
import { putEvent, storeClaim, write } from "../canon/helpers";
import { tempVault } from "../helpers/vault";
import { killAfterStage } from "../canon/stage-kill";
import { SERVE_TOKEN_PATH } from "../../src/serve/types";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

const idleSync = async () => ({ events_synced: 0, events_stored: 0, events_duplicate: 0, events_self_skipped: 0, errors: [] as string[] });

/** Reconstructs the killed daemon's disk: the fsynced stage holds the exact
 * after-image, the page is absent and the durable intent is pending. */
async function killedBetweenStageAndPublish() {
  const vault = tempVault("daemon-recovery-"); cleanup.push(vault.dispose);
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db")); cleanup.push(() => db.close());
  const io = { db, vault_path: vault.path };
  const prior = write(io, await storeClaim(db, putEvent(db), { target: "people/ada", subject: "person:ada", frontmatter: { type: "person", title: "Ada" }, body: "Ada keeps the lighthouse." }));
  const claim = await storeClaim(db, putEvent(db, { source_record_id: "daemon-recovery" }));
  db.exec("CREATE TRIGGER synthetic_kill BEFORE INSERT ON canon_receipts BEGIN SELECT RAISE(FAIL,'synthetic kill'); END");
  expect(() => write(io, claim)).toThrow("synthetic kill");
  db.exec("DROP TRIGGER synthetic_kill");
  const intent = readCanonWriteIntent(db)!;
  renameSync(join(vault.path, intent.receipt.page_path), join(vault.path, intent.stages.live_stage));
  return { vault: vault.path, db, intent, prior };
}

test("daemon startup completes an exact stage automatically and records it", async () => {
  const f = await killedBetweenStageAndPublish(), lines: string[] = [];
  await runServeDaemon(f.db, f.vault, { once: true, http: false, rails: ["doctor-sweep"], log: line => lines.push(line) });
  expect(lines).toEqual([]);
  expect(inspectCanonRecovery(f.db).pending).toBe(false);
  expect(hashBytes(readFileSync(join(f.vault, f.intent.receipt.page_path)))).toBe(f.intent.receipt.after_hash);
  expect(existsSync(join(f.vault, f.intent.stages.live_stage))).toBe(false);
  expect(listCanonReceipts(f.db).map(item => item.receipt_id)).toEqual([f.prior.receipt_id, f.intent.receipt.receipt_id]);
  expect(readCanonStageRecoveries(f.vault).map(item => [item.receipt_id, item.classification, item.action]))
    .toEqual([[f.intent.receipt.receipt_id, "exact", "removed"]]);
  expect(listRunReceipts(f.db).map(item => [item.rail, item.status])).toEqual([["doctor-sweep", "ok"]]);
});

test("a held write keeps the daemon serving: one structured line, sync stops as held, reads continue", async () => {
  const f = await killedBetweenStageAndPublish(), lines: string[] = [];
  const stage = join(f.vault, f.intent.stages.live_stage), outside = join(f.vault, "synthetic-outside");
  renameSync(stage, outside); symlinkSync(outside, stage);
  const before = readFileSync(join(f.vault, f.prior.page_path));
  const result = await runServeDaemon(f.db, f.vault, { once: true, http: false, rails: ["sync", "doctor-sweep", "journal-prune"],
    hooks: { sync: idleSync }, log: line => lines.push(line) });
  expect(result.receipts).toBe(3);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({ event: "canon_recovery_held", mode: "writer-held", reason: "stage_custody_unknown",
    receipt_id: f.intent.receipt.receipt_id, attempts: 1, next: expect.stringContaining("move it out of the vault") });
  const runs = listRunReceipts(f.db).map(item => [item.rail, item.status, item.stopped, item.errors.length]);
  expect(runs).toEqual([["sync", "stopped", "recovery:held", 0], ["doctor-sweep", "degraded", null, 1], ["journal-prune", "ok", null, 0]]);
  expect(inspectCanonRecovery(f.db)).toMatchObject({ pending: true, receipt_id: f.intent.receipt.receipt_id });
  // Unaffected memory stays readable and the unsafe entry is untouched.
  expect(readFileSync(join(f.vault, f.prior.page_path))).toEqual(before);
  expect(listCanonReceipts(f.db).map(item => item.receipt_id)).toEqual([f.prior.receipt_id]);
  expect(existsSync(join(f.vault, f.intent.receipt.page_path))).toBe(false);
  expect(readFileSync(stage)).toEqual(readFileSync(outside));
  // The next start after the owner moves the entry converges.
  writeFileSync(outside, "ignored"); renameSync(stage, join(f.vault, "moved-away"));
  await runServeDaemon(f.db, f.vault, { once: true, http: false, rails: ["doctor-sweep"], log: line => lines.push(line) });
  expect(lines).toHaveLength(1);
  expect(inspectCanonRecovery(f.db).pending).toBe(false);
  expect(hashBytes(readFileSync(join(f.vault, f.intent.receipt.page_path)))).toBe(f.intent.receipt.after_hash);
});

test("a real kill right after the canon stage fsync converges on the next daemon start", async () => {
  const vault = tempVault("daemon-kill-"); cleanup.push(vault.dispose);
  const dbPath = join(vault.path, ".kizuki", "kizuki.db");
  let db = openLedger(dbPath); cleanup.push(() => db.close());
  const claim = await storeClaim(db, putEvent(db));
  killAfterStage({ dbPath, vault: vault.path, reopen() { db.close(); db = openLedger(dbPath); } }, claim.claim_id, 1);
  const intent = readCanonWriteIntent(db)!;
  expect(existsSync(join(vault.path, intent.receipt.page_path))).toBe(false);
  expect(hashBytes(readFileSync(join(vault.path, intent.stages.live_stage)))).toBe(intent.receipt.after_hash);
  const lines: string[] = [];
  await runServeDaemon(db, vault.path, { once: true, http: false, rails: ["doctor-sweep"], log: line => lines.push(line) });
  expect(lines).toEqual([]);
  expect(readFileSync(join(vault.path, intent.receipt.page_path))).toEqual(Buffer.from(intent.after_base64!, "base64"));
  expect(listCanonReceipts(db).map(item => item.receipt_id)).toEqual([intent.receipt.receipt_id]);
  expect(readReceiptsLog(vault.path).map(item => item.receipt_id)).toEqual([intent.receipt.receipt_id]);
  expect(existsSync(join(vault.path, intent.stages.live_stage))).toBe(false);
}, 60_000);

test("HTTP reads keep serving while the writer is held", async () => {
  const f = await killedBetweenStageAndPublish(), lines: string[] = [];
  const stage = join(f.vault, f.intent.stages.live_stage), outside = join(f.vault, "synthetic-outside");
  renameSync(stage, outside); symlinkSync(outside, stage);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port!; probe.stop(true);
  const served: { health?: number; page?: number; body?: string } = {};
  // The sync rail runs its ingest while the daemon's HTTP endpoint is up and the write is held.
  const readWhileHeld = async () => {
    const origin = `http://127.0.0.1:${port}`, token = readFileSync(join(f.vault, SERVE_TOKEN_PATH), "utf8").trim();
    served.health = (await fetch(`${origin}/health`)).status;
    const page = await fetch(`${origin}/v1/get_page`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ path: f.prior.page_path }) });
    served.page = page.status; served.body = await page.text();
    return idleSync();
  };
  const result = await runServeDaemon(f.db, f.vault, { once: true, http: true, port, rails: ["sync"], hooks: { sync: readWhileHeld }, log: line => lines.push(line) });
  expect(result.receipts).toBe(1);
  expect(lines.map(line => JSON.parse(line).reason)).toEqual(["stage_custody_unknown"]);
  expect(served).toMatchObject({ health: 200, page: 200 });
  expect(served.body).toContain("Ada keeps the lighthouse.");
  expect(listRunReceipts(f.db).map(item => [item.rail, item.stopped])).toEqual([["sync", "recovery:held"]]);
  expect(inspectCanonRecovery(f.db).pending).toBe(true);
});
