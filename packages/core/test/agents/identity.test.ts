import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GRANT,
  OWNER,
  OWNER_AGENT_GRANT,
  TOOLS,
  addAgent,
  authenticate,
  getAgent,
  initAgents,
  listAgents,
  listAudit,
  listQuarantinedAgents,
  resolvePrincipal,
  revokeAgent,
  rotateToken,
  setGrant,
  toolAllowed,
} from "../../src/agents";
import type { Grant } from "../../src/agents";
import { agentsDb } from "./helpers";

describe("initAgents", () => {
  test("creates the three STRICT tables and audit index idempotently", () => {
    const db = new Database(":memory:");
    initAgents(db);
    initAgents(db);

    expect(
      db
        .query<{ name: string; strict: number }, []>(
          `SELECT name, strict FROM pragma_table_list
            WHERE name IN ('agents', 'agent_grants', 'agent_audit')
            ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "agent_audit", strict: 1 },
      { name: "agent_grants", strict: 1 },
      { name: "agents", strict: 1 },
    ]);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'agent_audit_by_agent'",
        )
        .get(),
    ).toEqual({ name: "agent_audit_by_agent" });
    db.close();
  });

  test("enforces the grant foreign key", () => {
    const db = agentsDb();
    expect(() =>
      db
        .query(
          `INSERT INTO agent_grants
             (agent_id, ceiling, tools, rate_limit_per_minute, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("missing", "personal", "[]", 60, "2026-01-01T00:00:00Z"),
    ).toThrow(/foreign key/i);
    db.close();
  });
});

describe("agent identity", () => {
  test("adds an agent and authenticates its one-time token", () => {
    const db = agentsDb();
    const created = addAgent(db, "reader-1");

    expect(created.token).toMatch(/^kzk_[0-9A-HJKMNP-TV-Z]{52}$/);
    expect(created.agent.agent_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(authenticate(db, created.token)).toEqual({
      kind: "agent",
      agent: created.agent,
      grant: DEFAULT_GRANT,
      grant_epoch: 1,
    });
    db.close();
  });

  test("never stores the token in the database file", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-agents-"));
    const path = join(directory, "agents.sqlite");
    try {
      const db = new Database(path, { create: true });
      initAgents(db);
      const { token } = addAgent(db, "disk-reader");
      expect(
        db
          .query<{ token_hash: string }, []>("SELECT token_hash FROM agents")
          .get()?.token_hash,
      ).toMatch(/^[0-9a-f]{64}$/);
      db.close();

      expect(readFileSync(path).includes(token)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const malformed = [
    "",
    "not-a-token",
    `kzk_${"A".repeat(51)}`,
    `kzk_${"I".repeat(52)}`,
  ];
  for (const token of malformed) {
    test(`rejects malformed token ${JSON.stringify(token.slice(0, 16))}`, () => {
      const db = agentsDb();
      addAgent(db, "reader-1");
      expect(authenticate(db, token)).toBeNull();
      db.close();
    });
  }

  test("returns null for a well-formed unknown token", () => {
    const source = agentsDb();
    const { token } = addAgent(source, "source-reader");
    const target = agentsDb();
    addAgent(target, "target-reader");

    const principal = authenticate(target, token);
    expect(principal).toBeNull();
    expect(
      principal === null
        ? { allow: false, reason: "unknown_agent" as const }
        : { allow: true },
    ).toEqual({ allow: false, reason: "unknown_agent" });
    source.close();
    target.close();
  });

  const badNames = ["Reader", "two words", "x", "a".repeat(65)];
  for (const name of badNames) {
    test(`rejects invalid name ${JSON.stringify(name.slice(0, 20))}`, () => {
      const db = agentsDb();
      expect(() => addAgent(db, name)).toThrow(/name/);
      db.close();
    });
  }

  test("rejects duplicate names", () => {
    const db = agentsDb();
    addAgent(db, "reader-1");
    expect(() => addAgent(db, "reader-1")).toThrow(/already exists/);
    db.close();
  });

  test("reserves the owner principal name", () => {
    const db = agentsDb();
    expect(() => addAgent(db, "owner")).toThrow(/reserved/);
    db.close();
  });

  test("gets and lists agents with their grants by name", () => {
    const db = agentsDb();
    const zed = addAgent(db, "zed-reader", { ceiling: "private" });
    const ada = addAgent(db, "ada-reader", { tools: ["search"] });

    expect(getAgent(db, "ada-reader")).toEqual(ada.agent);
    expect(getAgent(db, "missing-reader")).toBeNull();
    expect(listAgents(db)).toEqual([
      { ...ada.agent, grant: { ...DEFAULT_GRANT, tools: ["search"] } },
      { ...zed.agent, grant: { ...DEFAULT_GRANT, ceiling: "private" } },
    ]);
    db.close();
  });

  test("revokes authentication without erasing identity", () => {
    const db = agentsDb();
    const { token } = addAgent(db, "reader-1");

    revokeAgent(db, "reader-1");

    expect(authenticate(db, token)).toBeNull();
    expect(getAgent(db, "reader-1")?.revoked_at).toMatch(/Z$/);
    db.close();
  });

  test("rotates a token and invalidates the old token", () => {
    const db = agentsDb();
    const { token: oldToken } = addAgent(db, "reader-1");

    const newToken = rotateToken(db, "reader-1");

    expect(newToken).not.toBe(oldToken);
    expect(authenticate(db, oldToken)).toBeNull();
    expect(authenticate(db, newToken)?.kind).toBe("agent");
    db.close();
  });
});

describe("grants", () => {
  test("applies a partial grant over the defaults", () => {
    const db = agentsDb();
    const { token } = addAgent(db, "reader-1", {
      ceiling: "public",
      types: ["person", "fact"],
      subjects: ["person:ada"],
      tools: ["search", "get_page"],
      rate_limit_per_minute: 12,
    });

    const principal = authenticate(db, token);
    expect(principal?.grant).toEqual({
      ceiling: "public",
      types: ["person", "fact"],
      subjects: ["person:ada"],
      since: null,
      until: null,
      tools: ["search", "get_page"],
      rate_limit_per_minute: 12,
      relay_owner_corrections: true,
    });
    db.close();
  });

  test("patches only named grant fields", () => {
    const db = agentsDb();
    addAgent(db, "reader-1", { subjects: ["person:ada"] });

    expect(
      setGrant(db, "reader-1", {
        ceiling: "private",
        tools: ["timeline"],
      }),
    ).toEqual({
      ...DEFAULT_GRANT,
      ceiling: "private",
      subjects: ["person:ada"],
      tools: ["timeline"],
    });
    db.close();
  });

  test("persists a withdrawn owner-correction relay", () => {
    const db = agentsDb();
    const { token } = addAgent(db, "reader-1");

    expect(
      setGrant(db, "reader-1", { relay_owner_corrections: false })
        .relay_owner_corrections,
    ).toBe(false);
    // Re-read through the seam a live session uses: a grant that only looks
    // withdrawn in the returned object still speaks at the owner's tier.
    expect(authenticate(db, token)?.grant.relay_owner_corrections).toBe(false);
    expect(listAgents(db)[0]?.grant.relay_owner_corrections).toBe(false);

    setGrant(db, "reader-1", { relay_owner_corrections: true });
    expect(authenticate(db, token)?.grant.relay_owner_corrections).toBe(true);
    db.close();
  });

  const invalidPatches: [string, Partial<Grant>][] = [
    ["ceiling", { ceiling: "secret" as Grant["ceiling"] }],
    ["tool", { tools: ["write_page" as (typeof TOOLS)[number]] }],
    ["zero rate", { rate_limit_per_minute: 0 }],
    ["fractional rate", { rate_limit_per_minute: 1.5 }],
    ["huge rate", { rate_limit_per_minute: 1_001 }],
    ["unsafe rate", { rate_limit_per_minute: Number.MAX_SAFE_INTEGER + 1 }],
    ["duplicate-looking type token", { types: ["Person"] }],
    ["oversized subject", { subjects: [`person:${"a".repeat(200)}`] }],
    ["since timestamp", { since: "yesterday" }],
    ["until timestamp", { until: "2026-02-30T00:00:00Z" }],
    [
      "reversed bounds",
      {
        since: "2026-01-01T01:00:00Z",
        until: "2026-01-01T01:30:00+01:00",
      },
    ],
    [
      "sub-millisecond reversed bounds",
      {
        since: "2026-01-01T00:00:00.0009Z",
        until: "2026-01-01T00:00:00.0001Z",
      },
    ],
  ];
  for (const [name, patch] of invalidPatches) {
    test(`rejects invalid ${name}`, () => {
      const db = agentsDb();
      addAgent(db, "reader-1");
      expect(() => setGrant(db, "reader-1", patch)).toThrow();
      expect(listAgents(db)[0]?.grant).toEqual(DEFAULT_GRANT);
      db.close();
    });
  }

  test("refuses lifecycle operations for unknown agents", () => {
    const db = agentsDb();
    expect(() => setGrant(db, "missing-reader", {})).toThrow(/does not exist/);
    expect(() => revokeAgent(db, "missing-reader")).toThrow(/does not exist/);
    expect(() => rotateToken(db, "missing-reader")).toThrow(/does not exist/);
    db.close();
  });

  test("deduplicates scope tokens and bumps the grant epoch", () => {
    const db = agentsDb();
    addAgent(db, "reader-1", {
      types: ["person", "person", "fact"],
      subjects: ["person:ada", "person:ada"],
    });
    const grant = setGrant(db, "reader-1", { ceiling: "public" });
    expect(grant.types).toEqual(["person", "fact"]);
    expect(grant.subjects).toEqual(["person:ada"]);
    const created = authenticate(db, addAgent(db, "reader-2").token);
    expect(created?.kind === "agent" ? created.grant_epoch : 0).toBe(1);
    db.close();
  });
});

describe("immutable grant constants", () => {
  test("exported defaults cannot be mutated in place", () => {
    expect(() => {
      (DEFAULT_GRANT.tools as string[]).push("correct");
    }).toThrow();
    expect(() => {
      (OWNER.grant.tools as string[]).push("search");
    }).toThrow();
    expect(() => {
      (OWNER_AGENT_GRANT.tools as string[]).pop();
    }).toThrow();
    expect(DEFAULT_GRANT.tools.includes("correct")).toBe(false);
    expect(OWNER.grant.tools).toEqual([...TOOLS]);
  });
});

describe("stale principals", () => {
  test("reloads revocation and a reduced grant on the next resolve", () => {
    const db = agentsDb();
    const { token } = addAgent(db, "reader-1", { tools: ["search", "correct"] });
    const snapshot = authenticate(db, token);
    if (snapshot === null || snapshot.kind !== "agent") {
      throw new Error("expected agent");
    }
    expect(toolAllowed(snapshot.grant, "correct")).toBe(true);

    setGrant(db, "reader-1", { tools: ["propose"] });
    const reduced = resolvePrincipal(db, snapshot);
    expect(reduced?.kind === "agent" ? reduced.grant.tools : []).toEqual(["propose"]);
    expect(reduced?.kind === "agent" ? reduced.grant_epoch : 0).toBe(2);
    expect(toolAllowed(snapshot.grant, "correct")).toBe(true);
    expect(toolAllowed(reduced?.grant ?? snapshot.grant, "correct")).toBe(false);

    revokeAgent(db, "reader-1");
    expect(resolvePrincipal(db, snapshot)).toBeNull();
    expect(authenticate(db, token)).toBeNull();
    db.close();
  });
});

describe("propose versus correct authority", () => {
  test("the default grant may propose and must not correct", () => {
    expect(toolAllowed(DEFAULT_GRANT, "propose")).toBe(true);
    expect(toolAllowed(DEFAULT_GRANT, "correct")).toBe(false);
    expect(toolAllowed(OWNER.grant, "correct")).toBe(true);
    const db = agentsDb();
    const { token } = addAgent(db, "reader-1");
    const principal = authenticate(db, token);
    expect(toolAllowed(principal?.grant ?? DEFAULT_GRANT, "correct")).toBe(false);
    setGrant(db, "reader-1", {
      tools: [...DEFAULT_GRANT.tools, "correct"],
      relay_owner_corrections: false,
    });
    expect(authenticate(db, token)?.grant.relay_owner_corrections).toBe(false);
    expect(toolAllowed(authenticate(db, token)?.grant ?? DEFAULT_GRANT, "correct")).toBe(
      true,
    );
    db.close();
  });
});

describe("corrupt identity isolation", () => {
  test("a bad grant row quarantines that agent and leaves others usable", () => {
    const db = agentsDb();
    const good = addAgent(db, "reader-good");
    const bad = addAgent(db, "reader-bad");
    db.query("UPDATE agent_grants SET tools = ? WHERE agent_id = ?").run(
      '["not-a-tool"]',
      bad.agent.agent_id,
    );

    expect(authenticate(db, bad.token)).toBeNull();
    expect(authenticate(db, good.token)?.kind).toBe("agent");
    expect(listAgents(db).map((row) => row.name)).toEqual(["reader-good"]);
    expect(listQuarantinedAgents(db)).toEqual([
      expect.objectContaining({
        name: "reader-bad",
        reason: "invalid_grant",
      }),
    ]);
    db.close();
  });
});

describe("lifecycle audit", () => {
  test("records create, grant, rotate, and revoke without policy bodies", () => {
    const db = agentsDb();
    addAgent(db, "reader-1");
    setGrant(db, "reader-1", { ceiling: "public" });
    rotateToken(db, "reader-1");
    revokeAgent(db, "reader-1");
    const actions = listAudit(db, "reader-1").map((row) => row.tool);
    expect(actions).toEqual([
      "agent.revoke",
      "agent.rotate",
      "agent.grant",
      "agent.create",
    ]);
    const grantRow = listAudit(db, "reader-1").find((row) => row.tool === "agent.grant");
    const shape = JSON.stringify(grantRow?.query_shape ?? {});
    expect(shape).toContain("before_sha256");
    expect(shape).toContain("after_sha256");
    expect(shape).not.toContain("public");
    db.close();
  });
});
