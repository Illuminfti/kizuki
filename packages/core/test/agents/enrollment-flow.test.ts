import { credentialCustodyQualified, initializeEnrollmentLedger } from "./custody-fixture";
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEnrollmentError, authenticateAgentCredential, enrollAgent, previewAgentEnrollment, revokeAgentEnrollment } from "../../src/agents/enrollment";
import { openLedger } from "../../src/ledger/db";

// These tests spawn real processes; bound them for a loaded host.
setDefaultTimeout(30_000);

// Metadata only: a failed immutable preview must distinguish retained journals
// from a directory/main-file change without printing requests or credentials.
function ledgerObservation(vault: string) {
  return ["", "kizuki.db", "kizuki.db-wal", "kizuki.db-shm", "kizuki.db-journal"].map(name => {
    const stat = lstatSync(join(vault, ".kizuki", name), { bigint: true, throwIfNoEntry: false });
    return { name, metadata: stat === undefined ? null : {
      dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mode: String(stat.mode),
      uid: String(stat.uid), gid: String(stat.gid), nlink: String(stat.nlink),
      mtime_ns: String(stat.mtimeNs), ctime_ns: String(stat.ctimeNs),
    } };
  });
}
function previewWithObservation(vault: string, request: Parameters<typeof previewAgentEnrollment>[1]) {
  const before = ledgerObservation(vault);
  try { return previewAgentEnrollment(vault, request); }
  catch (error) {
    throw new Error(JSON.stringify({ code: error instanceof AgentEnrollmentError ? error.code : "unexpected_preview_error", before, after: ledgerObservation(vault) }));
  }
}

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-enrollment-flow-vault-"));
  const control = join(vault, ".kizuki"); mkdirSync(control); chmodSync(control, 0o700);
  const dbPath = join(control, "kizuki.db"); initializeEnrollmentLedger(dbPath);
  const credentials = mkdtempSync(join(tmpdir(), "kizuki-enrollment-flow-credential-")); chmodSync(credentials, 0o700);
  const request = { operation_id: "enroll-flow-0001", name: "flow-agent", token_ref: `file:${join(credentials, "agent.json")}`, grant: { ceiling: "public" as const, types: [], subjects: [], since: null, until: null, tools: [], rate_limit_per_minute: 60, relay_owner_corrections: false } };
  return { vault, dbPath, request, clean: () => { rmSync(vault, { recursive: true, force: true }); rmSync(credentials, { recursive: true, force: true }); } };
}
describe.if(credentialCustodyQualified)("agent enrollment flow", () => {
  test("pending erasure refuses new enrollment before credential creation, while completed replay and revoke work", () => {
    const f = fixture(); try {
      const first = enrollAgent(f.vault, f.request);
      const db = openLedger(f.dbPath);
      try {
        db.query("INSERT INTO canon_source_erasure_intents(page_path,source_key,intent,digest) VALUES (?,?,?,?)")
          .run("unrelated-private-path", "unrelated-source", "{}", "unreadable");
      } finally { db.close(true); }
      const next = { ...f.request, operation_id: "enroll-flow-0002", name: "next-agent", token_ref: f.request.token_ref + ".next" };
      expect(() => enrollAgent(f.vault, next)).toThrow("erasure_pending");
      expect(existsSync(next.token_ref.slice(5))).toBe(false);
      const inspect = openLedger(f.dbPath);
      try {
        expect(inspect.query("SELECT 1 FROM agent_enrollments WHERE operation_id=?").get(next.operation_id)).toBeNull();
        expect(inspect.query("SELECT 1 FROM agents WHERE name=?").get(next.name)).toBeNull();
      } finally { inspect.close(true); }
      expect(enrollAgent(f.vault, f.request)).toMatchObject({ agent_id: first.agent_id, status: "completed", credential: "ready", replayed: true });
      expect(revokeAgentEnrollment(f.vault, f.request.name).authority).toBe("revoked");
    } finally { f.clean(); }
  });
  test("creates one durable credential and replays the completed operation", () => {
    const f = fixture(); try {
      expect(previewWithObservation(f.vault, f.request).status).toBe("preview");
      const first = enrollAgent(f.vault, f.request); expect(first).toMatchObject({ status: "completed", authority: "active", credential: "ready", replayed: false });
      const db = openLedger(f.dbPath); expect(authenticateAgentCredential(db, f.request.token_ref)?.kind).toBe("agent"); db.close(true);
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
      expect(previewWithObservation(f.vault, f.request)).toMatchObject({ status: "completed", authority: "active", credential: "ready" });
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
        import { lstatSync } from "node:fs";
        import { join } from "node:path";
        const original = Database.prototype.prepare, retained = [], sql = new Set();
        Database.prototype.prepare = function(...args) {
          const statement = original.apply(this, args);
          retained.push(statement); sql.add(args[0]); return statement;
        };
        const { AgentEnrollmentError, enrollAgent, revokeAgentEnrollment, previewAgentEnrollment } = await import(${JSON.stringify(join(import.meta.dir, "../../src/agents/enrollment.ts"))});
        ${ledgerObservation.toString()}
        ${previewWithObservation.toString()}
        const vault = ${JSON.stringify(f.vault)}, request = ${JSON.stringify(f.request)};
        assert.equal(enrollAgent(vault, request).authority, "active");
        assert.equal(previewWithObservation(vault, request).credential, "ready");
        assert.equal(enrollAgent(vault, request).credential, "ready");
        assert.equal(revokeAgentEnrollment(vault, request.name).authority, "revoked");
        assert.ok(sql.size > 20, "the actual path must exceed the query cache capacity");
        assert.equal(retained.every(statement => statement.isFinalized), true);
      `;
      const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      expect(child.exitCode, "all retained statement capabilities must finalize: " + child.stderr.toString()).toBe(0);
      expect(child.stdout.length).toBe(0); expect(child.stderr.length).toBe(0);
    } finally { f.clean(); }
  });
  // Real recovery and partial-file refusal live in enrollment-fault.test.ts;
  // never manufacture a crash by rewinding a completed identity and its row.
});
