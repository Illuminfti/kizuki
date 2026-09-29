import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { startLoopback, type Loopback } from "../../core/test/helpers/world-kit/loopback";
import { twoClients, type TwoClients } from "./helpers/two-clients";

// Each test starts real MCP processes; bound them for a loaded host.
setDefaultTimeout(120_000);

let running: TwoClients | null = null;
let loopback: Loopback | null = null;
afterEach(async () => {
  await loopback?.stop();
  loopback = null;
  await running?.close();
  running = null;
});

test("the same concept read over real stdio is answered for the owner and the scoped agent, and audited for both", async () => {
  running = await twoClients();
  const [owner, agent] = [await running.readConcept(running.owner), await running.readConcept(running.agent)];
  for (const answer of [owner, agent]) {
    expect(answer.card).not.toBeNull();
    expect(answer.card).toMatchObject({ schema: "kizuki.envelope/v2", tool: "world_view" });
    expect(JSON.stringify(answer.card)).toContain("Revise beliefs using evidence");
  }
  expect((owner.card as { principal: unknown }).principal).not.toEqual((agent.card as { principal: unknown }).principal);
  const audit = running.audit();
  for (const rows of [audit.owner, audit.agent]) {
    const reads = rows.filter((row) => row.tool === "world_view");
    expect(reads.length).toBe(2);
    for (const row of reads) expect(row.denied).toEqual([]);
  }
});

test("a scoped agent outside the seeded subject gets no match while the owner does, and both calls are audited", async () => {
  running = await twoClients({ agent: { subjects: ["topic:elsewhere"] } });
  const owner = await running.readConcept(running.owner);
  const agent = await running.readConcept(running.agent);
  expect(owner.card).not.toBeNull();
  expect(agent.card).toBeNull();
  const audit = running.audit();
  expect(audit.owner.filter((row) => row.tool === "world_view").length).toBe(2);
  expect(audit.agent.filter((row) => row.tool === "world_view").length).toBe(1);
});

test("the loopback helper reaches the standing endpoint as the owner and as an agent", async () => {
  running = await twoClients();
  loopback = await startLoopback(running.db, running.vaultPath);
  const discovery = await loopback.post("world_view", {
    operation: "find_concepts",
    label: "Bayesian",
    valid: { kind: "all" },
    knownAt: { kind: "current" },
  });
  expect(discovery.status).toBe(200);
  expect(JSON.stringify(discovery.body)).toContain("Bayesian updating");
  expect((await loopback.post("world_view", {}, "not-a-token")).status).toBe(401);
});
