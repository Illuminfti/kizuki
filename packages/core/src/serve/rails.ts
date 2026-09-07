import { tryWriteFlock } from "./flock";
import { pidAlive, readBootId } from "./leases";
import type { Database } from "bun:sqlite";
import { pendingRetrievalOps, retryRetrievalOps } from "../claims/store";
import type { ClaimsIo } from "../claims/store";
import type { BudgetTracker } from "../canon/budget";
import type { ProducerPort } from "../contracts/producer";
import { inspectPurgeHealth, listPurgeRecoveryReceipts, resumePurge } from "../ledger/purge";
import { tableExists } from "../ledger/schema";
import { ulid } from "../util/ulid";
import { serializePage } from "../vault/frontmatter";
import { createDurableWriteBudget, budgetDay } from "./budget-ledger";
import { loadServeConfig } from "./config";
import { createFileNotifier, briefPath } from "./notifier-file";
import { recoverRunJournal, getRunReceipt, persistRunReceipt, pruneRunReceipts, redactReceiptError } from "./receipts";
import { initServe, listSchedules } from "./schema";
import {
  InjectedCrash,
  emptyRunTotals,
  type CrashPoint,
  type RailId,
  type RunReceipt,
  type RunExecution,
} from "./types";
import { runWritePass } from "./write-pass";
import { LegacyExtractReconciliationError, requireAtomicExtractReplay } from "./extract";

export interface RailSyncResult {
  readonly events_synced: number;
  readonly events_stored: number;
  readonly events_duplicate: number;
  readonly events_self_skipped: number;
  readonly errors: readonly string[];
}

export interface RailHooks {
  readonly sync?: () => Promise<RailSyncResult>;
  /** Host-owned derived stores refresh after a successful or partial write pass. */
  readonly refresh?: () => Promise<readonly string[]>;
  readonly claims?: ClaimsIo;
  readonly model_ref?: string | null;
  readonly producer?: ProducerPort;
  readonly embedding_backlog?: number;
}

const processInstance = crypto.randomUUID();

export interface RunRailOptions {
  readonly execution?: RunExecution;
  readonly now?: () => string;
  readonly hooks?: RailHooks;
  readonly crashAfter?: CrashPoint;
}

function dayOf(at: string): string {
  return at.slice(0, 10);
}

/**
 * A host must bind a model port and hand its capability to the rail. Raw
 * serve.toml values are configuration intent, never permission to write.
 */
function withResolvedModel(hooks: RailHooks | undefined): RailHooks | undefined {
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

async function runSyncRail(
  db: Database,
  vaultPath: string,
  budget: BudgetTracker,
  hooks: RailHooks | undefined,
  runId: string,
): Promise<Partial<RunReceipt>> {
  const synced =
    hooks?.sync === undefined
      ? {
          events_synced: 0,
          events_stored: 0,
          events_duplicate: 0,
          events_self_skipped: 0,
          errors: [] as string[],
        }
      : await hooks.sync();
  const written = await runWritePass(db, vaultPath, {
    budget,
    run_id: runId,
    ...(hooks?.model_ref === undefined ? {} : { model_ref: hooks.model_ref }),
    ...(hooks?.producer === undefined ? {} : { producer: hooks.producer }),
    ...(hooks?.claims === undefined ? {} : { claims: hooks.claims }),
  });
  // Derived stores are rebuildable and run after the canon receipt.  Preserve
  // the completed write-pass report when their refresh fails; replacing it
  // with a zeroed failed rail would hide a real write and understate budget.
  let refreshed: readonly string[];
  try {
    refreshed = hooks?.refresh === undefined ? [] : await hooks.refresh();
  } catch (error) {
    refreshed = [redactReceiptError(error)];
  }
  const errors = [...synced.errors, ...written.errors, ...refreshed];
  let status: RunReceipt["status"] = "ok";
  if (written.stopped !== null) status = "stopped";
  else if (errors.length > 0) status = "degraded";
  return {
    status,
    events_synced: synced.events_synced,
    events_stored: synced.events_stored,
    events_duplicate: synced.events_duplicate,
    events_self_skipped: synced.events_self_skipped,
    claims_extracted: written.claims_extracted,
    claims_written: written.claims_written,
    claims_deduped: written.claims_deduped,
    claims_superseded: written.claims_superseded,
    claims_rejected: written.claims_rejected,
    canon_writes: written.canon_writes,
    model: { ...written.model, model_ref: hooks?.model_ref ?? null },
    stopped: written.stopped,
    errors,
  };
}

async function runRetrievalSweep(
  db: Database,
  hooks: RailHooks | undefined,
): Promise<Partial<RunReceipt>> {
  const pending = pendingRetrievalOps(db).length;
  if (hooks?.claims === undefined) {
    return {
      status: pending === 0 ? "ok" : "degraded",
      retrieval: {
        upserts: 0,
        removals: 0,
        pending_ops: pending,
        degraded: pending === 0 ? [] : ["retrieval-unavailable"],
      },
    };
  }
  const result = await retryRetrievalOps(hooks.claims);
  let refreshed: readonly string[] = [];
  try { refreshed = await hooks.refresh?.() ?? []; }
  catch { refreshed = ["retrieval refresh unavailable"]; }
  const degraded = [...(result.pending === 0 ? [] : ["retrieval-ops-pending"]), ...refreshed];
  return {
    status: degraded.length === 0 ? "ok" : "degraded",
    retrieval: {
      upserts: result.retried,
      removals: 0,
      pending_ops: result.pending,
      degraded,
    },
  };
}

async function runPurgeSweep(
  db: Database,
  vaultPath: string,
  hooks: RailHooks | undefined,
  now: string,
): Promise<Partial<RunReceipt>> {
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

async function runEmbedBackfill(hooks: RailHooks | undefined): Promise<Partial<RunReceipt>> {
  const backlog = hooks?.embedding_backlog ?? 0;
  if (backlog === 0) {
    return { status: "ok" };
  }
  return {
    status: "degraded",
    retrieval: {
      upserts: 0,
      removals: 0,
      pending_ops: backlog,
      degraded: ["embedding-unavailable"],
    },
  };
}

function renderBrief(now: string, extra: string[]): string {
  const day = dayOf(now);
  return serializePage({
    data: {
      id: `rollup:brief-${day}`,
      title: `Daily brief ${day}`,
      type: "rollup",
      status: "active",
      sensitivity: "personal",
      taint: "clean",
      "x-brief-producer": "deterministic",
    },
    body: [
      `# Brief ${day}`,
      "",
      "The loop writes canon. There is no review queue.",
      "Correction is `kizuki tell` / MCP `correct`. Audit and undo stay in the TUI.",
      "",
      ...extra.map((line) => `- ${line}`),
      "",
    ].join("\n"),
  });
}

async function runBrief(
  vaultPath: string,
  now: string,
  extra: string[],
): Promise<Partial<RunReceipt>> {
  const notifier = createFileNotifier(vaultPath);
  const day = dayOf(now);
  await notifier.notify({
    notification_id: day,
    title: `brief:${day}`,
    body: renderBrief(now, extra),
    sensitivity: "personal",
    provenance: [],
  });
  return { status: "ok" };
}

async function runDoctorSweep(db: Database, now: string): Promise<Partial<RunReceipt>> {
  const health = inspectPurgeHealth(db, now);
  return {
    status: health.ok ? "ok" : "degraded",
    errors: health.ok ? [] : ["purge-unhealthy"],
  };
}

function runJournalPrune(
  db: Database,
  vaultPath: string,
  now: string,
  retentionDays: number,
): Partial<RunReceipt> {
  const cutoff = new Date(Date.parse(now) - retentionDays * 86_400_000).toISOString();
  pruneRunReceipts(db, vaultPath, cutoff);
  return { status: "ok" };
}

const activeRuns = new Set<string>();

export async function runRail(
  db: Database,
  vaultPath: string,
  rail: RailId,
  options: RunRailOptions = {},
): Promise<RunReceipt> {
  const runId = ulid();
  activeRuns.add(runId);
  try {
    const now = options.now ?? (() => new Date().toISOString());
    const started = now();
    const totals = emptyRunTotals();
    let partial: Partial<RunReceipt> = {};
    let hooks: RailHooks | undefined;
    let budget: BudgetTracker | undefined;
    try {
      // A failed preflight may append this run's audit receipt only. In particular,
      // do not import older receipt/usage journals before validating a sync decision.
      if (rail === "sync") requireAtomicExtractReplay(db);
      initServe(db);
      recoverRunJournal(db, vaultPath);
      const recoveryLock = tryWriteFlock(vaultPath);
      if (recoveryLock !== null) {
        try {
          for (const orphan of db.query<{ run_id: string; holder_pid: number; model_ref: string | null; metrics: string; created_at: string }, []>("SELECT * FROM extract_usage").all()) {
            if (activeRuns.has(orphan.run_id) || (orphan.holder_pid !== process.pid && pidAlive(orphan.holder_pid))) continue;
            const usage = JSON.parse(orphan.metrics) as Pick<RunReceipt, "model" | "claims_rejected" | "claims_extracted">;
            persistRunReceipt(db, vaultPath, { ...emptyRunTotals(), ...usage, run_id: orphan.run_id, rail: "sync",
              started_at: orphan.created_at, finished_at: orphan.created_at, status: "failed", stopped: null,
              model: { ...usage.model, model_ref: orphan.model_ref }, errors: [usage.model.usage_unknown === true ? "model attempt interrupted; token usage unknown" : "extraction interrupted after model decision"] });
          }
        } finally { recoveryLock.release(); }
      }
      hooks = withResolvedModel(options.hooks);
      const config = loadServeConfig(vaultPath);
      budget = createDurableWriteBudget(db, vaultPath, () => budgetDay(now()), config);
      switch (rail) {
        case "sync":
          partial = await runSyncRail(db, vaultPath, budget, hooks, runId);
          break;
        case "retrieval-sweep":
          partial = await runRetrievalSweep(db, hooks);
          break;
        case "purge-sweep":
          partial = await runPurgeSweep(db, vaultPath, hooks, started);
          break;
        case "embed-backfill":
          partial = await runEmbedBackfill(hooks);
          break;
        case "brief":
          partial = await runBrief(vaultPath, started, [
            `canon writing: ${hooks?.model_ref ? `on (${hooks.model_ref})` : "off (no model configured — connectors, ledger, search, timeline and undo still work)"}`,
          ]);
          break;
        case "doctor-sweep":
          partial = await runDoctorSweep(db, started);
          break;
        case "journal-prune":
          partial = runJournalPrune(db, vaultPath, started, config.journal_retention_days);
          break;
      }
    } catch (error) {
      if (error instanceof InjectedCrash) throw error;
      partial = { status: "failed", errors: [redactReceiptError(error)],
        ...(error instanceof LegacyExtractReconciliationError ? { stopped: error.code } : {}) };
    }

    const usage = db.query<{ model_ref: string | null; metrics: string }, [string]>("SELECT model_ref,metrics FROM extract_usage WHERE run_id=?").get(runId);
    if (usage !== null) {
      const metrics = JSON.parse(usage.metrics) as Pick<RunReceipt, "model" | "claims_rejected" | "claims_extracted">;
      partial = { ...partial, ...metrics, model: { ...metrics.model, model_ref: usage.model_ref } };
      if (metrics.model.usage_unknown === true) partial = { ...partial, status: "failed", errors: [...(partial.errors ?? []), "model attempt interrupted; token usage unknown"] };
    }
    const finished = now();
    const receipt: RunReceipt = {
      ...totals,
      ...partial,
      run_id: runId,
      execution: options.execution ?? {
        instance_id: processInstance, pid: process.pid, boot_id: readBootId(), trigger: "manual", due_at: null,
      },
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
    persistRunReceipt(db, vaultPath, receipt, {
      ...(options.crashAfter === undefined ? {} : { crashAfter: options.crashAfter }),
      ...(rail === "brief" ? { artifactPath: briefPath(vaultPath, dayOf(started)) } : {}),
    });
    const published = getRunReceipt(db, runId);
    if (published === null) throw new Error("persisted run receipt unavailable");
    return published;
  } finally { activeRuns.delete(runId); }
}

export async function runServeOnce(
  db: Database,
  vaultPath: string,
  options: RunRailOptions & { rails?: RailId[] } = {},
): Promise<RunReceipt[]> {
  const rails = options.rails ?? listSchedules(db).filter((row) => row.enabled).map((row) => row.rail);
  const receipts: RunReceipt[] = [];
  for (const rail of rails) {
    receipts.push(await runRail(db, vaultPath, rail, options));
  }
  return receipts;
}

export function nextBriefAt(now: string, hour: number): string {
  return nextHourUtc(now, hour);
}
