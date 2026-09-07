import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { inspectOpenLedgerHealth, openLedger } from "../src/ledger/db";
import { exportVault, restoreVault, verifyBackup } from "../src/export";
import { DISCONNECT_RECEIPT_STREAM } from "../src/ledger/connection-disconnect-schema";
import fixture from "./fixtures/connection-disconnect-ledger21-backup.json";
import { registerConnection } from "../src/ledger/connections";

test("ledger21 upgrades to append-only disconnect history and reopens without changing connections", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-disconnect-migration-")), path = join(root, "ledger.sqlite");
  try {
    const old = openLedger(path);
    registerConnection(old, "fixture", "01JJ0000000000000000000001");
    old.exec("DROP TABLE connection_disconnect_receipts; UPDATE schema_version SET version=21");
    const connections = old.query("SELECT * FROM connections").all();
    old.close();
    for (let pass = 0; pass < 2; pass++) {
      const db = openLedger(path);
      try {
        expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: 22 });
        expect(inspectOpenLedgerHealth(db, { full: true }).ok).toBe(true);
        expect(db.query("SELECT * FROM connection_disconnect_receipts").all()).toEqual([]);
        expect(db.query("SELECT * FROM connections").all()).toEqual(connections);
      } finally { db.close(); }
    }
    const damaged = new Database(path);
    damaged.exec("DROP TRIGGER connection_disconnect_no_update"); damaged.close();
    expect(() => openLedger(path)).toThrow("connection disconnect schema is invalid");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restores actual unmodified ledger21 backup bytes and preserves their event and connection", () => {
  expect(fixture.writer_commit).toBe("0e3bb2216c9f1a1b3f33191d44eae5c39a6007f1");
  expect(fixture.bun_version).toBe("1.3.14");
  expect(Object.hasOwn(fixture.files, DISCONNECT_RECEIPT_STREAM)).toBe(false);
  const root = mkdtempSync(join(tmpdir(), "kizuki-prior21-backup-")), backup = join(root, "backup");
  try {
    for (const [path, text] of Object.entries(fixture.files)) {
      const target = join(backup, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, text, { mode: 0o600 });
    }
    expect(verifyBackup(backup).schema_versions.ledger).toBe(21);
    const restored = join(root, "restored");
    expect(restoreVault(backup, restored).events).toBe(1);
    const db = openLedger(join(restored, ".kizuki", "kizuki.db"));
    try {
      expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: 22 });
      expect(inspectOpenLedgerHealth(db, { full: true }).ok).toBe(true);
      expect(db.query("SELECT * FROM connection_disconnect_receipts").all()).toEqual([]);
      const current = join(root, "current-backup"), manifest = exportVault(db, restored, current);
      expect(manifest.schema_versions.ledger).toBe(22);
      expect(manifest.files[DISCONNECT_RECEIPT_STREAM]?.count).toBe(0);
      expect(readFileSync(join(current, "ledger/events.jsonl"), "utf8")).toBe(fixture.files["ledger/events.jsonl"]);
      expect(readFileSync(join(current, "connections.jsonl"), "utf8")).toBe(fixture.files["connections.jsonl"]);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
