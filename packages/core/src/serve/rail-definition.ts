import type { Database } from "bun:sqlite";
import type { BudgetTracker } from "../canon/budget";
import type { WorkContext } from "./doctor-rails";
import type { AnyRailHooks } from "./rail-hooks";
import type { RunExecution, RunReceipt, ServeConfig } from "./types";

/**
 * What the loop hands a rail for one run. Execution holds the writer
 * lease and attempts interrupted canon recovery before `run` starts unless
 * the definition opts out of recovery. A held recovery still blocks new canon writes.
 * `budget` is the shared durable budget: a rail that spends canon writes
 * stops with `budget:*` when it is exhausted.
 */
export interface RailRunContext {
  readonly db: Database;
  readonly vault_path: string;
  readonly run_id: string;
  /** Identity shared by the final receipt and durable repair progress. */
  readonly execution: RunExecution;
  readonly started_at: string;
  readonly now: () => string;
  readonly config: ServeConfig;
  readonly budget: BudgetTracker;
  readonly hooks: AnyRailHooks | undefined;
  /** The daemon's stop request or signal; a long rail reads it between steps. */
  readonly stop_requested: (() => boolean) | undefined;
}

/** Work a rail has waiting, up to a bound, and what it is made of. */
export interface PendingWork {
  readonly count: number;
  readonly detail: string;
}

/**
 * Work waiting for the rail at `asOf`, counted up to `limit`, or null when the
 * rail has no backlog it could work down.
 */
export type RailWorkProbe = (context: WorkContext, limit: number, asOf: string) => PendingWork | null;

interface RailFields {
  /** One plain sentence for the operator table in the docs. */
  readonly summary: string;
  /** One run. It returns what changed; a thrown error becomes a failed receipt. */
  readonly run: (context: RailRunContext) => Promise<Partial<RunReceipt>> | Partial<RunReceipt>;
  /** Checked before the loop touches the journals; a throw is this run's failed receipt. */
  readonly preflight?: (db: Database) => void;
  /** False for a rail that must run while a canon write is still held. Defaults to true. */
  readonly recover_canon?: boolean;
  /** The period the vault's configuration asks for, applied when the service starts. */
  readonly configured_period_s?: (vaultPath: string) => number;
  /** The longer period the rail may back off to while it has no configured work. */
  readonly idle_period_s?: number;
  /** Pins the due slot to this UTC hour of the day instead of a fixed period. */
  readonly slot_hour?: (config: Pick<ServeConfig, "brief_hour">) => number;
  /** The file a run leaves behind. A rail that writes one always keeps its receipt, idle or not. */
  readonly artifact?: (vaultPath: string, day: string) => string;
  /** The rail ends degraded to report what doctor found, so a degraded streak is not its own fault. */
  readonly degrades_on_findings?: boolean;
}

/**
 * `expects_output` says a run with work waiting must produce something: doctor
 * counts an empty streak only for such rails, and needs `doctor` to know what
 * waits. A rail judged by staleness and failure alone sets it to false.
 */
export type RailBehavior = RailFields &
  (
    | { readonly expects_output: true; readonly doctor: RailWorkProbe }
    | { readonly expects_output: false; readonly doctor?: undefined }
  );

export type RailDefinition = RailBehavior & {
  /** Lowercase words joined by hyphens; the id in schedules, receipts and doctor. */
  readonly id: string;
  readonly period_s: number;
  readonly jitter_s: number;
};

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 48;
/** Bound fixed periods to signed 32-bit seconds, well within Date's range. */
const MAX_PERIOD_S = 2_147_483_647;

export function assertRailPeriod(seconds: number, field = "period_s"): void {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_PERIOD_S) {
    throw new TypeError(`${field} must be an integer between 1 and ${MAX_PERIOD_S}`);
  }
}

/** Validate a rail once, where it is written, so no later reader has to. */
export function defineRail(definition: RailDefinition): RailDefinition {
  const { id, period_s, jitter_s } = definition;
  if (!ID.test(id) || id.length > MAX_ID_LENGTH) throw new TypeError(`invalid rail id: ${JSON.stringify(id)}`);
  assertRailPeriod(period_s);
  if (!Number.isSafeInteger(jitter_s) || jitter_s < 0 || jitter_s >= period_s) throw new TypeError(`rail ${id}: jitter_s must be an integer below the period`);
  const { idle_period_s } = definition;
  if (idle_period_s !== undefined) assertRailPeriod(idle_period_s, "idle_period_s");
  if (idle_period_s !== undefined && idle_period_s <= period_s) {
    throw new TypeError(`rail ${id}: idle_period_s must be an integer above the period`);
  }
  return Object.freeze({ ...definition });
}
