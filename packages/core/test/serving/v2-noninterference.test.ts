import { afterEach, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { OWNER_AGENT_GRANT, TOOLS, addAgent, authenticate } from "../../src/agents";
import { initGraph } from "../../src/graph/schema";
import { openLedger } from "../../src/ledger/db";
import { initSearch } from "../../src/search/schema";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { HIDDEN_MUTATIONS, checkNoninterference, observe } from "../helpers/noninterference";
import type { NoninterferenceScene, ReadCase } from "../helpers/noninterference";
import { tempVault } from "../helpers/vault";
import { worldSeed } from "../helpers/world-seed";

setDefaultTimeout(120_000);
afterEach(() => setSystemTime());

/** Real tool inputs. Writes use a denied hidden target, so observation never changes visible state. */
function cases(scene: NoninterferenceScene): ReadCase[] {
  const inputs: Record<(typeof TOOLS)[number], Record<string, unknown>> = {
    search: { query: "Bayesian", scope: "all" },
    get_page: { id: "absent:page" },
    query_entities: { type: "topic" },
    timeline: { since: "2026-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z" },
    context_packet: { query: "Bayesian", budget_tokens: 1_000 },
    graph_neighbors: { id: "absent:page" },
    system_health: {},
    world_view: { operation: "concept", concept: scene.refs.concept, valid: { kind: "all" }, knownAt: { kind: "current" } },
    propose: { kind: "claim", body: "A note", subjects: ["topic:bayes"], provenance: [scene.hidden.eventId] },
    correct: { statement: "Use the revised definition.", target: { claim_id: scene.hidden.claims[2] }, dry_run: true },
  };
  return TOOLS.map((tool) => ({
    name: tool,
    async run(ctx) {
      const envelope = await dispatchServeTool(ctx, tool, inputs[tool], { response_contract: "kizuki.envelope/v2" });
      if (tool !== "context_packet") return envelope;
      // The harness normalizes random reference tokens. A packet's content
      // digest must also compare literally, so retain it under a distinct key.
      const packet = envelope.data as { result: { view?: { token: string } } };
      return { envelope, baseline: packet.result.view?.token };
    },
  }));
}

test("all ten v2 tools preserve bytes, refusals and work counters across hidden mutations", async () => {
  setSystemTime(new Date("2026-09-30T12:00:00Z"));
  const leaks = await checkNoninterference({ cases, mutations: HIDDEN_MUTATIONS });
  expect(leaks).toEqual([]);
});

test("the first hidden source leaves v2 bytes and work unchanged across the epoch-zero boundary", async () => {
  setSystemTime(new Date("2026-09-30T12:00:00Z"));
  const vault = tempVault("kizuki-v2-policy-");
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  try {
    initSearch(db);
    initGraph(db);
    const principal = authenticate(db, addAgent(db, "scoped-reader", {
      ...OWNER_AGENT_GRANT, ceiling: "public", subjects: ["topic:visible"],
    }).token)!;
    const ctx = { db, vaultPath: vault.path, principal };
    const read: ReadCase = {
      name: "get_page",
      run: (live) => dispatchServeTool(live, "get_page", { id: "absent:page" }, {
        response_contract: "kizuki.envelope/v2",
      }),
    };
    // Issue the principal reference before measuring either read.
    await read.run(ctx);
    const before = await observe(ctx, read);
    await worldSeed(db, { subject: "topic:hidden", floor: "private", discover: false });
    const after = await observe(ctx, read);
    expect(after).toEqual(before);
  } finally {
    db.close();
    vault.dispose();
  }
});
