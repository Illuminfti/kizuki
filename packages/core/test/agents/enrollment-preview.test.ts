import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEnrollmentError, previewAgentEnrollment } from "../../src/agents/enrollment";
import { openLedger } from "../../src/ledger/db";

function request(destination: string) {
  return {
    operation_id: "preview-0001", name: "preview-agent", token_ref: `file:${destination}`,
    grant: { ceiling: "public" as const, types: [], subjects: [], since: null, until: null, tools: [], rate_limit_per_minute: 60, relay_owner_corrections: false },
  };
}

function fixture(): { vault: string; dbPath: string; clean(): void } {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-enrollment-preview-"));
  const control = join(vault, ".kizuki"); mkdirSync(control); chmodSync(control, 0o700);
  const dbPath = join(control, "kizuki.db"); const db = openLedger(dbPath); db.close(); chmodSync(dbPath, 0o600);
  return { vault, dbPath, clean: () => rmSync(vault, { recursive: true, force: true }) };
}

describe("agent enrollment preview", () => {
  test("reads a current initialized ledger without changing it", () => {
    const f = fixture();
    try {
      const before = readFileSync(f.dbPath);
      expect(previewAgentEnrollment(f.vault, request(join(tmpdir(), "credential.json")))).toMatchObject({ status: "preview", authority: "none", credential: "absent" });
      expect(readFileSync(f.dbPath)).toEqual(before);
    } finally { f.clean(); }
  });

  test("reports migration_required without writing an old ledger", () => {
    const f = fixture();
    try {
      const db = openLedger(f.dbPath); db.query("UPDATE schema_version SET version = 16").run(); db.close();
      const before = readFileSync(f.dbPath);
      expect(() => previewAgentEnrollment(f.vault, request(join(tmpdir(), "credential.json")))).toThrow(AgentEnrollmentError);
      try { previewAgentEnrollment(f.vault, request(join(tmpdir(), "credential.json"))); } catch (error) { expect((error as AgentEnrollmentError).code).toBe("migration_required"); }
      expect(readFileSync(f.dbPath)).toEqual(before);
    } finally { f.clean(); }
  });
});
