import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProducerPort } from "../src/contracts/producer";
import { exportVault, restoreVault, verifyBackup, type ExportOptions } from "../src/export";
import { readRailCursor, writeRailCursor } from "../src/ledger/checkpoints";
import { openLedger } from "../src/ledger/db";
import { journalExtractBatch, mineLiveDrafts } from "../src/serve/extract";
import { tryWriteFlock } from "../src/serve/flock";
import { ensureVaultId } from "../src/serve/vault-id";
import { initVault } from "../src/vault/init";
import { ulid } from "../src/util/ulid";
import { putEvent, storeClaim, write } from "./canon/helpers";

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });

function fixture(backend: "disk" | "memory" | "temporary" = "disk") {
  const root = mkdtempSync(join(tmpdir(), "kizuki-export-snapshot-"));
  const vault = join(root, "vault");
  initVault(vault);
  const ledger = join(vault, ".kizuki", "kizuki.db");
  const db = openLedger(backend === "disk" ? ledger : backend === "memory" ? ":memory:" : "");
  disposers.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, vault, ledger, db, backup: join(root, "backup"), restored: join(root, "restored") };
}

function rows(backup: string, path: string): Record<string, unknown>[] {
  return readFileSync(join(backup, path), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function expectNoStaging(root: string) {
  expect(readdirSync(root).filter(name => name.includes(".kizuki-backup-"))).toEqual([]);
}

const producer: ProducerPort = {
  descriptor: { id: "kizuki.producer.snapshot-fixture", kind: "producer", contract: "kizuki.producer/v1",
    contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
  health: async () => ({ status: "ready", detail: {} }), close: async () => {},
  produce: async input => ({ status: "ok", claims: [{ kind: "claim", subject: "person:queued",
    predicate: "employment.works_at", object: "acme", polarity: "positive", body: "A queued synthetic statement.",
    valid_from: null, valid_to: null, confidence: 0.8, sensitivity: "personal", event_ids: [input.events[0]!.event_id] }],
    usage: { calls: 0, input_tokens: 0, output_tokens: 0 } }),
};

test("a file-backed capture restores one event, canon, receipt, checkpoint and durable-queue cut", async () => {
  const f = fixture();
  const id = ensureVaultId(f.vault, "snapshot-fixture");
  const event = putEvent(f.db);
  const receipt = write({ db: f.db, vault_path: f.vault }, await storeClaim(f.db, event));
  const page = readFileSync(join(f.vault, receipt.page_path));
  const sourceKey = ulid();
  const at = "2026-09-06T00:00:00.000Z";
  f.db.query(`INSERT INTO connections(connector_id,source_key,config,secret_refs,connected_at,implementation_version)
    VALUES ('fixture',?,'{"schema":"kizuki.connection-config/v1","state_ref_index":null}','[]',?,'fixture@1')`).run(sourceKey, at);
  f.db.query(`INSERT INTO checkpoints(connector_id,source_key,cursor,mode,updated_at,last_run_at,last_result)
    VALUES ('fixture',?,'before','sync',?,?,'{}')`).run(sourceKey, at, at);
  const beforeCursor = `2026-01-01T00:00:00.000Z\t${sourceKey}`;
  writeRailCursor(f.db, "kizuki.producer.model", "extract", beforeCursor);
  f.db.query("INSERT INTO extract_deferred_inputs VALUES (?,NULL,0,?)").run(event, "a".repeat(64));
  journalExtractBatch(f.db, await mineLiveDrafts(f.db, producer), "fixture:snapshot", producer);
  const batch = f.db.query<Record<string, unknown>, []>("SELECT * FROM extract_batches").all();
  expect(batch).toHaveLength(1);
  const observer = new Database(f.ledger);
  disposers.push(() => observer.close());
  let lateEvent: string | undefined;
  const labels: string[] = [];
  const manifest = exportVault(f.db, f.vault, f.backup, { onProgress(label) {
    labels.push(label);
    expect(f.db.inTransaction).toBe(false);
    expect(tryWriteFlock(f.vault)).toBeNull();
    if (label !== "ledger") return;
    // Ordinary SQLite writes can proceed after capture while the canon owner
    // remains held; every backup stream must retain the already sealed cut.
    observer.transaction(() => {
      lateEvent = putEvent(observer, { source_record_id: "after-capture" });
      observer.query("UPDATE checkpoints SET cursor='after' WHERE source_key=?").run(sourceKey);
      writeRailCursor(observer, "kizuki.producer.model", "extract", "after");
      observer.query("INSERT INTO extract_deferred_inputs VALUES (?,NULL,0,?)").run(lateEvent, "b".repeat(64));
      observer.exec("DELETE FROM extract_batches");
    }).immediate();
  } });
  expect(labels[0]).toBe("staging");
  expect(labels[1]).toBe("inventory");
  expect(labels.slice(-3)).toEqual(["ledger", "claims", "receipts"]);
  expect(manifest.vault_id).toBe(id);
  expect(manifest.snapshot.event_count).toBe(1);
  expect(rows(f.backup, "ledger/events.jsonl").map(row => row.event_id)).toEqual([event]);
  expect(rows(f.backup, "canon/receipts.jsonl").map(row => row.receipt_id)).toEqual([receipt.receipt_id]);
  expect(rows(f.backup, "claims/claims.jsonl")).toHaveLength(1);
  expect(rows(f.backup, "checkpoints.jsonl")[0]?.cursor).toBe("before");
  expect(rows(f.backup, "rail_cursors.jsonl")[0]?.cursor).toBe(beforeCursor);
  expect(rows(f.backup, "serve/extract-deferred-inputs.jsonl").map(row => row.event_id)).toEqual([event]);
  expect(rows(f.backup, "serve/extract-batches.jsonl")).toEqual(batch);
  expect(f.db.query("SELECT event_id FROM events").all()).toHaveLength(2);
  expect(lateEvent).toBeDefined();
  expect(verifyBackup(f.backup).manifest_sha256).toBe(manifest.manifest_sha256);
  restoreVault(f.backup, f.restored);
  const restored = openLedger(join(f.restored, ".kizuki", "kizuki.db"));
  try {
    expect(restored.query("SELECT event_id FROM events").all()).toEqual([{ event_id: event }]);
    expect(restored.query("SELECT cursor FROM checkpoints").get()).toEqual({ cursor: "before" });
    expect(readRailCursor(restored, "kizuki.producer.model", "extract")).toBe(beforeCursor);
    expect(restored.query("SELECT * FROM extract_batches").all()).toEqual(batch);
    expect(restored.query("SELECT event_id FROM extract_deferred_inputs").all()).toEqual([{ event_id: event }]);
    expect(readFileSync(join(f.restored, receipt.page_path))).toEqual(page);
  } finally { restored.close(); }
  expectNoStaging(f.root);
});

test("an ordinary SQLite writer blocks top-level capture and a later retry captures its commit", () => {
  const f = fixture();
  const writer = new Database(f.ledger);
  disposers.push(() => writer.close());
  f.db.exec("PRAGMA busy_timeout=1");
  writer.exec("BEGIN IMMEDIATE");
  const event = putEvent(writer);
  writeRailCursor(writer, "kizuki.producer.model", "extract", "committed-together");
  try {
    expect(() => exportVault(f.db, f.vault, f.backup)).toThrow(/locked|busy/i);
    expect(existsSync(f.backup)).toBe(false);
    expectNoStaging(f.root);
  } finally { writer.exec("COMMIT"); }
  const manifest = exportVault(f.db, f.vault, f.backup);
  expect(manifest.snapshot.event_count).toBe(1);
  expect(rows(f.backup, "ledger/events.jsonl")[0]?.event_id).toBe(event);
  expect(rows(f.backup, "rail_cursors.jsonl")[0]?.cursor).toBe("committed-together");
});

test("a pre-existing transaction is refused before option access, callbacks or output effects", () => {
  const f = fixture();
  const before = readdirSync(f.root);
  let accessed = false;
  const options = { get onProgress() { accessed = true; return () => {}; } };
  f.db.exec("BEGIN");
  try { expect(() => exportVault(f.db, f.vault, f.backup, options)).toThrow("top-level SQLite transaction"); }
  finally { f.db.exec("ROLLBACK"); }
  expect(accessed).toBe(false);
  expect(readdirSync(f.root)).toEqual(before);
});

test("file-backed affinity uses SQLite's actual database and rejects a different vault before effects", () => {
  const selected = fixture(), different = fixture();
  const before = readdirSync(selected.root);
  let notified = false;
  expect(() => exportVault(different.db, selected.vault, selected.backup, { onProgress() { notified = true; } }))
    .toThrow("does not belong to the selected vault");
  expect(notified).toBe(false);
  expect(readdirSync(selected.root)).toEqual(before);
});

for (const backend of ["memory", "temporary"] as const) test(`engine-confirmed unnamed ${backend} databases keep supported export compatibility`, () => {
  const f = fixture(backend);
  putEvent(f.db);
  expect(exportVault(f.db, f.vault, f.backup).snapshot.event_count).toBe(1);
});

test("options are read once and the native cancellation getter is callback-free", () => {
  const f = fixture();
  const controller = new AbortController();
  let signalReads = 0, progressReads = 0, customSignalReads = 0, notifications = 0;
  Object.defineProperty(controller.signal, "aborted", { get() { customSignalReads++; return true; } });
  const options: ExportOptions = {
    get signal() { signalReads++; expect(f.db.inTransaction).toBe(false); return controller.signal; },
    get onProgress() { progressReads++; expect(f.db.inTransaction).toBe(false); return () => { notifications++; }; },
  };
  exportVault(f.db, f.vault, f.backup, options);
  expect([signalReads, progressReads, customSignalReads]).toEqual([1, 1, 0]);
  expect(notifications).toBeGreaterThan(0);
});

test("cancellation after capture preserves an existing empty output and releases its writer", () => {
  const f = fixture();
  mkdirSync(f.backup, { mode: 0o700 });
  const controller = new AbortController();
  expect(() => exportVault(f.db, f.vault, f.backup, { signal: controller.signal, onProgress(label) {
    expect(f.db.inTransaction).toBe(false);
    if (label === "receipts") controller.abort();
  } })).toThrow("cancelled");
  expect(readdirSync(f.backup)).toEqual([]);
  expectNoStaging(f.root);
  const owner = tryWriteFlock(f.vault);
  expect(owner).not.toBeNull(); owner?.release();
  expect(exportVault(f.db, f.vault, f.backup).complete).toBe(true);
});

test("fresh publication admission checks the captured vault identity", () => {
  const f = fixture();
  ensureVaultId(f.vault, "before");
  expect(() => exportVault(f.db, f.vault, f.backup, { onProgress(label) {
    if (label === "receipts") writeFileSync(join(f.vault, ".kizuki", "vault-id"), "owner-updated-identity\n");
  } })).toThrow("vault identity changed");
  expect(existsSync(f.backup)).toBe(false);
  expectNoStaging(f.root);
});

test("fresh publication admission checks schema identity after progress", () => {
  const f = fixture();
  expect(() => exportVault(f.db, f.vault, f.backup, { onProgress(label) {
    if (label === "receipts") f.db.exec("CREATE TABLE owner_fixture_note(value TEXT)");
  } })).toThrow("schema identity changed");
  expect(existsSync(f.backup)).toBe(false);
  expectNoStaging(f.root);
});

test("fresh publication admission refuses a newly recorded canon hold", () => {
  const f = fixture();
  expect(() => exportVault(f.db, f.vault, f.backup, { onProgress(label) {
    if (label === "receipts") f.db.query("INSERT INTO canon_holds VALUES (?,?,?,?)")
      .run("facts/owner-note.md", "ordinary-pending-receipt", "owner reconciliation", "2026-09-06T00:00:00Z");
  } })).toThrow("purge_recovery_pending");
  expect(existsSync(f.backup)).toBe(false);
  expectNoStaging(f.root);
});

test("a progress listener cannot leave a caller transaction for export to inherit", () => {
  const f = fixture();
  try {
    expect(() => exportVault(f.db, f.vault, f.backup, { onProgress(label) {
      if (label === "receipts") f.db.exec("BEGIN");
    } })).toThrow("top-level SQLite transaction");
    expect(f.db.inTransaction).toBe(true);
    expect(existsSync(f.backup)).toBe(false);
    expectNoStaging(f.root);
  } finally { if (f.db.inTransaction) f.db.exec("ROLLBACK"); }
});
