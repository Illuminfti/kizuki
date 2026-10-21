import { VaultMutationError, withVaultMutationSync } from "../vault/mutation-scope";
import { recoverCanonWrites } from "../canon/recovery";
import { CanonRecoveryError, inspectCanonRecovery } from "../canon/write-intent";
import { retryCanonProjectionObligations } from "../canon/projection-obligations";
import { isLedgerBusy, withControlWait } from "../ledger/busy";
import { LEDGER_LOOP_PROBE_TIMEOUT_MS } from "../ledger/limits";
import { LedgerLeaseHeldError, railLeaseHeldNote } from "./lease-held";
import { acquireLease, leaseState, pidAlive, readBootId, releaseLease, thisProcess, type LeaseProcess } from "./leases";
import { statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { skipCaptureFanoutClaims } from "../claims/capture-fanout";
import { pendingRetrievalOps, retryRetrievalOps } from "../claims/store";
import { BudgetExhausted, type BudgetTracker } from "../canon/budget";
import { PortError } from "../contracts/ports";
import { inspectPurgeHealth, listPurgeRecoveryReceipts, resumePurge } from "../ledger/purge";
import { tableExists } from "../ledger/schema";
import { ulid } from "../util/ulid";
import { createDurableWriteBudget } from "./budget-ledger";
import { embedBackfillPeriod, loadEmbeddingSelection, loadServeConfig } from "./config";
import { composeBrief, repairBriefPages, type BriefRepair } from "./brief";
import { parseFrontmatter } from "../vault/frontmatter";
import { inspectServeDoctor } from "./doctor";
import { createFileNotifier } from "./notifier-file";
import { CAPTURE_REPAIR_RECEIPT_PENDING, stageCaptureRepairReceipt, coalesceNoopReceipt, recoverRunJournal, getRunReceipt, nextScheduleSlot, persistRunReceipt, pruneRunReceipts, redactReceiptError } from "./receipts";
import { applyRailPeriod, initServe, listSchedules } from "./schema";
import { railDefinition } from "./rail-registry";
import type { RailRunContext } from "./rail-definition";
import {
  InjectedCrash,
  LEDGER_LEASE_HELD_STOP,
  ServeDaemonError,
  emptyRunTotals,
  type CrashPoint,
  type RailId,
  type RunReceipt,
  type RunExecution,
  type ServeConfig,
} from "./types";
import { STOP_REQUESTED, runWritePass } from "./write-pass";
import { LegacyExtractReconciliationError } from "./extract";

export type { AnyRailHooks, RailHooks, RailHooksV2, RailRefreshReport, RailRuntime, RailRuntimeV2, RailSyncDrain, RailSyncResult } from "./rail-hooks";
import type { AnyRailHooks, RailHooks, RailHooksV2, RailRefreshReport, RailRuntime, RailRuntimeV2 } from "./rail-hooks";

type AnyRailRuntime = RailRuntime | RailRuntimeV2;

/** What a host learns when a rail asks it for its runtime. */
export interface RailRuntimeContext {
  /** Aborted when the daemon is told to stop; a request in flight must end with it. */
  readonly signal: AbortSignal;
}

const processInstance = crypto.randomUUID();

export interface RunRailOptions {
  readonly execution?: RunExecution;
  readonly now?: () => string;
  /** The daemon's stop request or signal; a sync pass reads it before every extraction step. */
  readonly stopRequested?: () => boolean;
  /** Aborted with the daemon's stop, and handed to `acquireRuntime`. */
  readonly signal?: AbortSignal;
  /** The caller found the ledger held: skip the pass without touching it and record why. */
  readonly ledgerHeld?: boolean;
  readonly hooks?: RailHooks;
  readonly acquireRuntime?: (context: RailRuntimeContext) => Promise<RailRuntime>;
  readonly crashAfter?: CrashPoint;
}

export interface RunRailOptionsV2 {
  readonly execution?: RunExecution;
  readonly now?: () => string;
  /** The daemon's stop request or signal; a sync pass reads it before every extraction step. */
  readonly stopRequested?: () => boolean;
  /** Aborted with the daemon's stop, and handed to `acquireRuntime`. */
  readonly signal?: AbortSignal;
  /** The caller found the ledger held: skip the pass without touching it and record why. */
  readonly ledgerHeld?: boolean;
  readonly hooks?: RailHooksV2;
  readonly acquireRuntime?: (context: RailRuntimeContext) => Promise<RailRuntimeV2>;
  readonly crashAfter?: CrashPoint;
}

type AnyRunRailOptions = RunRailOptions | RunRailOptionsV2;

function dayOf(at: string): string {
  return at.slice(0, 10);
}

/**
 * A host must bind a model port and hand its capability to the rail. Raw
 * serve.toml values are configuration intent, never permission to write.
 */
function withResolvedModel(hooks: AnyRailHooks | undefined): AnyRailHooks | undefined {
  if (hooks === undefined) return undefined;
  return { ...hooks, model_ref: hooks.model_ref ?? null };
}

function nextHourUtc(now: string, hour: number): string {
  const date = new Date(now);
  const candidate = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, 0, 0),
  );
  if (candidate.getTime() <= date.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate.toISOString();
}

export function dueRails(db: Database, now: string): RailId[] {
  const due: RailId[] = [];
  for (const schedule of listSchedules(db)) {
    if (!schedule.enabled) continue;
    if (schedule.next_run_at === null || schedule.next_run_at <= now) {
      due.push(schedule.rail);
    }
  }
  return due;
}

export async function runSyncRail(context: RailRunContext): Promise<Partial<RunReceipt>> {
  const { db, vault_path: vaultPath, budget, config, hooks, run_id: runId, now, stop_requested: stopRequested } = context;
  const { extraction } = config;
  const synced =
    hooks?.sync === undefined
      ? {
          events_synced: 0,
          events_stored: 0,
          events_duplicate: 0,
          events_self_skipped: 0,
          errors: [] as string[],
        }
      : await hooks.sync({
          deadline_ms: config.connector_drain_seconds * 1_000,
          max_batches: config.connector_drain_batches,
          ...(stopRequested === undefined ? {} : { stopRequested }),
        });
  if (stopRequested?.()) {
    return { ...synced, status: "stopped", stopped: STOP_REQUESTED };
  }
  const written = await runWritePass(db, vaultPath, {
    budget,
    extraction,
    ...(config.consolidation === undefined ? {} : { consolidation: config.consolidation }),
    ...(hooks?.llm === undefined ? {} : { llm: hooks.llm }),
    ...(stopRequested === undefined ? {} : { stopRequested }),
    run_id: runId,
    now,
    ...(hooks?.model_ref === undefined ? {} : { model_ref: hooks.model_ref }),
    ...(hooks?.producer === undefined ? {} : { producer: hooks.producer }),
    ...(hooks?.claims === undefined ? {} : { claims: hooks.claims }),
  });
  // Derived stores are rebuildable and run after the canon receipt.  Preserve
  // the completed write-pass report when their refresh fails; replacing it
  // with a zeroed failed rail would hide a real write and understate budget.
  let refreshed: readonly string[];
  try {
    refreshed = written.stopped === "serve:stop_requested" || stopRequested?.() || hooks?.refresh === undefined
      ? [] : (await hooks.refresh()).degraded;
  } catch (error) {
    refreshed = stopRequested?.() ? [] : [redactReceiptError(error)];
  }
  const errors = [...synced.errors, ...written.errors, ...refreshed];
  // A drain the stop request cut short is a stopped pass even when no extraction step saw the request.
  const stopped = stopRequested?.() === true ? STOP_REQUESTED : written.stopped;
  let status: RunReceipt["status"] = "ok";
  if (stopped !== null) status = "stopped";
  else if (errors.length > 0) status = "degraded";
  return {
    status,
    ...(synced.has_more === true ? { has_more: true } : {}),
    events_synced: synced.events_synced,
    events_stored: synced.events_stored,
    events_duplicate: synced.events_duplicate,
    events_self_skipped: synced.events_self_skipped,
    claims_extracted: written.claims_extracted,
    claims_written: written.claims_written,
    claims_written_extracted: written.claims_written_extracted,
    claims_deduped: written.claims_deduped,
    claims_superseded: written.claims_superseded,
    claims_rejected: written.claims_rejected,
    ...(Object.keys(written.claims_skipped).length === 0 ? {} : { claims_skipped: written.claims_skipped }),
    records_skipped: written.records_skipped,
    ...(Object.keys(written.records_prefiltered).length === 0 ? {} : { records_prefiltered: written.records_prefiltered }),
    canon_writes: written.canon_writes,
    ...(written.canon_quarantined.length === 0 ? {} : { canon_quarantined: written.canon_quarantined }),
    model: { ...written.model, model_ref: hooks?.model_ref ?? null },
    ...(written.consolidation === undefined ? {} : { consolidation: written.consolidation }),
    ...(written.oversized.segments + written.oversized.skipped === 0 ? {} : { oversized: written.oversized }),
    stopped,
    errors,
  };
}

/**
 * A derived index behind the ledger or receipts is work, not an empty pass.
 * The host catches up in bounded batches and reports what is left, so the rail
 * records progress and refuses to call itself current too early. A refresh that
 * throws leaves work outstanding rather than reading as nothing to do.
 */
async function refreshDerivedOnce(hooks: AnyRailHooks | undefined): Promise<RailRefreshReport> {
  try {
    return (await hooks?.refresh?.()) ?? { indexed: 0, remaining: 0, degraded: [] };
  } catch (error) {
    return { indexed: 0, remaining: 1, degraded: [redactReceiptError(error)] };
  }
}

export async function runRetrievalSweep(context: RailRunContext): Promise<Partial<RunReceipt>> {
  const { db, hooks, stop_requested: stopRequested } = context;
  if (inspectCanonRecovery(db).projection_pending > 0) {
    const result = await retryCanonProjectionObligations({ db, vault_path: context.vault_path,
      ...(hooks?.claims?.retrieval === undefined ? {} : { retrieval: hooks.claims.retrieval }),
    });
    if (result.pending > 0) throw new Error("canon projection recovery pending");
  }
  // Catch-up does not depend on a claims port, so it runs either way.
  const refreshed = await refreshDerivedOnce(hooks);
  if (stopRequested?.()) return { status: "stopped", stopped: "serve:stop_requested" };
  const ops =
    hooks?.claims === undefined
      ? { retried: 0, pending: pendingRetrievalOps(db).length, code: "retrieval-unavailable" }
      : { ...(await retryRetrievalOps(hooks.claims)), code: "retrieval-ops-pending" };
  const degraded = [
    ...(ops.pending === 0 ? [] : [ops.code]),
    ...(refreshed.remaining === 0 ? [] : ["derived-index-behind"]),
    ...refreshed.degraded,
  ];
  return {
    status: degraded.length === 0 ? "ok" : "degraded",
    retrieval: {
      upserts: ops.retried + refreshed.indexed,
      removals: 0,
      pending_ops: ops.pending + refreshed.remaining,
      degraded,
    },
  };
}

export async function runPurgeSweep(context: RailRunContext): Promise<Partial<RunReceipt>> {
  const { db, vault_path: vaultPath, hooks, started_at: now } = context;
  const pending = listPurgeRecoveryReceipts(db);
  let removals = 0;
  const errors: string[] = [];
  for (const receiptId of pending) {
    const report = await resumePurge(db, vaultPath, receiptId, {
      ...(hooks?.claims?.retrieval === undefined
        ? {}
        : { retrieval: hooks.claims.retrieval }),
      now: () => now,
    });
    if (report.ok) removals += 1;
    else errors.push("purge-op-pending");
  }
  const health = inspectPurgeHealth(db, now);
  return {
    status: health.ok && errors.length === 0 ? "ok" : "degraded",
    retrieval: {
      upserts: 0,
      removals,
      pending_ops: pending.length - removals,
      degraded: health.ok ? [] : ["purge-ops-pending"],
    },
    errors,
  };
}

/** Maximum chunks embedded by one scheduled backfill pass. */
export const EMBED_PASS_CHUNKS = 200;

export async function runEmbedBackfill(context: RailRunContext): Promise<Partial<RunReceipt>> {
  const { db, vault_path: vaultPath, hooks, started_at: now } = context;
  // Without an embedding port the rail backs off to a long period; configuring
  // one pulls the next run forward again.
  applyRailPeriod(db, "embed-backfill", embedBackfillPeriod(vaultPath), now);
  if (loadEmbeddingSelection(vaultPath).state === "off") return { status: "ok" };
  // The engine's own store holds the backlog: chunks that have no vector yet.
  const engine = hooks?.claims?.retrieval;
  if (engine?.embedPending === undefined) return { status: "ok" };
  try {
    const progress = await engine.embedPending({ limit: EMBED_PASS_CHUNKS });
    return {
      status: "ok",
      retrieval: { upserts: progress.documents, removals: 0, pending_ops: progress.remaining, degraded: [] },
    };
  } catch (error) {
    // A stopped embedding server is a condition to report and retry, not a fault of the rail.
    if (!(error instanceof PortError)) throw error;
    const health = await engine.health().catch(() => undefined);
    const backlog = health !== undefined && health.status !== "unavailable" ? Number(health.detail["backlog_depth"]) : 0;
    return {
      status: "degraded",
      retrieval: { upserts: 0, removals: 0, pending_ops: Number.isSafeInteger(backlog) ? backlog : 0, degraded: ["embedding-unavailable"] },
    };
  }
}

/** A repaired page is counted on the run; one that cannot be repaired degrades it and names its day. */
function repairReport(repair: BriefRepair): Partial<RunReceipt> {
  return {
    ...(repair.repaired === 0 ? {} : { pages_repaired: repair.repaired }),
    ...(repair.failed === 0 ? {} : { status: "degraded", errors: repair.failed_days.map((day) => `brief-repair-failed:${day}`) }),
  };
}

export async function runBrief(context: RailRunContext): Promise<Partial<RunReceipt>> {
  const { db, vault_path: vaultPath, started_at: now } = context;
  const modelRef = context.hooks?.model_ref ?? null;
  const notifier = createFileNotifier(vaultPath);
  const day = dayOf(now);
  const body = composeBrief(db, now, modelRef);
  await notifier.notify({
    notification_id: day,
    title: `brief:${day}`,
    body,
    sensitivity: parseFrontmatter(body).data["sensitivity"] === "private" ? "private" : "personal",
    provenance: [],
  });
  return { status: "ok", ...repairReport(await repairBriefPages(vaultPath)) };
}

/** The most failures one sweep receipt names, so a broken vault cannot grow the journal. */
const SWEEP_FAILURES = 8;

/**
 * The sweep reports what `kizuki doctor` would fail on, less what only the
 * service's supervisor can know, so an `ok` sweep never sits beside a failed
 * doctor. Its own degradation is not a rail fault: see `railDoctor`.
 */
export async function runDoctorSweep(context: RailRunContext): Promise<Partial<RunReceipt>> {
  const { db, vault_path: vaultPath, hooks, started_at: now, run_id: runId, execution } = context;
  const health = inspectPurgeHealth(db, now);
  const recovery = inspectCanonRecovery(db);
  const doctor = inspectServeDoctor(db, vaultPath, {
    now,
    host_checks: false,
    // The sweep runs inside the daemon's event loop and reads no page fields.
    page_walk: false,
    model_ref: hooks?.model_ref ?? null,
    embedding_configured: hooks?.embedding_configured === true,
  });
  const errors = [
    ...(health.ok ? [] : ["purge-unhealthy"]),
    ...(recovery.pending || recovery.projection_pending > 0 ? ["canon-recovery-pending"] : []),
    ...doctor.failures.map(redactReceiptError),
  ].slice(0, SWEEP_FAILURES);
  const repair = repairReport(await repairBriefPages(vaultPath));
  const captures = closeCaptureFanout(db, vaultPath, now, runId, execution);
  const allErrors = [...errors, ...(repair.errors ?? [])].slice(0, SWEEP_FAILURES);
  return {
    ...repair,
    ...(captures === 0 ? {} : { captures_skipped: captures }),
    status: allErrors.length === 0 ? "ok" : "degraded",
    errors: allErrors,
  };
}

/**
 * Closes out capture notes filed for conversational events by earlier
 * revisions. It takes the canon writer's lock so a claim is never skipped
 * while the writer is materializing it; a busy writer leaves it to the next sweep.
 */
function closeCaptureFanout(db: Database, vaultPath: string, now: string, runId: string, execution: RunExecution): number {
  try {
    return withVaultMutationSync({ db, vault_path: vaultPath }, () => {
      // A released lock is not proof of completion: an interrupted writer's
      // admission still guards these claims until its durable intent finishes.
      if (inspectCanonRecovery(db).pending) return 0;
      return skipCaptureFanoutClaims(db, now, undefined, (skipped) => stageCaptureRepairReceipt(db, {
        ...emptyRunTotals(), run_id: runId, rail: "doctor-sweep", execution,
        started_at: now, finished_at: now, status: "failed", stopped: CAPTURE_REPAIR_RECEIPT_PENDING,
        captures_skipped: skipped, errors: [],
      }));
    });
  } catch (error) {
    if (error instanceof VaultMutationError && error.code === "writer_busy") return 0;
    throw error;
  }
}

export function runJournalPrune(context: RailRunContext): Partial<RunReceipt> {
  const cutoff = new Date(Date.parse(context.started_at) - context.config.journal_retention_days * 86_400_000).toISOString();
  pruneRunReceipts(context.db, context.vault_path, cutoff);
  return { status: "ok" };
}

const activeRuns = new Set<string>();
/** One callback per filesystem vault and ledger, across aliases and handles. */
const activeRunTargets = new Set<string>();

function filesystemIdentity(path: string): string {
  try {
    const { dev, ino } = statSync(path, { bigint: true });
    return `${dev}:${ino}`;
  } catch {
    throw new ServeDaemonError("rail_target_unavailable", "rail filesystem identity is unavailable");
  }
}

/**
 * Run one rail and resolve to its receipt. A scheduled run that did nothing is
 * coalesced: the schedule advances and the returned receipt is not persisted,
 * so look it up in `run_receipts` before relying on its `run_id`.
 */
export function runRail(
  db: Database,
  vaultPath: string,
  rail: RailId,
  options?: RunRailOptions,
): Promise<RunReceipt>;
export function runRail(
  db: Database,
  vaultPath: string,
  rail: RailId,
  options: RunRailOptionsV2,
): Promise<RunReceipt>;
export function runRail(
  db: Database,
  vaultPath: string,
  rail: RailId,
  options: AnyRunRailOptions,
): Promise<RunReceipt>;
export function runRail(
  db: Database,
  vaultPath: string,
  rail: RailId,
  options: AnyRunRailOptions = {},
): Promise<RunReceipt> {
  return runRailImpl(db, vaultPath, rail, options);
}

async function runRailImpl(
  db: Database,
  vaultPath: string,
  rail: RailId,
  options: AnyRunRailOptions,
): Promise<RunReceipt> {
  const stopRequested = (): boolean => options.signal?.aborted === true || options.stopRequested?.() === true;
  const definition = railDefinition(rail);
  if (definition === undefined) throw new ServeDaemonError("unknown_rail", `no rail is registered as ${JSON.stringify(rail)}`);
  const runId = ulid();
  activeRuns.add(runId);
  let targetKeys: string[] = [];
  let activeVault = false;
  let lease: { process: LeaseProcess; release: boolean } | undefined;
  try {
    const now = options.now ?? (() => new Date().toISOString());
    const started = now();
    const execution = options.execution ?? {
      instance_id: processInstance, pid: process.pid, boot_id: readBootId(), trigger: "manual" as const, due_at: null,
    };
    const totals = emptyRunTotals();
    let partial: Partial<RunReceipt> = {};
    let hooks: AnyRailHooks | undefined;
    let budget: BudgetTracker | undefined;
    let runtime: AnyRailRuntime | undefined;
    let interrupted = false;
    try {
      if (options.hooks !== undefined && options.acquireRuntime !== undefined) {
        throw new Error("rail hooks and acquireRuntime are mutually exclusive");
      }
      options.signal?.throwIfAborted();
      if (options.ledgerHeld === true) throw new LedgerLeaseHeldError("the ledger writer is held");
      targetKeys = [`vault:${filesystemIdentity(vaultPath)}`];
      if (db.filename && db.filename !== ":memory:") targetKeys.push(`ledger:${filesystemIdentity(db.filename)}`);
      if (targetKeys.some(key => activeRunTargets.has(key))) {
        throw new ServeDaemonError("lease_busy", "a rail is already running for this vault");
      }
      // A failed preflight may append this run's audit receipt only. In particular,
      // do not import older receipt/usage journals before validating a sync decision.
      definition.preflight?.(db);
      initServe(db);
      // Refuse unrepresentable configured or persisted periods before any work.
      const baseline = options.execution?.trigger === "scheduled" ? options.execution.due_at! : started;
      const schedule = listSchedules(db).find(row => row.rail === rail);
      nextScheduleSlot(baseline, schedule?.period_s ?? definition.period_s, null);
      if (definition.configured_period_s !== undefined) nextScheduleSlot(baseline, definition.configured_period_s(vaultPath), null);
      for (const key of targetKeys) activeRunTargets.add(key);
      activeVault = true;
      const holder = thisProcess(now);
      const borrowed = leaseState(db, holder) === "held";
      if (!acquireLease(db, holder).acquired) {
        throw new ServeDaemonError("lease_busy", "writer lease is busy; retry the rail");
      }
      lease = { process: holder, release: !borrowed };
      if (definition.recover_canon !== false && inspectCanonRecovery(db).pending) {
        // Writer-held mode: a held write blocks only new canon writes, so the
        // rails that ingest, index or prune keep running around it.
        try { recoverCanonWrites({ db, vault_path: vaultPath }); }
        catch (error) { if (!(error instanceof CanonRecoveryError)) throw error; }
      }
      recoverRunJournal(db, vaultPath, activeRuns);
      try {
        withVaultMutationSync({ db, vault_path: vaultPath }, () => {
          for (const orphan of db.query<{ run_id: string; holder_pid: number; model_ref: string | null; metrics: string; created_at: string }, []>("SELECT * FROM extract_usage").all()) {
            if (activeRuns.has(orphan.run_id) || (orphan.holder_pid !== process.pid && pidAlive(orphan.holder_pid))) continue;
            const usage = JSON.parse(orphan.metrics) as Pick<RunReceipt, "model" | "claims_rejected" | "claims_extracted">;
            // The row lives from the model call until the receipt lands: a kill
            // after the decision may have hit any later stage, not extraction.
            persistRunReceipt(db, vaultPath, { ...emptyRunTotals(), ...usage, run_id: orphan.run_id, rail: "sync",
              started_at: orphan.created_at, finished_at: orphan.created_at, status: "failed", stopped: null,
              model: { ...usage.model, model_ref: orphan.model_ref }, errors: [usage.model.usage_unknown === true ? "model attempt interrupted; token usage unknown" : "sync interrupted after model decision"] });
          }
        });
      } catch (error) {
        if (!(error instanceof VaultMutationError) || error.code !== "writer_busy") throw error;
      }
      const config = loadServeConfig(vaultPath);
      budget = createDurableWriteBudget(db, now, config);
      if (options.acquireRuntime !== undefined) {
        try { runtime = await options.acquireRuntime({ signal: options.signal ?? new AbortController().signal }); }
        catch (error) {
          if (isLedgerBusy(error) || error instanceof LedgerLeaseHeldError) throw error;
          if (options.signal?.aborted && (error === options.signal.reason ||
              (error instanceof Error && error.name === "AbortError"))) throw error;
          throw new Error("rail runtime acquisition failed");
        }
      }
      options.signal?.throwIfAborted();
      hooks = withResolvedModel(runtime?.hooks ?? options.hooks);
      partial = await definition.run({
        db, vault_path: vaultPath, run_id: runId, execution, started_at: started, now, config, budget, hooks,
        stop_requested: stopRequested,
      });
    } catch (error) {
      if (error instanceof InjectedCrash) { interrupted = true; throw error; }
      // A writer this pass could not outwait is not a fault of the rail: the
      // pass is skipped, its receipt names the holder, and the daemon backs off.
      const held = isLedgerBusy(error) || error instanceof LedgerLeaseHeldError;
      const cancelled = error === options.signal?.reason || (error instanceof Error && error.name === "AbortError");
      partial = stopRequested() && (held || cancelled)
        ? { status: "stopped", stopped: "serve:stop_requested" }
        : held
        ? { status: "stopped", stopped: LEDGER_LEASE_HELD_STOP, errors: [railLeaseHeldNote(vaultPath, db)] }
        : error instanceof BudgetExhausted
        ? { status: "stopped", stopped: error.stopped }
        : { status: "failed", errors: [redactReceiptError(error)],
          ...(error instanceof LegacyExtractReconciliationError ? { stopped: error.code } : {}) };
    } finally {
      // Close before publication so failure cannot leave a successful receipt.
      // This also releases the binding before any journal persistence can fail.
      if (runtime !== undefined) {
        try { await runtime.close(); }
        catch {
          if (interrupted) throw new Error("rail runtime close failed after interruption");
          partial = { ...partial, status: "failed", errors: [...(partial.errors ?? []), "rail runtime close failed"] };
        }
      }
    }

    const usage = db.query<{ model_ref: string | null; metrics: string }, [string]>("SELECT model_ref,metrics FROM extract_usage WHERE run_id=?").get(runId);
    if (usage !== null) {
      const metrics = JSON.parse(usage.metrics) as Pick<RunReceipt, "model" | "claims_rejected" | "claims_extracted">;
      partial = { ...partial, ...metrics, model: { ...metrics.model, model_ref: usage.model_ref } };
      // A contended ledger can retain the pre-request usage marker after an
      // abort. Keep that uncertainty without reclassifying a requested stop.
      if (metrics.model.usage_unknown === true && !stopRequested()) partial = { ...partial, status: "failed", errors: [...(partial.errors ?? []), "model attempt interrupted; token usage unknown"] };
    }
    const repairProgress = getRunReceipt(db, runId);
    if (repairProgress?.stopped === CAPTURE_REPAIR_RECEIPT_PENDING) {
      partial = { ...partial, captures_skipped: repairProgress.captures_skipped! };
    }
    if (stopRequested() && partial.status !== "failed") {
      partial = { ...partial, status: "stopped", stopped: "serve:stop_requested" };
    }
    const finished = now();
    const receipt: RunReceipt = {
      ...totals,
      ...partial,
      run_id: runId,
      execution,
      rail,
      started_at: started,
      finished_at: finished,
      status: partial.status ?? "ok",
      stopped: partial.stopped ?? null,
      model: {
        ...totals.model,
        ...partial.model,
        model_ref: partial.model?.model_ref ?? hooks?.model_ref ?? null,
      },
      retrieval: {
        ...totals.retrieval,
        ...partial.retrieval,
      },
      budget: partial.budget ?? budget?.usage() ?? totals.budget,
      errors: [...(partial.errors ?? [])].map((item) =>
        typeof item === "string" ? item : redactReceiptError(item),
      ),
    };
    // A scheduled run that did nothing advances its schedule without a receipt.
    if (options.crashAfter === undefined && coalesceNoopReceipt(db, vaultPath, receipt)) return receipt;
    const publish = (): void => persistRunReceipt(db, vaultPath, receipt, {
      advanceSchedule: lease !== undefined,
      ...(options.crashAfter === undefined ? {} : { crashAfter: options.crashAfter }),
      ...(lease === undefined || definition.artifact === undefined ? {} : { artifactPath: definition.artifact(vaultPath, dayOf(started)) }),
    });
    // A pass skipped for a held ledger journals its receipt, and asks the ledger only briefly.
    if (options.ledgerHeld === true) withControlWait(db, publish, stopRequested() ? 0 : LEDGER_LOOP_PROBE_TIMEOUT_MS);
    else publish();
    const published = getRunReceipt(db, runId);
    if (published === null) throw new Error("persisted run receipt unavailable");
    return published;
  } finally {
    activeRuns.delete(runId);
    if (activeVault) for (const key of targetKeys) activeRunTargets.delete(key);
    if (lease?.release === true) releaseLease(db, lease.process);
  }
}

export function runServeOnce(
  db: Database,
  vaultPath: string,
  options?: RunRailOptions & { rails?: RailId[] },
): Promise<RunReceipt[]>;
export function runServeOnce(
  db: Database,
  vaultPath: string,
  options: RunRailOptionsV2 & { rails?: RailId[] },
): Promise<RunReceipt[]>;
export async function runServeOnce(
  db: Database,
  vaultPath: string,
  options: AnyRunRailOptions & { rails?: RailId[] } = {},
): Promise<RunReceipt[]> {
  if (options.rails === undefined) {
    // A rail registered after the vault opened has no schedule row until it is seeded.
    initServe(db);
  }
  const rails = options.rails ?? listSchedules(db).filter((row) => row.enabled).map((row) => row.rail);
  const receipts: RunReceipt[] = [];
  for (const rail of rails) {
    receipts.push(await runRailImpl(db, vaultPath, rail, options));
  }
  return receipts;
}

export function nextBriefAt(now: string, hour: number): string {
  return nextHourUtc(now, hour);
}
