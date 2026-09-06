import { describe, expect, test } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { assertLedgerSchema } from "../../src/ledger/integrity";
import { LedgerStoreError } from "../../src/ledger/errors";
import { addAgent, revokeAgent } from "../../src/agents/identity";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HASH = "a".repeat(64);
const FILE_HASH = "b".repeat(64);
const GENERATION = "c".repeat(32);
const NOW = "2026-09-06T00:00:00.000Z";

function reservation(db: ReturnType<typeof openLedger>, state: "reserved" | "file_bound", name = "reserved-agent", agentId = "01K4B7FMA7RGMA82446QKD2J3N", tokenHash = HASH): void {
  if (state === "reserved") {
    db.query(`INSERT INTO agent_enrollments (operation_id, request_digest, destination_digest, agent_id, name, grant_json, state, parent_dev, parent_ino, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("operation-0001", HASH, FILE_HASH, agentId, name, "{}", state, "1", "2", NOW, NOW);
    return;
  }
  db.query(`INSERT INTO agent_enrollments (operation_id, request_digest, destination_digest, agent_id, name, grant_json, state, parent_dev, parent_ino, generation, token_hash, credential_digest, credential_size, file_dev, file_ino, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("operation-0001", HASH, FILE_HASH, agentId, name, "{}", state, "1", "2", GENERATION, tokenHash, FILE_HASH, 1, "3", "4", NOW, NOW);
}

describe("agent enrollment migration", () => {
  const corruptions = [
    ...["agent_enrollments_live_name", "agent_enrollments_live_destination", "agent_enrollments_pending_token"].map(name => ({ name: `missing ${name}`, sql: `DROP INDEX ${name}` })),
    ...["agent_enrollments_block_legacy_agent_insert", "agent_enrollments_block_token_update"].map(name => ({ name: `missing ${name}`, sql: `DROP TRIGGER ${name}` })),
    { name: "missing enrollment table", sql: "DROP TABLE agent_enrollments" },
    { name: "non-unique live-name index", sql: "DROP INDEX agent_enrollments_live_name; CREATE INDEX agent_enrollments_live_name ON agent_enrollments(name) WHERE state != 'cancelled'" },
    { name: "no-op insert guard", sql: "DROP TRIGGER agent_enrollments_block_legacy_agent_insert; CREATE TRIGGER agent_enrollments_block_legacy_agent_insert BEFORE INSERT ON agents BEGIN SELECT 1; END" },
    { name: "no-op token guard", sql: "DROP TRIGGER agent_enrollments_block_token_update; CREATE TRIGGER agent_enrollments_block_token_update BEFORE UPDATE OF token_hash ON agents BEGIN SELECT 1; END" },
    { name: "unconstrained enrollment table", sql: "DROP TABLE agent_enrollments; CREATE TABLE agent_enrollments(operation_id TEXT PRIMARY KEY) STRICT" },
  ];
  for (const { name, sql } of corruptions) test(`refuses current ledger authority with ${name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-enrollment-corrupt-")), path = join(root, "ledger.db");
    try {
      const db = openLedger(path);
      try {
        reservation(db, "reserved");
        db.exec(sql);
        const before = db.query("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
        expect(() => assertLedgerSchema(db, 18)).toThrow(LedgerStoreError);
        expect(db.query("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(before);
      } finally { db.close(true); }
      let reopened: ReturnType<typeof openLedger> | undefined;
      try { expect(() => { reopened = openLedger(path); }).toThrow(LedgerStoreError); }
      finally { reopened?.close(true); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("upgrades a reconstructed ledger17 layout without changing existing authority", () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-enrollment-migration-")), path = join(root, "ledger.db");
    const old = openLedger(path);
    let before: string;
    const authority = (db: ReturnType<typeof openLedger>) => JSON.stringify(["agents", "agent_grants", "agent_audit"].map(table => db.query(`SELECT * FROM ${table}`).all()));
    try {
      old.exec("DROP TRIGGER agent_enrollments_block_legacy_agent_insert; DROP TRIGGER agent_enrollments_block_token_update; DROP TABLE agent_enrollments; UPDATE schema_version SET version=17");
      addAgent(old, "legacy-migration");
      before = authority(old);
    } finally { old.close(); }
    try {
      const migrated = openLedger(path);
      try {
        expect(authority(migrated) === before, "migration preserves every existing authority row").toBe(true);
        expect(migrated.query("SELECT version FROM schema_version").get()).toEqual({ version: 18 });
        expect(migrated.query("SELECT count(*) AS n FROM agent_enrollments").get()).toEqual({ n: 0 });
        expect(migrated.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'agent_enrollments_%' ORDER BY name").all()).toEqual([
          { name: "agent_enrollments_block_legacy_agent_insert" }, { name: "agent_enrollments_block_token_update" },
        ]);
      } finally { migrated.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("keeps a reservation inert and blocks legacy enrollment collisions", () => {
    const db = openLedger(":memory:");
    try {
      reservation(db, "reserved");
      expect(() => addAgent(db, "reserved-agent")).toThrow("reservation conflicts");
      expect(() => addAgent(db, "unrelated-agent")).not.toThrow();
    } finally { db.close(); }
  });

  test("permits only the exact bound identity to activate", () => {
    const db = openLedger(":memory:");
    try {
      const id = "01K4B7FMA7RGMA82446QKD2J3N";
      reservation(db, "file_bound", "bound-agent", id, HASH);
      expect(() => db.query("INSERT INTO agents (agent_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").run(id, "bound-agent", HASH, NOW)).not.toThrow();
      expect(() => db.query("INSERT INTO agents (agent_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").run("01K4B7FMA7RGMA82446QKD2J3P", "other-agent", HASH, NOW)).toThrow("reservation conflicts");
    } finally { db.close(); }
  });

  test("a cancelled reservation no longer blocks unrelated legacy behavior", () => {
    const db = openLedger(":memory:");
    try {
      reservation(db, "reserved");
      db.query("UPDATE agent_enrollments SET state = 'cancelled', cancelled_at = ?, updated_at = ? WHERE operation_id = ?").run(NOW, NOW, "operation-0001");
      expect(() => addAgent(db, "reserved-agent")).not.toThrow();
    } finally { db.close(); }
  });

  test("token updates cannot acquire any non-cancelled enrollment hash", () => {
    const db = openLedger(":memory:");
    try {
      const { agent } = addAgent(db, "rotation-agent");
      reservation(db, "file_bound");
      const before = db.query("SELECT token_hash FROM agents WHERE agent_id = ?").get(agent.agent_id);
      const update = () => db.query("UPDATE agents SET token_hash = ? WHERE agent_id = ?").run(HASH, agent.agent_id);
      expect(update).toThrow("reservation conflicts");
      db.query("UPDATE agent_enrollments SET state = 'completed', completed_at = ?").run(NOW);
      expect(update).toThrow("reservation conflicts");
      expect(db.query("SELECT token_hash FROM agents WHERE agent_id = ?").get(agent.agent_id)).toEqual(before);
      // Cancellation releases a pending generation's hash reservation.
      db.query("UPDATE agent_enrollments SET state = 'cancelled', completed_at = NULL, cancelled_at = ?").run(NOW);
      expect(update).not.toThrow();
    } finally { db.close(); }
  });

  test("enforces complete binding and terminal timestamp invariants", () => {
    const db = openLedger(":memory:");
    try {
      reservation(db, "file_bound");
      expect(() => db.query("UPDATE agent_enrollments SET credential_size = NULL WHERE operation_id = ?").run("operation-0001")).toThrow();
      expect(() => db.query("UPDATE agent_enrollments SET state = 'completed' WHERE operation_id = ?").run("operation-0001")).toThrow();
      expect(() => db.query("UPDATE agent_enrollments SET state = 'completed', completed_at = ? WHERE operation_id = ?").run(NOW, "operation-0001")).not.toThrow();
      expect(() => db.query("UPDATE agent_enrollments SET operation_id = ? WHERE operation_id = ?").run("bad space", "operation-0001")).toThrow();
    } finally { db.close(); }
  });

  test("a repeated revoke leaves the terminal grant epoch unchanged", () => {
    const db = openLedger(":memory:");
    try {
      addAgent(db, "revoke-once");
      revokeAgent(db, "revoke-once");
      const first = db.query<{ grant_epoch: number }, []>("SELECT grant_epoch FROM agent_grants").get()?.grant_epoch;
      revokeAgent(db, "revoke-once");
      const second = db.query<{ grant_epoch: number }, []>("SELECT grant_epoch FROM agent_grants").get()?.grant_epoch;
      expect([first, second]).toEqual([2, 2]);
    } finally { db.close(); }
  });
});
