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
  }, { response_contract: "kizuki.envelope/v2" })) as { data: unknown };
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
    expect(Object.keys(served).sort()).toEqual(["at", "canon", "data", "principal", "quoted", "schema", "tool"]);

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
    }, { response_contract: "kizuki.envelope/v2" })) as { data: { result: { data: { concept: { ref: unknown } } } } };
    const wire = JSON.stringify(card);
    expect(wire).not.toContain(PASSWORD);
    expect(wire).toContain("[redacted:secret_assignment]");
    expect(card.data.result.data.concept.ref).toEqual(ref);
  } finally {
    db.close();
  }
});
