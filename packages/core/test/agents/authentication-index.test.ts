import { describe, expect, spyOn, test } from "bun:test";
import {
  DEFAULT_GRANT,
  addAgent,
  authenticate,
  getAgent,
  listQuarantinedAgents,
  revokeAgent,
  rotateToken,
  setGrant,
} from "../../src/agents";
import { hashAgentToken } from "../../src/agents/identity";
import { agentsDb } from "./helpers";

function otherToken(token: string): string {
  return `${token.slice(0, -1)}${token.endsWith("0") ? "G" : "0"}`;
}

describe("indexed agent authentication", () => {
  for (const count of [1, 100, 2_048]) {
    test(`uses one indexed full-hash lookup for hits and misses among ${count} agents`, () => {
      const db = agentsDb();
      try {
        const target = addAgent(db, "target-reader");
        db.transaction(() => {
          for (let i = 1; i < count; i++) addAgent(db, `other-reader-${i}`);
        }).immediate();
        const prepare = spyOn(db, "prepare");
        let queries: string[];
        try {
          expect(authenticate(db, target.token)).toMatchObject({ kind: "agent", agent: target.agent });
          expect(authenticate(db, otherToken(target.token))).toBeNull();
          queries = prepare.mock.calls.map(([sql]) => sql);
        } finally {
          prepare.mockRestore();
        }

        expect(queries).toHaveLength(2);
        expect(queries[0]).toBe(queries[1]);
        const sql = queries[0]!;
        expect(sql).toMatch(/\bWHERE\s+a\.token_hash\s*=\s*\?/i);
        expect(sql).not.toContain(target.token);
        const plan = db
          .query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${sql}`)
          .all(hashAgentToken(target.token))
          .map(({ detail }) => detail)
          .join("\n");
        expect(plan).toMatch(/\bSEARCH a\b.*\(token_hash=\?\)/i);
        expect(plan).not.toMatch(/\bSCAN [ag]\b/i);
      } finally {
        db.close();
      }
    });
  }

  test("rejects malformed input without preparing a database statement", () => {
    const db = agentsDb();
    const prepare = spyOn(db, "prepare");
    try {
      for (const input of [null, undefined, 12, "", "not-a-token", `kzk_${"I".repeat(52)}`, `kzk_${"A".repeat(53)}`]) {
        expect(authenticate(db, input as string)).toBeNull();
      }
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      db.close();
    }
  });

  test("denies a well-formed token in an empty database", () => {
    const source = agentsDb();
    const target = agentsDb();
    try {
      const { token } = addAgent(source, "absent-reader");
      expect(authenticate(target, token)).toBeNull();
    } finally {
      source.close();
      target.close();
    }
  });

  test("preserves existing tokens and reads changed grants, rotation and revocation", () => {
    const db = agentsDb();
    try {
      const created = addAgent(db, "lifecycle-reader");
      expect(authenticate(db, created.token)?.grant).toEqual(DEFAULT_GRANT);
      setGrant(db, "lifecycle-reader", { tools: ["search"], subjects: ["person:ada"] });
      const changed = authenticate(db, created.token);
      expect(changed?.grant.tools).toEqual(["search"]);
      expect(changed?.grant.subjects).toEqual(["person:ada"]);
      expect(changed).toMatchObject({ kind: "agent", grant_epoch: 2 });

      const replacement = rotateToken(db, "lifecycle-reader");
      expect(authenticate(db, created.token)).toBeNull();
      expect(authenticate(db, replacement)).toMatchObject({ kind: "agent", grant_epoch: 3 });
      revokeAgent(db, "lifecycle-reader");
      expect(authenticate(db, replacement)).toBeNull();
      expect(getAgent(db, "lifecycle-reader")?.revoked_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("quarantines a corrupt matching grant without affecting other identities", () => {
    const db = agentsDb();
    try {
      const corrupt = addAgent(db, "corrupt-reader");
      const healthy = addAgent(db, "healthy-reader");
      db.query("UPDATE agent_grants SET tools = ? WHERE agent_id = ?")
        .run("{", corrupt.agent.agent_id);

      expect(authenticate(db, otherToken(corrupt.token))).toBeNull();
      expect(listQuarantinedAgents(db)).toEqual([]);
      expect(authenticate(db, corrupt.token)).toBeNull();
      const quarantined = listQuarantinedAgents(db);
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]?.agent_id).toBe(corrupt.agent.agent_id);
      expect(quarantined[0]?.reason).toBe("invalid_grant");
      expect(authenticate(db, corrupt.token)).toBeNull();
      expect(listQuarantinedAgents(db)).toEqual(quarantined);
      expect(authenticate(db, healthy.token)).toMatchObject({ kind: "agent", agent: healthy.agent });
    } finally {
      db.close();
    }
  });

  test("does not authenticate an identity with a missing grant", () => {
    const db = agentsDb();
    try {
      const { agent, token } = addAgent(db, "missing-grant-reader");
      db.query("DELETE FROM agent_grants WHERE agent_id = ?").run(agent.agent_id);
      expect(authenticate(db, token)).toBeNull();
      expect(getAgent(db, agent.name)).toEqual(agent);
    } finally {
      db.close();
    }
  });

  test("keeps a quarantined identity denied even when its stored grant is valid", () => {
    const db = agentsDb();
    try {
      const { agent, token } = addAgent(db, "quarantined-reader");
      db.query("UPDATE agents SET quarantined_at = ? WHERE agent_id = ?")
        .run("2026-01-01T00:00:00Z", agent.agent_id);
      expect(authenticate(db, token)).toBeNull();
      setGrant(db, agent.name, { tools: [] });
      expect(authenticate(db, token)?.grant.tools).toEqual([]);
    } finally {
      db.close();
    }
  });
});
