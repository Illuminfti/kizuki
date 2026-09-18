import { DependencyGraph } from "./graph";
import { REFLEX_SCHEMA, type Change, type ReflexReport, type Snapshot } from "./types";
import { deepFreeze, validatedInput } from "./validate";

/** What breaks IF these nominated assumptions change? No model or factual claim. */
export function simulateChange(rawSnapshot: Snapshot, rawChange: Change): ReflexReport {
  const start = performance.now();
  const { snapshot, change } = validatedInput(rawSnapshot, rawChange);
  const judgments = change.target_ids.map((target_id) => ({ target_id, effect: "needs_revalidation" as const,
    reason: "counterfactual_assumption" as const }));
  return deepFreeze({ schema: REFLEX_SCHEMA, advisory_only: true, authorizes_execution: false,
    mode: "counterfactual", binding: snapshot.binding, change_id: change.id,
    status: Date.parse(snapshot.binding.expires_at) <= Date.now() ? "stale" : "complete",
    analyzed_revisions: snapshot.nodes.map((n) => ({ node_id: n.id, revision: n.revision })),
    judgments, impacts: new DependencyGraph(snapshot).impacts(judgments),
    metrics: { candidates: judgments.length, requests_started: 0, questions_started: 0, max_in_flight: 0,
      request_bytes: 0, input_tokens: 0, output_tokens: 0, usage_complete: true, elapsed_ms: Math.round((performance.now() - start) * 100) / 100 },
  });
}
