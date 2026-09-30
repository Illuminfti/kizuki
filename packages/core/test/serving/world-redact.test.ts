import { expect, test } from "bun:test";
import { OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { openLedger } from "../../src/ledger/db";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { worldFixture } from "./world-fixture";

const PASSWORD = "w".repeat(12);
const LABEL = `Kettle DB_PASSWORD=${PASSWORD}`;

async function discover(db: ReturnType<typeof openLedger>, principal: Parameters<typeof dispatchServeTool>[0]["principal"], vaultPath: string) {
  return (await dispatchServeTool({ db, vaultPath, principal }, "world_view", {
    operation: "find_concepts",
    label: "",
    valid: { kind: "all" },
    knownAt: { kind: "current" },
  })) as { redacted?: Record<string, number>; data: unknown };
}

test("world_view labels are redacted for an agent and raw for the owner", async () => {
  const db = openLedger(":memory:");
  try {
    const world = await worldFixture(db, { label: LABEL });
    const agent = authenticate(db, addAgent(db, "world-redact", { ...OWNER_AGENT_GRANT }).token)!;
    const served = await discover(db, agent, world.ctx.vaultPath);
    const wire = JSON.stringify(served);
    expect(wire).not.toContain(PASSWORD);
    expect(wire).toContain("DB_PASSWORD=[redacted:secret_assignment]");
    expect(served.redacted).toEqual({ secret_assignment: 1 });

    const owner = await discover(db, world.ctx.principal, world.ctx.vaultPath);
    expect(JSON.stringify(owner)).toContain(PASSWORD);
    expect(owner).not.toHaveProperty("redacted");
  } finally {
    db.close();
  }
});

test("a concept card's definitions and evidence carry redacted text and untouched references", async () => {
  const db = openLedger(":memory:");
  try {
    const world = await worldFixture(db, { label: LABEL });
    const agent = authenticate(db, addAgent(db, "world-card", { ...OWNER_AGENT_GRANT }).token)!;
    const found = (await discover(db, agent, world.ctx.vaultPath)) as {
      data: { result: { data: { matches: { ref: { kind: "object"; token: string } }[] } } };
    };
    const ref = found.data.result.data.matches[0]!.ref;
    const card = (await dispatchServeTool({ db, vaultPath: world.ctx.vaultPath, principal: agent }, "world_view", {
      operation: "concept",
      concept: ref,
      valid: { kind: "all" },
      knownAt: { kind: "current" },
    })) as { data: { result: { data: { concept: { ref: unknown } } } } };
    const wire = JSON.stringify(card);
    expect(wire).not.toContain(PASSWORD);
    expect(wire).toContain("[redacted:secret_assignment]");
    expect(card.data.result.data.concept.ref).toEqual(ref);
  } finally {
    db.close();
  }
});

test("conditional views compare and retain the redacted served projection", async () => {
  const db = openLedger(":memory:");
  try {
    const world = await worldFixture(db, { label: LABEL });
    const agent = authenticate(db, addAgent(db, "conditional-redact", { ...OWNER_AGENT_GRANT }).token)!;
    const ctx = { db, vaultPath: world.ctx.vaultPath, principal: agent };
    const input = { operation: "find_concepts", label: "", valid: { kind: "all" }, knownAt: { kind: "current" } };
    const first = await dispatchServeTool(ctx, "world_view", input) as {
      redacted?: Record<string, number>;
      data: { result: { status: string; view: { kind: "view"; token: string } } };
    };
    expect(first.redacted).toEqual({ secret_assignment: 1 });
    const stored = db.query<{ projection: Uint8Array }, [string]>("SELECT projection FROM world_view_tokens WHERE partition_id=(SELECT partition_id FROM world_view_partitions WHERE principal_id=?)").all(agent.kind === "agent" ? agent.agent.agent_id : "owner");
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) expect(Buffer.from(row.projection).toString()).not.toContain(PASSWORD);
    const second = await dispatchServeTool(ctx, "world_view", { ...input, priorView: first.data.result.view });
    expect(second).toMatchObject({ data: { result: { status: "unchanged", view: first.data.result.view } } });
  } finally { db.close(); }
});
