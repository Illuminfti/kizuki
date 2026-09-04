import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OWNER, getAgent, initAgents } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { serveHealth } from "../../src/serving/health";
import { servePropose } from "../../src/serving/propose";
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
      total: 11,
      active: 10,
      labeled: 10,
      stamped: 10,
      servable: 7,
      held: 1,
    });
    expect(data?.events).toBe(6);
    // makeHeldPage writes a page then purges its only source. RFC 0002 §13.1
    // marks that claim purged; nothing live remains until a later file.
    expect(data?.live_claims).toBe(0);
    // Nothing bound a retrieval port, so nothing is waiting on one.
    expect(data?.pending_retrieval_ops).toBe(0);
    expect(data?.derived.search).not.toBeNull();
    expect(data?.derived.graph).not.toBeNull();
    expect(data?.agents).toEqual({ total: 11, revoked: 1, quarantined: 0 });
  });

  test("a filed claim shows up as one the writer can act on", async () => {
    await servePropose(fixture.agent("reader-private"), {
      kind: "claim",
      target: "facts:health-candidate",
      body: "The kettle counts as one claim.",
      subjects: ["person:ada"],
      provenance: [fixture.events["public"] as string],
    });
    expect(serveHealth(fixture.owner()).data?.live_claims).toBe(1);
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

  test("a corrupt grant still counts and is named once found", () => {
    const live = serveFixture();
    const agentId = getAgent(live.db, "search-only")?.agent_id;
    if (agentId === undefined) throw new Error("search-only fixture is missing");
    live.db
      .query("UPDATE agent_grants SET tools = ? WHERE agent_id = ?")
      .run('["not-a-tool"]', agentId);

    expect(serveHealth(live.owner()).data?.agents).toEqual({
      total: 11,
      revoked: 1,
      quarantined: 1,
    });
    live.dispose();
  });

  test("a database without a claim store reports no claims", () => {
    const db = openLedger(":memory:");
    initAgents(db);
    const data = serveHealth({
      db,
      vaultPath: fixture.vaultPath,
      principal: OWNER,
    }).data;
    expect(data?.live_claims).toBe(0);
    expect(data?.derived).toEqual({ search: null, graph: null });
    expect(data?.connections).toEqual([]);
    db.close();
  });
});
