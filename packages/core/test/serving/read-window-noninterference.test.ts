import { expect, test } from "bun:test";
import { dispatchServeTool } from "../../src/serving/dispatch";
import { checkNoninterference } from "../helpers/noninterference";
import type { ReadCase } from "../helpers/noninterference";

// V1 vault-wide epochs belong to the envelope migration. Hold the remaining
// output and all statement/row counters to the principal's readable view.
function withoutLegacyEpochs(envelope: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(envelope));
  if (copy.source_policy) delete copy.source_policy.epoch;
  if (copy.data && typeof copy.data.packet_md === "string") {
    copy.data.packet_md = copy.data.packet_md.split("\n").filter((_: string, index: number) => index !== 1).join("\n");
    delete copy.data.claims_epoch;
    delete copy.data.valid_until;
  }
  return copy;
}

test("hidden mutations leave timeline, health and session output and work unchanged", async () => {
  const tool = (name: string, args: Record<string, unknown>, label = name): ReadCase => ({
    name: label,
    run: async (ctx) => withoutLegacyEpochs(await dispatchServeTool(ctx, name as never, args)),
  });
  const leaks = await checkNoninterference({
    cases: () => [
      tool("search", { query: "Bayesian", scope: "all", limit: 20 }, "search all"),
      tool("search", { query: "priors", scope: "ledger", limit: 20 }, "search ledger"),
      tool("query_entities", { limit: 20 }),
      tool("graph_neighbors", { id: "topic:bayes" }),
      tool("get_page", { id: "nope" }),
      tool("context_packet", { purpose: "recall", budget_tokens: 900, include: ["claims", "timeline", "canon"], since: "2020-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z" }, "recall packet"),
      tool("timeline", { since: "2020-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z", limit: 50 }),
      tool("system_health", {}),
      tool("context_packet", { purpose: "session", budget_tokens: 1200 }),
    ],
  });
  const workBoundaries = new Set(["timeline", "system_health", "context_packet"]);
  expect(leaks.filter(leak => leak.dimension !== "stats" || workBoundaries.has(leak.case))
    .map(({ mutation, case: name, dimension }) => ({ mutation, name, dimension }))).toEqual([]);
});
