import type { Database } from "bun:sqlite";
import { bindSourceModelPort } from "../../src/ledger/source-grants";
import type { LlmPort } from "../../src/contracts/llm";
import { writeRailCursor } from "../../src/ledger/checkpoints";
import { runWorldJobs } from "../../src/serve/world-jobs";
import { DEFAULT_CONSOLIDATION_CONFIG } from "../../src/contracts/consolidation";

export const EMPTY_SUMMARY_MODEL = { model_endpoint: "https://fixture.invalid/v1/chat/completions", model: "complete-empty-fixture", external_retention: "provider_managed" as const };
/**
 * Synthetic prerequisite for tests asserting a complete conditional card.
 * Sources must opt into EMPTY_SUMMARY_MODEL when initially enrolled; this
 * helper never changes grants or their compare-and-swap revisions. Call before
 * fixing a historical cutoff. The actual job admits complete-null results.
 */
export async function completeEmptyWorldSummaries(db: Database, vaultPath = "", now = () => new Date().toISOString()): Promise<void> {
  const { model_endpoint: endpoint, model } = EMPTY_SUMMARY_MODEL;
  const last = db.query<{ accepted_at: string; event_id: string }, []>("SELECT accepted_at,event_id FROM events ORDER BY accepted_at DESC,event_id DESC LIMIT 1").get();
  if (last !== null) writeRailCursor(db, "kizuki.producer.model", "extract", `${last.accepted_at}\t${last.event_id}`);
  const llm: LlmPort = bindSourceModelPort({
    descriptor: { id: "synthetic.empty", kind: "llm", contract: "kizuki.llm/v1", contract_minor: 0, supports: ["chat"], requires_lease: false, optional_package: null },
    model_ref: "synthetic.empty:complete-empty-fixture@fixture.invalid", health: async () => ({ status: "ready", detail: {} }), close: async () => {},
    complete: async () => ({ text: JSON.stringify({ schema: "kizuki.consolidation-response/v1", status: "complete", summary: null }), model,
      usage: { input_tokens: 1, output_tokens: 1 } }),
  } satisfies LlmPort, { model_endpoint: endpoint, model });
  const config = { ...DEFAULT_CONSOLIDATION_CONFIG, max_calls_per_pass: 32, max_handles_per_pass: 256, max_calls_per_day: 512, max_output_tokens_per_day: 524_288 };
  for (let pass = 0; pass < 32; pass++) {
    const result = await runWorldJobs({ db, vaultPath, now, stopRequested: () => false, modelConfigured: true, llm, consolidation: config });
    if (result.errors.length || result.stopped) throw new Error(`synthetic consolidation prerequisite failed: ${result.reason ?? result.errors.join(",")}`);
    if ((result.consolidation?.calls ?? 0) === 0) return;
  }
  throw new Error("synthetic consolidation prerequisite exceeded its bounded passes");
}
