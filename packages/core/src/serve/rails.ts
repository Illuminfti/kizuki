import type { Database } from "bun:sqlite";
import { pendingRetrievalOps, retryRetrievalOps } from "../claims/store";
import type { ClaimsIo } from "../claims/store";
import { createBudgetTracker } from "../canon/budget";
import type { ProducerPort } from "../contracts/producer";
import { inspectPurgeHealth, verifyPurge } from "../ledger/purge";
import { tableExists } from "../ledger/schema";
import { ulid } from "../util/ulid";
import { serializePage } from "../vault/frontmatter";
import { addDailyBudget, budgetDay, readDailyBudget } from "./budget-ledger";
import { loadConfiguredModelRef, loadServeConfig } from "./config";
import { createFileNotifier, briefPath } from "./notifier-file";
import { persistRunReceipt, pruneRunReceipts, redactReceiptError } from "./receipts";
import { listSchedules } from "./schema";
import {
  InjectedCrash,
  emptyRunTotals,
  type CrashPoint,
  type RailId,
  type RunReceipt,
} from "./types";
import { runWritePass } from "./write-pass";

export interface RailSyncResult {
  readonly events_synced: number;
  readonly events_stored: number;
  readonly events_duplicate: number;
  readonly events_self_skipped: number;
  readonly errors: readonly string[];
}

export interface RailHooks {
  readonly sync?: () => Promise<RailSyncResult>;
  readonly claims?: ClaimsIo;
  readonly model_ref?: string | null;
  readonly producer?: ProducerPort;
  readonly embedding_backlog?: number;
}

export interface RunRailOptions {
  readonly now?: () => string;
  readonly hooks?: RailHooks;
  readonly crashAfter?: CrashPoint;
}

function dayOf(at: string): string {
  return at.slice(0, 10);
}

/**
 * Hooks may pin a model_ref (including explicit null). Otherwise the
 * vault's serve.toml decides, so `kizuki serve` writes without host wiring.
 */
function resolveModelRef(
  vaultPath: string,
  hooks: RailHooks | undefined,
): string | null {
  if (hooks !== undefined && Object.hasOwn(hooks, "model_ref")) {
    return hooks.model_ref ?? null;
  }
  return loadConfiguredModelRef(vaultPath);
}

function withResolvedModel(
  vaultPath: string,
  hooks: RailHooks | undefined,
): RailHooks | undefined {
  const model_ref = resolveModelRef(vaultPath, hooks);
  if (hooks === undefined && model_ref === null) return undefined;
  return { ...hooks, model_ref };
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
  budget: ReturnType<typeof createBudgetTracker>,
  hooks: RailHooks | undefined,
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
    ...(hooks?.model_ref === undefined ? {} : { model_ref: hooks.model_ref }),
    ...(hooks?.producer === undefined ? {} : { producer: hooks.producer }),
    ...(hooks?.claims === undefined ? {} : { claims: hooks.claims }),
  });
  const errors = [...synced.errors, ...written.errors];
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
    canon_writes: written.canon_writes,
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
  return {
    status: result.pending === 0 ? "ok" : "degraded",
    retrieval: {
      upserts: result.retried,
      removals: 0,
      pending_ops: result.pending,
      degraded: result.pending === 0 ? [] : ["retrieval-ops-pending"],
    },
  };
}

async function runPurgeSweep(
  db: Database,
  vaultPath: string,
  hooks: RailHooks | undefined,
  now: string,
): Promise<Partial<RunReceipt>> {
  if (!tableExists(db, "purge_ops")) {
    return { status: "ok" };
  }
  const pending = db
    .query<{ receipt_id: string }, []>(
      `SELECT DISTINCT receipt_id FROM purge_ops WHERE state = 'pending' ORDER BY receipt_id`,
    )
    .all();
  let removals = 0;
  const errors: string[] = [];
  for (const row of pending) {
    const report = await verifyPurge(db, vaultPath, row.receipt_id, {
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

export async function runRail(
  db: Database,
  vaultPath: string,
  rail: RailId,
  options: RunRailOptions = {},
): Promise<RunReceipt> {
  const now = options.now ?? (() => new Date().toISOString());
  const started = now();
  const hooks = withResolvedModel(vaultPath, options.hooks);
  const config = loadServeConfig(vaultPath);
  const day = budgetDay(started);
  const usedToday = readDailyBudget(db, day, "canon_writes_per_day");
  const budget = createBudgetTracker({
    canon_writes_per_run: config.canon_writes_per_run,
    canon_writes_per_day: {
      limit: config.canon_writes_per_day,
      used: usedToday,
    },
  });

  const totals = emptyRunTotals();
  let partial: Partial<RunReceipt> = {};
  try {
    switch (rail) {
      case "sync":
        partial = await runSyncRail(db, vaultPath, budget, hooks);
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
    partial = { status: "failed", errors: [redactReceiptError(error)] };
  }

  const finished = now();
  const receipt: RunReceipt = {
    ...totals,
    ...partial,
    run_id: ulid(),
    rail,
    started_at: started,
    finished_at: finished,
    status: partial.status ?? "ok",
    stopped: partial.stopped ?? null,
    model: {
      ...totals.model,
      ...partial.model,
      model_ref: hooks?.model_ref ?? partial.model?.model_ref ?? null,
    },
    retrieval: {
      ...totals.retrieval,
      ...partial.retrieval,
    },
    budget: partial.budget ?? budget.usage(),
    errors: [...(partial.errors ?? [])].map((item) =>
      typeof item === "string" ? item : redactReceiptError(item),
    ),
  };
  if (receipt.canon_writes > 0) {
    addDailyBudget(db, day, "canon_writes_per_day", receipt.canon_writes);
  }
  persistRunReceipt(db, vaultPath, receipt, {
    ...(options.crashAfter === undefined ? {} : { crashAfter: options.crashAfter }),
    ...(rail === "brief" ? { artifactPath: briefPath(vaultPath, dayOf(started)) } : {}),
  });
  return receipt;
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
