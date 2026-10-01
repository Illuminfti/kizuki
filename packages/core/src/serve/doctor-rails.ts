import type { Database } from "bun:sqlite";
import { countUnwrittenLiveClaims, oldestUnwrittenLiveClaimAt } from "../claims/store";
import { formatProducerDiagnostic } from "../producer/diagnostics";
import { sourcePolicyEpoch } from "../ledger/source-grants";
import { tableExists } from "../ledger/schema";
import { readExtractCursor } from "./extract";
import {
  DEGRADED_STREAK,
  EMPTY_STREAK,
  EXTRACT_BACKLOG_CAP,
  type ExtractionConfig,
  type RailDoctor,
  type RailId,
  type RunReceipt,
} from "./types";

/** Far enough ahead that every timestamp is before it: "now" for an as-of query. */
const NOW = "9999-12-31T23:59:59.999Z";
const REASON_CAP = 160;
/** Most runs the empty-streak walk reads back; the streak needs half of it. */
const EMPTY_WALK = 2 * EMPTY_STREAK;

/** What a rail can do, judged from ledger state and the model the vault is configured with. */
export interface WorkContext {
  readonly db: Database;
  /** Extraction and canon writing need a bound model; without one they are not the rail's work. */
  readonly model_configured: boolean;
  /** Only a configured embedding port gives embed-backfill work to do. */
  readonly embedding_configured: boolean;
}

interface PendingWork {
  readonly count: number;
  /** What the count is made of, for the reason a rail is down. */
  readonly detail: string;
}

/**
 * Events past the extract cursor that a granted source would send to a model,
 * counted up to `limit` and no further. `asOf` ignores events accepted later.
 * A vault with no source grants has no per-source policy: every event counts.
 */
export function extractBacklog(
  db: Database,
  limit: number,
  asOf: string = NOW,
): number {
  const cursor = readExtractCursor(db);
  const split = cursor === null ? -1 : cursor.indexOf("\t");
  const past =
    split > 0 && cursor !== null
      ? "AND (e.accepted_at > ? OR (e.accepted_at = ? AND e.event_id > ?))"
      : "";
  const bindings: (string | number)[] = [];
  if (past !== "" && cursor !== null) {
    const acceptedAt = cursor.slice(0, split);
    bindings.push(acceptedAt, acceptedAt, cursor.slice(split + 1));
  }
  let granted = "";
  if (sourcePolicyEpoch(db) > 0) {
    if (
      !tableExists(db, "source_event_bindings") ||
      !tableExists(db, "source_grants")
    )
      return 0;
    granted = `AND EXISTS (
      SELECT 1 FROM source_event_bindings b JOIN source_grants g ON g.source_key = b.source_key
       WHERE b.event_id = e.event_id AND g.status = 'active'
         AND json_extract(g.policy, '$.egress') <> 'local_only'
         AND EXISTS (SELECT 1 FROM json_each(json_extract(g.policy, '$.purposes')) p WHERE p.value = 'extract'))`;
  }
  return (
    db
      .query<{ n: number }, (string | number)[]>(
        `SELECT count(*) AS n FROM (
         SELECT 1 FROM events e
          WHERE e.deleted = 0 AND e.accepted_at <= ? ${past} ${granted}
          LIMIT ?)`,
      )
      .get(asOf, ...bindings, limit)?.n ?? 0
  );
}

/** Connections with consent that no run has reached yet, so no checkpoint exists. */
function dueSources(db: Database, limit: number, asOf: string): number {
  if (!tableExists(db, "connections") || !tableExists(db, "checkpoints"))
    return 0;
  const consented =
    sourcePolicyEpoch(db) > 0 && tableExists(db, "source_grants")
      ? "AND EXISTS (SELECT 1 FROM source_grants g WHERE g.source_key = c.source_key AND g.status = 'active')"
      : "";
  return (
    db
      .query<{ n: number }, [string, number]>(
        `SELECT count(*) AS n FROM (
         SELECT 1 FROM connections c
          WHERE c.disconnected_at IS NULL AND c.connected_at <= ? ${consented}
            AND NOT EXISTS (SELECT 1 FROM checkpoints k
                             WHERE k.connector_id = c.connector_id AND k.source_key = c.source_key)
          LIMIT ?)`,
      )
      .get(asOf, limit)?.n ?? 0
  );
}

function retrievalOps(db: Database, limit: number, asOf: string): number {
  if (!tableExists(db, "retrieval_ops")) return 0;
  return (
    db
      .query<{ n: number }, [string, string, number]>(
        `SELECT count(*) AS n FROM (
         SELECT 1 FROM retrieval_ops
          WHERE created_at <= ? AND (state = 'pending' OR (done_at IS NOT NULL AND done_at > ?))
          LIMIT ?)`,
      )
      .get(asOf, asOf, limit)?.n ?? 0
  );
}

/**
 * Work waiting for a rail at `asOf`, up to `limit`, or null for a rail that
 * runs on a schedule and has no backlog to work down. Schedule-driven rails
 * (brief, journal-prune, doctor-sweep, purge-sweep, and embed-backfill with no
 * embedding port) are judged by staleness and failure only: a run that changes
 * nothing is their normal outcome.
 *
 * Counting unwritten claims scans every live claim. A caller that judges many
 * past instants passes `unwrittenSince`, the creation time of the oldest
 * unwritten claim (one scan), and gets the same answer as a 0/1 count.
 */
export function pendingWork(
  context: WorkContext,
  rail: RailId,
  limit: number,
  asOf: string = NOW,
  unwrittenSince?: string | null,
): PendingWork | null {
  const { db } = context;
  switch (rail) {
    case "sync": {
      const parts: [string, number][] = [
        ["due sources", dueSources(db, limit, asOf)],
      ];
      if (context.model_configured) {
        parts.push([
          "extract backlog",
          extractBacklog(db, Math.min(limit, EXTRACT_BACKLOG_CAP), asOf),
        ]);
        parts.push([
          "unwritten claims",
          unwrittenSince === undefined
            ? countUnwrittenLiveClaims(db, asOf)
            : unwrittenSince !== null && unwrittenSince <= asOf
              ? 1
              : 0,
        ]);
      }
      return summarize(parts);
    }
    case "retrieval-sweep":
      return summarize([
        ["pending retrieval ops", retrievalOps(db, limit, asOf)],
      ]);
    case "embed-backfill":
      // The rail reports its own backlog on each receipt; the ledger has none.
      return context.embedding_configured ? { count: 0, detail: "" } : null;
    default:
      return null;
  }
}

function summarize(parts: readonly [string, number][]): PendingWork {
  const present = parts.filter(([, count]) => count > 0);
  return {
    count: present.reduce((sum, [, count]) => sum + count, 0),
    detail: present.map(([label, count]) => `${label} ${count}`).join(", "),
  };
}

/**
 * Rails run one at a time, so every rail can wait behind a sync pass. A
 * multi-request pass may take its time budget plus the request in flight; the
 * one-request pass is covered by the ordinary grace period.
 */
export function syncPassWait(extraction: ExtractionConfig): number {
  return extraction.max_calls_per_pass > 1 ? extraction.max_pass_seconds : 0;
}

export function ageSeconds(from: string | null, now: string): number | null {
  if (from === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

/**
 * A run moved something forward. Extraction that answered but filed nothing new
 * (every draft deduplicated, or records passed over) still shrinks the backlog.
 */
function produced(receipt: RunReceipt): boolean {
  return (
    receipt.events_stored > 0 ||
    receipt.claims_extracted > 0 ||
    receipt.claims_deduped > 0 ||
    (receipt.records_skipped ?? 0) > 0 ||
    receipt.records_prefiltered !== undefined ||
    receipt.claims_written > 0 ||
    receipt.canon_writes > 0 ||
    receipt.retrieval.upserts > 0 ||
    receipt.retrieval.removals > 0
  );
}

/**
 * A degraded run that drained retrieval work is a catch-up pass, not a fault:
 * it applied records or removals, or left fewer pending operations than the
 * run before it. Bounded refresh passes end degraded until the backlog is gone.
 */
function madeProgress(
  receipt: RunReceipt,
  previous: RunReceipt | undefined,
): boolean {
  return (
    receipt.retrieval.upserts > 0 ||
    receipt.retrieval.removals > 0 ||
    (previous !== undefined &&
      receipt.retrieval.pending_ops < previous.retrieval.pending_ops)
  );
}

const cap = (text: string): string =>
  text.length > REASON_CAP ? `${text.slice(0, REASON_CAP)}…` : text;

/** Why a run ended badly, in the words its receipt already carries. */
function runErrors(receipt: RunReceipt): string[] {
  const reasons = [
    ...(receipt.stopped === null ? [] : [`stopped ${receipt.stopped}`]),
    ...receipt.errors,
    ...receipt.retrieval.degraded,
    ...(receipt.model.diagnostic === undefined
      ? []
      : [formatProducerDiagnostic(receipt.model.diagnostic)]),
  ];
  return [...new Set(reasons)];
}

/** The error most of these runs share; the newest wins a tie. */
function dominantError(runs: readonly RunReceipt[]): string | null {
  const counts = new Map<string, number>();
  for (const run of [...runs].reverse()) {
    for (const reason of runErrors(run))
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [reason, count] of counts) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

/**
 * One rail's health from its own run receipts (`receipts`, oldest first) and
 * the ledger's pending work. A rail is down when it never ran, went stale,
 * last failed, keeps ending degraded or stopped without making progress, or
 * keeps running with work waiting and produces nothing. A rail with nothing to do is healthy however
 * many runs changed nothing. `doctor-sweep` reports the other checks' failures
 * as its own degradation, so its degraded runs are not a fault of the rail.
 */
export function railDoctor(
  rail: RailId,
  receipts: readonly RunReceipt[],
  period_s: number,
  now: string,
  expectLiveness: boolean,
  wait_s: number,
  context: WorkContext,
  /** The schedule's last run: a coalesced idle run advances it without a receipt. */
  lastRunAt: string | null = null,
): RailDoctor {
  const last = receipts.at(-1) ?? null;
  const lastActiveAt = [last?.finished_at ?? null, lastRunAt].reduce<string | null>(
    (a, b) => (a === null || (b !== null && b > a) ? b : a),
    null,
  );
  const age = ageSeconds(lastActiveAt, now);
  const workNow = pendingWork(context, rail, EXTRACT_BACKLOG_CAP);
  let empty = 0;
  let streakStart: string | null = null;
  if (workNow !== null) {
    // One scan for the oldest unwritten claim answers every run's as-of check.
    const unwrittenSince =
      rail === "sync" && context.model_configured
        ? oldestUnwrittenLiveClaimAt(context.db)
        : undefined;
    // The verdict needs EMPTY_STREAK; twice that reports "at least" without
    // walking a whole window of receipts.
    for (
      let index = receipts.length - 1;
      index >= 0 && empty < EMPTY_WALK;
      index -= 1
    ) {
      const receipt = receipts[index];
      if (
        receipt === undefined ||
        produced(receipt) ||
        madeProgress(receipt, receipts[index - 1])
      )
        break;
      // Work that a run saw is work the ledger still shows as of its start,
      // or backlog the run itself reported.
      const hadWork =
        receipt.retrieval.pending_ops > 0 ||
        (pendingWork(context, rail, 1, receipt.started_at, unwrittenSince)
          ?.count ?? 0) > 0;
      if (!hadWork) break;
      empty += 1;
      streakStart = receipt.finished_at;
    }
    // Coalesced idle runs leave no receipt, so while work still waits the
    // streak is the runs the elapsed time holds.
    if (empty > 0 && streakStart !== null && lastActiveAt !== null && period_s > 0 && workNow.count > 0) {
      const span = Math.max(0, (Date.parse(lastActiveAt) - Date.parse(streakStart)) / 1000);
      empty = Math.max(empty, Math.floor(span / period_s) + 1);
    }
  }
  const badRuns: RunReceipt[] = [];
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const receipt = receipts[index];
    if (
      receipt === undefined ||
      (receipt.status !== "degraded" && receipt.status !== "stopped") ||
      madeProgress(receipt, receipts[index - 1])
    )
      break;
    badRuns.push(receipt);
  }
  const grace = period_s + wait_s;
  const stale = age !== null && age > 2 * period_s + grace;
  let status: RailDoctor["status"] = "ok";
  let reason: string | null = null;
  if (last === null && lastActiveAt === null && expectLiveness) {
    status = "down";
    reason = "no receipt";
  } else if (stale && expectLiveness) {
    status = "down";
    reason = `stale ${age}s (period ${period_s}s)`;
  } else if (last?.status === "failed") {
    status = "down";
    const why = runErrors(last)[0];
    reason = cap(`last run failed${why === undefined ? "" : `: ${why}`}`);
  } else if (
    rail !== "doctor-sweep" &&
    !stale &&
    badRuns.length >= DEGRADED_STREAK
  ) {
    status = "down";
    const kinds = [...new Set(badRuns.map((run) => run.status))].join(" or ");
    const why = dominantError(badRuns);
    reason = cap(
      `last ${badRuns.length} runs ended ${kinds}${why === null ? "" : `: ${why}`}`,
    );
  } else if (empty >= EMPTY_STREAK && expectLiveness) {
    status = "down";
    reason = cap(
      `empty streak ${empty}${empty >= EMPTY_WALK ? "+" : ""} with work pending${workNow === null || workNow.detail === "" ? "" : ` (${workNow.detail})`}`,
    );
  } else if (last === null && lastActiveAt === null) {
    status = "idle";
  }
  return {
    rail,
    last_receipt_at: last?.finished_at ?? null,
    age_s: age,
    period_s,
    status,
    reason,
    empty_streak: empty,
    degraded_streak: badRuns.length,
    pending_work: workNow?.count ?? 0,
  };
}
