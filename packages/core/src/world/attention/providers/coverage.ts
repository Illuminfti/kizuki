import type { AttentionState } from "../../../contracts/attention";
import type { ViewGap } from "../../../contracts/world-card-kit";

/** Coverage failures remain distinct from a successful read with no cue. */
export function attentionCoverageStates(gaps: ReadonlySet<ViewGap>, observed: boolean, failures: ReadonlySet<"model_unavailable" | "provider_error">): AttentionState[] {
  const states: AttentionState[] = [];
  if (!observed || gaps.has("coverage") || gaps.has("traversal_limit")) states.push({ state: "missing_coverage", reason: "source_unobserved" });
  if (gaps.has("stale_dependencies") || gaps.has("pending_consolidation")) states.push({ state: "stale_consolidation", reason: "summary_older_than_ledger" });
  for (const reason of [...failures].sort()) states.push({ state: "provider_failure", reason });
  return states;
}
