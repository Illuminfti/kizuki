import { afterEach, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { TOOLS } from "../../src/agents";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { HIDDEN_MUTATIONS, checkNoninterference } from "../helpers/noninterference";
import type { NoninterferenceScene, ReadCase } from "../helpers/noninterference";

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
    run: (ctx) => dispatchServeTool(ctx, tool, inputs[tool], { response_contract: "kizuki.envelope/v2" }),
  }));
}

test("all ten v2 tools preserve bytes, refusals and work counters across hidden mutations", async () => {
  setSystemTime(new Date("2026-09-30T12:00:00Z"));
  const leaks = await checkNoninterference({ cases, mutations: HIDDEN_MUTATIONS });
  expect(leaks).toEqual([]);
});
