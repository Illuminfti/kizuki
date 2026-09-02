import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OWNER, initAgents } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { serveHealth } from "../../src/serving/health";
import { serveFixture } from "./helpers";
import type { Fixture } from "./helpers";

let fixture: Fixture;

beforeAll(() => {
  fixture = serveFixture();
});

afterAll(() => {
  fixture.dispose();
});

describe("serveHealth", () => {
  test("the counts describe the vault and the ledger behind it", () => {
    const data = serveHealth(fixture.owner()).data;
    expect(data?.principal).toEqual({
      kind: "owner",
      name: "owner",
      ceiling: "private",
      tools: [...OWNER.grant.tools],
    });
    expect(data?.pages).toEqual({
      total: 10,
      active: 9,
      labeled: 9,
      servable: 7,
      held: 1,
    });
    expect(data?.events).toBe(6);
    expect(data?.pending_proposals).toBe(1);
    expect(data?.derived.search).not.toBeNull();
    expect(data?.derived.graph).not.toBeNull();
    expect(data?.agents).toEqual({ total: 9, revoked: 1 });
  });

  test("an agent sees its own grant and its own servable count", () => {
    const data = serveHealth(fixture.agent("reader-public")).data;
    expect(data?.principal.kind).toBe("agent");
    expect(data?.principal.name).toBe("reader-public");
    expect(data?.principal.ceiling).toBe("public");
    expect(data?.pages.servable).toBeLessThan(7);
  });

  test("connections report checkpoint counts, never error strings", () => {
    const connections = serveHealth(fixture.owner()).data?.connections ?? [];
    expect(connections).toHaveLength(1);
    expect(connections[0]?.connector_id).toBe("fixture");
    expect(connections[0]?.source_key).toBe(fixture.sourceKey);
    expect(connections[0]?.last_result).toEqual({
      stored: 6,
      duplicates: 0,
      errors: 0,
      proposals_created: 0,
      withdrawn: 0,
      retractions_filed: 0,
    });
  });

  test("the report carries no path, token or secret reference", () => {
    const json = JSON.stringify(serveHealth(fixture.owner()).data);
    expect(json).not.toContain(fixture.vaultPath);
    expect(json).not.toContain("kzk_");
    expect(json).not.toContain("file:");
    expect(json).not.toContain("env:");
    expect(json).not.toContain("/");
  });

  test("a database without staging reports no pending proposals", () => {
    const db = openLedger(":memory:");
    initAgents(db);
    const data = serveHealth({
      db,
      vaultPath: fixture.vaultPath,
      principal: OWNER,
    }).data;
    expect(data?.pending_proposals).toBe(0);
    expect(data?.derived).toEqual({ search: null, graph: null });
    expect(data?.connections).toEqual([]);
    db.close();
  });
});
