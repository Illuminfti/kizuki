import { credentialCustodyQualified } from "./custody-fixture";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authenticateAgentCredential, enrollAgent, previewAgentEnrollment } from "../../src/agents/enrollment";
import { openLedger } from "../../src/ledger/db";

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-enrollment-flow-vault-"));
  const control = join(vault, ".kizuki"); mkdirSync(control); chmodSync(control, 0o700);
  const dbPath = join(control, "kizuki.db"); const db = openLedger(dbPath); db.close(); chmodSync(dbPath, 0o600);
  const credentials = mkdtempSync(join(tmpdir(), "kizuki-enrollment-flow-credential-")); chmodSync(credentials, 0o700);
  const request = { operation_id: "enroll-flow-0001", name: "flow-agent", token_ref: `file:${join(credentials, "agent.json")}`, grant: { ceiling: "public" as const, types: [], subjects: [], since: null, until: null, tools: [], rate_limit_per_minute: 60, relay_owner_corrections: false } };
  return { vault, dbPath, request, clean: () => { rmSync(vault, { recursive: true, force: true }); rmSync(credentials, { recursive: true, force: true }); } };
}
describe.if(credentialCustodyQualified)("agent enrollment flow", () => {
  test("creates one durable credential and replays the completed operation", () => {
    const f = fixture(); try {
      expect(previewAgentEnrollment(f.vault, f.request).status).toBe("preview");
      const first = enrollAgent(f.vault, f.request); expect(first).toMatchObject({ status: "completed", authority: "active", credential: "ready", replayed: false });
      const db = openLedger(f.dbPath); expect(authenticateAgentCredential(db, f.request.token_ref)?.kind).toBe("agent"); db.close();
      expect(enrollAgent(f.vault, f.request)).toMatchObject({ status: "completed", credential: "ready", replayed: true });
    } finally { f.clean(); }
  });
  test("recovers a durable bound credential after reopening the ledger", () => {
    const f = fixture(); try {
      const first = enrollAgent(f.vault, f.request);
      const db = openLedger(f.dbPath);
      db.query("DELETE FROM agent_grants WHERE agent_id = ?").run(first.agent_id);
      db.query("DELETE FROM agents WHERE agent_id = ?").run(first.agent_id);
      db.query("UPDATE agent_enrollments SET state = 'file_bound', completed_at = NULL WHERE operation_id = ?").run(f.request.operation_id);
      db.close();
      expect(enrollAgent(f.vault, f.request)).toMatchObject({ status: "completed", credential: "ready", replayed: true });
    } finally { f.clean(); }
  });

  test("refuses partial credential recovery before activating an agent", () => {
    const f = fixture(); try {
      const first = enrollAgent(f.vault, f.request);
      const db = openLedger(f.dbPath);
      db.query("DELETE FROM agent_grants WHERE agent_id = ?").run(first.agent_id);
      db.query("DELETE FROM agents WHERE agent_id = ?").run(first.agent_id);
      db.query("UPDATE agent_enrollments SET state = 'file_bound', completed_at = NULL WHERE operation_id = ?").run(f.request.operation_id);
      db.close();
      writeFileSync(f.request.token_ref.slice(5), "{\n"); chmodSync(f.request.token_ref.slice(5), 0o600);
      expect(enrollAgent(f.vault, f.request)).toMatchObject({ status: "pending", authority: "none", credential: "incomplete" });
      const reopened = openLedger(f.dbPath); expect(reopened.query("SELECT 1 FROM agents WHERE agent_id = ?").get(first.agent_id)).toBeNull(); reopened.close();
    } finally { f.clean(); }
  });

});
