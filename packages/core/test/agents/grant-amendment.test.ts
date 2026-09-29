import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentEnrollmentError,
  amendAgentGrant,
  authenticateAgentCredential,
  enrollAgent,
  revokeAgentEnrollment,
} from "../../src/agents/enrollment";
import { listAuditPage } from "../../src/agents/audit";
import { inspectAgents } from "../../src/agents/identity";
import { DEFAULT_GRANT, OWNER_AGENT_GRANT, type Grant } from "../../src/agents/types";
import { openLedger } from "../../src/ledger/db";
import { credentialCustodyQualified, initializeEnrollmentLedger } from "./custody-fixture";

setDefaultTimeout(30_000);

const READER: Grant = { ...DEFAULT_GRANT, ceiling: "personal", tools: ["search"], types: null, subjects: null };
const WIDER: Grant = { ...READER, tools: ["search", "world_view"], relay_owner_corrections: true };

function fixture() {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-grant-vault-"));
  const control = join(vault, ".kizuki"); mkdirSync(control); chmodSync(control, 0o700);
  const dbPath = join(control, "kizuki.db"); initializeEnrollmentLedger(dbPath);
  const credentials = mkdtempSync(join(tmpdir(), "kizuki-grant-credential-")); chmodSync(credentials, 0o700);
  const tokenRef = `file:${join(credentials, "agent.json")}`;
  enrollAgent(vault, { operation_id: "enroll-grant-0001", name: "grant-agent", token_ref: tokenRef, grant: READER });
  const code = (run: () => unknown): string | undefined => {
    try { run(); } catch (error) { return error instanceof AgentEnrollmentError ? error.code : `unexpected:${String(error)}`; }
    return undefined;
  };
  return { vault, dbPath, tokenRef, code, clean: () => { rmSync(vault, { recursive: true, force: true }); rmSync(credentials, { recursive: true, force: true }); } };
}

describe.if(credentialCustodyQualified)("agent grant amendment", () => {
  test("replaces the grant, bumps the epoch, audits it and keeps the credential working", () => {
    const f = fixture(); try {
      const db = openLedger(f.dbPath);
      try {
        const before = authenticateAgentCredential(db, f.tokenRef);
        expect(before).toMatchObject({ kind: "agent", grant_epoch: 1 });
        const result = amendAgentGrant(f.vault, { operation_id: "amend-grant-0001", name: "grant-agent", grant: WIDER });
        expect(result).toMatchObject({ schema: "kizuki.agent-grant/v1", name: "grant-agent", grant_epoch: 2, replayed: false });
        expect(result.grant.tools).toEqual(["search", "world_view"]);
        expect(result.grant.relay_owner_corrections).toBe(true);
        const after = authenticateAgentCredential(db, f.tokenRef);
        expect(after).toMatchObject({ kind: "agent", grant_epoch: 2 });
        expect(after?.grant.tools).toEqual(["search", "world_view"]);
        const rows = listAuditPage(db, "grant-agent", { kind: "lifecycle" }).rows.filter(row => row.tool === "agent.grant");
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows[0]!.query_shape)).not.toContain("kzk_");
      } finally { db.close(true); }
    } finally { f.clean(); }
  });

  test("a retry of the same operation replays and a changed request under that id conflicts", () => {
    const f = fixture(); try {
      const request = { operation_id: "amend-grant-0002", name: "grant-agent", grant: WIDER };
      expect(amendAgentGrant(f.vault, request).grant_epoch).toBe(2);
      expect(amendAgentGrant(f.vault, request)).toMatchObject({ grant_epoch: 2, replayed: true });
      expect(f.code(() => amendAgentGrant(f.vault, { ...request, grant: { ...WIDER, rate_limit_per_minute: 5 } }))).toBe("operation_conflict");
      expect(f.code(() => amendAgentGrant(f.vault, { ...request, operation_id: "enroll-grant-0001" }))).toBe("operation_conflict");
      const db = openLedger(f.dbPath);
      try { expect(inspectAgents(db).find(agent => agent.name === "grant-agent")).toMatchObject({ grant_epoch: 2, state: "active" }); }
      finally { db.close(true); }
    } finally { f.clean(); }
  });

  test("fails closed on unknown, revoked, malformed and reserved input without changing state", () => {
    const f = fixture(); try {
      const base = { operation_id: "amend-grant-0003", name: "grant-agent", grant: WIDER };
      expect(f.code(() => amendAgentGrant(f.vault, { ...base, name: "no-such-agent" }))).toBe("unknown_agent");
      expect(f.code(() => amendAgentGrant(f.vault, { ...base, name: "owner" }))).toBe("invalid_request");
      expect(f.code(() => amendAgentGrant(f.vault, { ...base, operation_id: "short" }))).toBe("invalid_request");
      expect(f.code(() => amendAgentGrant(f.vault, { ...base, extra: true } as never))).toBe("invalid_request");
      expect(f.code(() => amendAgentGrant(f.vault, { ...base, grant: { ...WIDER, tools: ["not_a_tool"] } as never }))).toBe("invalid_grant");
      expect(f.code(() => amendAgentGrant(f.vault, { ...base, grant: { ...WIDER, ceiling: "secret" } as never }))).toBe("invalid_grant");
      const { relay_owner_corrections: _dropped, ...partial } = WIDER;
      expect(f.code(() => amendAgentGrant(f.vault, { ...base, grant: partial as never }))).toBe("invalid_grant");
      revokeAgentEnrollment(f.vault, "grant-agent");
      expect(f.code(() => amendAgentGrant(f.vault, base))).toBe("unknown_agent");
      const db = openLedger(f.dbPath);
      try {
        expect(inspectAgents(db).find(agent => agent.name === "grant-agent")).toMatchObject({ state: "revoked", grant: READER });
        expect(listAuditPage(db, "grant-agent", { kind: "lifecycle" }).rows.some(row => row.tool === "agent.grant")).toBe(false);
      } finally { db.close(true); }
    } finally { f.clean(); }
  });

  test("the owner preset carries world_view while the inert default stays inert", () => {
    expect(OWNER_AGENT_GRANT.tools).toContain("world_view");
    expect(DEFAULT_GRANT).toMatchObject({ ceiling: "public", tools: [], types: [], subjects: [], relay_owner_corrections: false });
  });
});
