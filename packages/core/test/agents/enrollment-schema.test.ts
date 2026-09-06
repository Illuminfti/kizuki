import { describe, expect, test } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { addAgent, revokeAgent } from "../../src/agents/identity";

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
