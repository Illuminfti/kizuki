import { credentialCustodyQualified } from "./custody-fixture";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authenticateAgentCredential, enrollAgent, previewAgentEnrollment, revokeAgentEnrollment } from "../../src/agents/enrollment";
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
  test("releases the enrollment connection before the next SQLite client opens", () => {
    const f = fixture();
    try {
      expect(enrollAgent(f.vault, f.request).authority).toBe("active");
      // Changing journal mode requires the prior connection to have actually
      // released SQLite, rather than merely marking its JS wrapper closed.
      const db = openLedger(f.dbPath);
      try { expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode=DELETE").get()?.journal_mode).toBe("delete"); }
      finally { db.close(true); }
      expect(previewAgentEnrollment(f.vault, f.request)).toMatchObject({ status: "completed", authority: "active", credential: "ready" });
      expect(revokeAgentEnrollment(f.vault, "flow-agent").authority).toBe("revoked");
      const afterRevoke = openLedger(f.dbPath);
      try { expect(afterRevoke.query<{ journal_mode: string }, []>("PRAGMA journal_mode=DELETE").get()?.journal_mode).toBe("delete"); }
      finally { afterRevoke.close(true); }
    } finally { f.clean(); }
  });
  test("finishes its prepared statements without relying on garbage collection", () => {
    const f = fixture();
    try {
      const script = `
        import { Database } from "bun:sqlite";
        import { strict as assert } from "node:assert";
        const original = Database.prototype.prepare, retained = [], sql = new Set();
        Database.prototype.prepare = function(...args) {
          const statement = original.apply(this, args);
          retained.push(statement); sql.add(args[0]); return statement;
        };
        const { enrollAgent, revokeAgentEnrollment, previewAgentEnrollment } = await import(${JSON.stringify(join(import.meta.dir, "../../src/agents/enrollment.ts"))});
        const vault = ${JSON.stringify(f.vault)}, request = ${JSON.stringify(f.request)};
        assert.equal(enrollAgent(vault, request).authority, "active");
        assert.equal(previewAgentEnrollment(vault, request).credential, "ready");
        assert.equal(enrollAgent(vault, request).credential, "ready");
        assert.equal(revokeAgentEnrollment(vault, request.name).authority, "revoked");
        assert.ok(sql.size > 20, "the actual path must exceed the query cache capacity");
        assert.equal(retained.every(statement => statement.isFinalized), true);
      `;
      const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(child.exitCode, "all retained statement capabilities must finalize").toBe(0);
      expect(child.stdout.length).toBe(0); expect(child.stderr.length).toBe(0);
    } finally { f.clean(); }
  });
  // Real recovery and partial-file refusal live in enrollment-fault.test.ts;
  // never manufacture a crash by rewinding a completed identity and its row.
});
