import type { Database } from "bun:sqlite";
import { OWNER } from "../agents";
import { consolidationConfig, type ConsolidationConfig } from "../contracts/consolidation";
import { activeWorldRegistry } from "../contracts/world-vocabulary";
import { newReadFrame, WorldProjectionBudgetError } from "../world/pipeline/frame";
import { scanMatches } from "../world/pipeline/collect";
import { collectConsolidationBasis } from "../world/consolidation/basis";
import { budgetDay, readDailyBudget } from "./budget-ledger";
import { CONSOLIDATION_CALLS, CONSOLIDATION_OUTPUT, CONSOLIDATION_OBSERVED_OUTPUT } from "./consolidate";

export interface ConsolidationDoctor {
  readonly backlog: number;
  readonly backlog_capped: boolean;
  readonly last_success_at: string | null;
  readonly last_failure: { readonly at: string; readonly outcome: string } | null;
  readonly next_retry_at: string | null;
  readonly stopped: string | null;
  readonly observed_output_tokens: number;
  readonly budget: Readonly<Record<string, { used: number; limit: number }>>;
  readonly detail: string;
}
/** Owner diagnostics only; scoped reads never consult this aggregate. */
export function consolidationDoctor(db: Database, at: string, configured: boolean, options?: ConsolidationConfig): ConsolidationDoctor {
  const config = consolidationConfig(options), day = budgetDay(at);
  let backlog = 0, examined = 0, capped = false;
  const kinds = activeWorldRegistry().kinds;
  const frame = () => newReadFrame({ db, vaultPath: "", principal: OWNER }, { id: "consolidation-doctor", principalId: "owner" }, { kind: "all" });
  let steps = 0;
  for (const kind of kinds) {
    let after: string | null = null;
    do {
      if (examined >= 64 || steps++ >= 64 + kinds.length) { capped = true; break; }
      const scan = scanMatches(frame(), kind, "", after, 1);
      for (const candidate of scan.found) {
        examined += 1;
        try {
          const basis = collectConsolidationBasis(frame(), candidate.handle, kind.id);
          if (basis === null || db.query("SELECT 1 FROM world_consolidation WHERE basis_digest=? AND status='complete' AND expires_at>?").get(basis.digest, at) === null) backlog += 1;
        } catch (error) {
          if (!(error instanceof WorldProjectionBudgetError)) throw error;
          backlog += 1; capped = true;
        }
      }
      after = scan.resumeAfter;
    } while (after !== null);
    if (examined >= 64 || steps >= 64 + kinds.length) { capped = true; break; }
  }
  const lastSuccess = db.query<{ at: string | null }, []>("SELECT max(completed_at) AS at FROM world_consolidation WHERE status='complete'").get()?.at ?? null;
  const lastFailure = db.query<{ at: string; outcome: string }, []>("SELECT updated_at AS at,outcome FROM world_consolidation_jobs WHERE basis_digest IS NOT NULL AND outcome NOT IN ('complete','running') ORDER BY updated_at DESC LIMIT 1").get();
  const next = db.query<{ at: string | null }, []>("SELECT min(next_at) AS at FROM world_consolidation_jobs WHERE basis_digest IS NOT NULL AND next_at IS NOT NULL").get()?.at ?? null;
  const stopped = db.query<{ outcome: string | null }, []>("SELECT outcome FROM world_consolidation_jobs WHERE job_key='cursor'").get()?.outcome ?? null;
  const observed = readDailyBudget(db, day, CONSOLIDATION_OBSERVED_OUTPUT), charged = readDailyBudget(db, day, CONSOLIDATION_OUTPUT);
  return { backlog, backlog_capped: capped, last_success_at: lastSuccess, last_failure: lastFailure, next_retry_at: next, stopped,
    observed_output_tokens: observed,
    budget: { calls: { used: readDailyBudget(db, day, CONSOLIDATION_CALLS), limit: config.max_calls_per_day },
      output_tokens_charged: { used: charged, limit: config.max_output_tokens_per_day } },
    detail: `consolidation: ${configured ? "configured" : "off (no model)"}; pending${capped ? " at least" : ""}=${backlog}; output observed=${observed}, charged=${charged}; last success=${lastSuccess ?? "none"}; last failure=${lastFailure?.outcome ?? "none"}; retry=${next ?? "none"}${stopped === null ? "" : `; ${stopped}`}` };
}
