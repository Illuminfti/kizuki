import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
describe("agent enrollment flow", () => {
  test("creates one durable credential and replays the completed operation", () => {
    const f = fixture(); try {
      expect(previewAgentEnrollment(f.vault, f.request).status).toBe("preview");
      const first = enrollAgent(f.vault, f.request); expect(first).toMatchObject({ status: "completed", authority: "active", credential: "ready", replayed: false });
      const db = openLedger(f.dbPath); expect(authenticateAgentCredential(db, f.request.token_ref)?.kind).toBe("agent"); db.close();
      expect(enrollAgent(f.vault, f.request)).toMatchObject({ status: "completed", credential: "ready", replayed: true });
    } finally { f.clean(); }
  });
});
