import { pendingWorldCanonClaims, worldCanonTarget } from "../canon/world-materialization";
import { requireSourceTombstoneProposal, requiresSourceTombstoneBinding } from "../canon/source-tombstone";
import { inheritSourcePortBindings } from "../ledger/source-grants";
import { SelfOriginError, requireExternalEvents } from "../ledger/event-origin";
import { addDailyBudget, budgetDay, readDailyBudget, settleWriteReservations } from "./budget-ledger";
import { recoverCanonWritesOwned } from "../canon/recovery";
import { CanonRecoveryError, inspectCanonRecovery } from "../canon/write-intent";
import { tableExists } from "../ledger/schema";
import { ulid } from "../util/ulid";
import type { Database } from "bun:sqlite";
import {
  BudgetExhausted,
  resolveTarget,
  type BudgetTracker,
  type TargetDecision,
} from "../canon";
import type { CanonIo } from "../canon";
import { applyCanonWriteOwned } from "../canon/apply";
import { requireCanonFiles, snapshotCanonIo, withCanonMutationAsync } from "../canon/io";
import { VaultMutationError, type VaultMutationScope } from "../vault/mutation-scope";
import { machineOriginPath } from "../canon/origin";
import type { Claim } from "../contracts/proposal";
import type { ClaimDraft, ProduceResult, ProducerDiagnostic, ProducerPort } from "../contracts/producer";
import type { DroppedDraftV2, ProduceResultV2, ProducerV2Port } from "../contracts/producer-v2";
import { formatProducerDiagnostic, readProducerDiagnostic } from "../producer/diagnostics";
import { invokeProducer, invokeProducerV2, type ValidatedProduceResult } from "../producer/result";
import type { WorldDraftInsert } from "../producer/world-drafts";
import { DEFAULT_EXTRACTION_CONFIG, type ExtractionConfig, type RunModelReport, type RunOversizedReport } from "./types";
import {
  prepareClaimInsert,
  retryRetrievalOps,
  listUnwrittenLiveClaims,
  reviveUncontestedSkipped,
} from "../claims/store";
import type { ClaimsIo } from "../claims/store";
import {
  commitExtractCursor,
  extractDecisionCurrent,
  fileAndCompleteDurableExtractBatch,
  DurableExtractAuthorizationError,
  journalExtractBatch,
  mineLiveDrafts,
  producedClaimInput,
  readDurableExtractBatch,
  requeuePassedOverRecords,
  requireAtomicExtractReplay,
  type DurableExtractBatch,
  type MineResult,
} from "./extract";
import { isProducerV2, type ExtractionProducerPort } from "./extract-v2";
import { backoffRemaining, readRejections, recordRejection, writeRejections } from "./extract-rejections";
import { redactReceiptError } from "./receipts";
import { runWorldJobs } from "./world-jobs";

/** One sync pass never materializes more than this many unwritten claims. */
const WRITE_PASS_LIMIT = 32;
/** Owner-edited skips stay live; scan past them so they cannot fill the write cap. */
const WRITE_PASS_SCAN = 256;
/** A stop request or signal ends the pass at the next extraction step. */
export const STOP_REQUESTED = "serve:stop_requested";
/** Different records refused alike: the model, not the records, is at fault. The pass waits and skips nothing more. */
export const SYSTEMIC_REJECTION = "model:systemic_rejection";
/** The day's model call or output token budget is spent. */
export const BUDGET_DAY = "model:budget_day";
const DAILY_CALLS = "model_calls_per_day";
const DAILY_OUTPUT_TOKENS = "model_output_tokens_per_day";
/** An answered request waits this long for a writer another operation holds before it is discarded. */
const SETTLE_WAIT_MS = 5_000;
const SETTLE_POLL_MS = 25;

export interface WritePassResult {
  readonly revived: number;
  readonly claims_extracted: number;
  readonly claims_written: number;
  readonly claims_written_extracted: number;
  readonly claims_deduped: number;
  readonly claims_superseded: number;
  /** Records extraction passed over for good without claims; each has its reason in `errors`. */
  readonly records_skipped: number;
  readonly canon_writes: number;
  readonly claims_rejected: Readonly<Record<string, number>>;
  readonly model: Omit<RunModelReport, "model_ref">;
  /** Segments filed and records skipped with a retry receipt, for records too large for one request. */
  readonly oversized: RunOversizedReport;
  readonly stopped: string | null;
  readonly errors: readonly string[];
}

/** A pass's totals, kept across its short writer holds. */
type PassTally = {
  -readonly [K in Exclude<keyof WritePassResult, "claims_rejected" | "model" | "oversized" | "errors">]: WritePassResult[K];
} & { readonly oversized: { segments: number; skipped: number }; readonly errors: string[] };

function emptyTally(): PassTally {
  return {
    revived: 0, claims_extracted: 0, claims_written: 0, claims_written_extracted: 0, claims_deduped: 0,
    claims_superseded: 0, records_skipped: 0, canon_writes: 0, oversized: { segments: 0, skipped: 0 }, stopped: null, errors: [],
  };
}

interface ProduceMetrics {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  unavailable: number;
  wall_ms: number;
  rejected: Record<string, number>;
  /** Requests the model answered with a usable response. */
  answered: number;
  /** Secrets scrubbed from outbound prompts, per kind. */
  redacted: Record<string, number>;
  /** The refusal streak the pass ends with, from the durable history; absent once the model has answered. */
  rejection?: { consecutive: number; rule: string };
  /** Why the day's budget kept a request from leaving; the pass then stops as `model:budget_day`. */
  budget_spent?: string;
  /**
   * The pass's latest request. A pass is judged by how it ended: a rejection a
   * later request answered past stays counted, but it is not the pass's failure.
   */
  last?: RequestOutcome;
}

interface RequestOutcome {
  readonly answered: boolean;
  readonly diagnostic?: ProducerDiagnostic;
  /** In flight, or a result that failed validation: the request's token usage is unknown. */
  readonly usage_unknown?: true;
}

function emptyMetrics(): ProduceMetrics {
  return { calls: 0, input_tokens: 0, output_tokens: 0, unavailable: 0, wall_ms: 0, rejected: {}, answered: 0, redacted: {} };
}

function count(metrics: ProduceMetrics, reason: string): void {
  metrics.rejected[reason] = (metrics.rejected[reason] ?? 0) + 1;
}

type ExtractionProduceResult = ProduceResult | ProduceResultV2;

function observe(metrics: ProduceMetrics, validated: ValidatedProduceResult<ExtractionProduceResult>, wallMs: number, stopped: boolean): void {
  const { result } = validated;
  metrics.wall_ms += wallMs;
  metrics.calls += result.usage.calls;
  metrics.input_tokens += result.usage.input_tokens;
  metrics.output_tokens += result.usage.output_tokens;
  for (const [kind, redacted] of Object.entries(result.usage.redacted ?? {})) metrics.redacted[kind] = (metrics.redacted[kind] ?? 0) + redacted;
  // A request the daemon's stop aborted is charged, but it is not the model's failure.
  if (stopped && result.status === "unavailable") return;
  const diagnostic = result.status === "ok" ? undefined : readProducerDiagnostic(result.diagnostic);
  metrics.last = {
    answered: result.status === "ok",
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(validated.usage_known ? {} : { usage_unknown: true }),
  };
  switch (result.status) {
    case "ok":
      metrics.answered += 1;
      for (const dropped of result.dropped ?? []) count(metrics, dropped.reason);
      return;
    case "rejected":
      count(metrics, result.reason);
      return;
    case "unavailable":
      metrics.unavailable += 1;
      return;
  }
}

const NOT_SENT = { calls: 0, input_tokens: 0, output_tokens: 0 } as const;

function observedProducer(
  producer: ExtractionProducerPort,
  metrics: ProduceMetrics,
  record: (result?: ExtractionProduceResult) => void,
  /** Why no request may leave now, or null. Read before every request. */
  spent: () => string | null,
  /** True once the daemon was told to stop, which aborts the request in flight. */
  stopped: () => boolean,
): ExtractionProducerPort {
  if (isProducerV2(producer)) {
    const observed: ProducerV2Port = {
      descriptor: producer.descriptor,
      model_ref: producer.model_ref,
      health: () => producer.health(),
      close: () => producer.close(),
      async produce(input) {
        const held = spent();
        if (held !== null) { metrics.budget_spent = held; return { status: "unavailable", reason: "unavailable", usage: NOT_SENT }; }
        const started = performance.now();
        record();
        const validated = await invokeProducerV2(producer, input);
        observe(metrics, validated, Math.max(0, Math.round(performance.now() - started)), stopped());
        if (validated.usage_known) record(validated.result);
        return validated.result;
      },
    };
    return inheritSourcePortBindings(producer, observed);
  }
  const observed: ProducerPort = {
    descriptor: producer.descriptor,
    health: () => producer.health(),
    close: () => producer.close(),
    async produce(input) {
      const held = spent();
      if (held !== null) { metrics.budget_spent = held; return { status: "unavailable", reason: "unavailable", usage: NOT_SENT }; }
      const started = performance.now();
      // Commit intent before crossing the asynchronous external-effect boundary.
      record();
      const validated = await invokeProducer(producer, input);
      observe(metrics, validated, Math.max(0, Math.round(performance.now() - started)), stopped());
      // Keep the original durable intent: failed validation cannot refund a call.
      if (validated.usage_known) record(validated.result);
      return validated.result;
    },
  };
  return inheritSourcePortBindings(producer, observed);
}

function metricResult(metrics: ProduceMetrics): Pick<WritePassResult, "claims_rejected" | "model"> {
  const { last } = metrics;
  return {
    claims_rejected: metrics.rejected,
    model: {
      ...(last?.diagnostic === undefined ? {} : { diagnostic: last.diagnostic }),
      ...(metrics.rejection === undefined ? {} : { consecutive_rejections: metrics.rejection.consecutive, last_rejection_rule: metrics.rejection.rule }),
      ...(last?.usage_unknown === undefined ? {} : { usage_unknown: true }),
      ...(last === undefined ? {} : { answered: metrics.answered, last_request: last.answered ? "answered" as const : "failed" as const }),
      calls: metrics.calls,
      input_tokens: metrics.input_tokens,
      output_tokens: metrics.output_tokens,
      ...(Object.keys(metrics.redacted).length === 0 ? {} : { redacted: metrics.redacted }),
      unavailable: metrics.unavailable,
      wall_ms: metrics.wall_ms,
    },
  };
}

function producedCount(result: ExtractionProduceResult): number {
  return result.status === "ok" ? ("claims" in result ? result.claims.length : result.response.claims.length) : 0;
}

export interface WritePassOptions {
  readonly budget: BudgetTracker;
  /** Owner throughput settings; absent keeps the one-request pass. */
  readonly extraction?: ExtractionConfig;
  /** Read before every extraction step; true ends the pass there as `serve:stop_requested`. */
  readonly stopRequested?: () => boolean;
  readonly run_id?: string;
  readonly model_ref?: string | null;
  readonly producer?: ExtractionProducerPort;
  readonly claims?: ClaimsIo;
  /** RFC3339 clock shared with rails, receipt timestamps, reservation days and the pass's time budget. */
  readonly now?: () => string;
}

function modelConfigured(options: WritePassOptions): boolean {
  return (
    typeof options.model_ref === "string" &&
    options.model_ref.length > 0 &&
    options.producer !== undefined &&
    options.claims !== undefined
  );
}

/** Loop creates go under auto/; edits of a human page stay on that page. */
function segregateLoopDecision(decision: TargetDecision): TargetDecision {
  switch (decision.action) {
    case "create":
      return { ...decision, rel_path: machineOriginPath(decision.rel_path) };
    case "edit":
    case "supersede":
    case "skip":
    case "conflict":
      return decision;
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

type Held<T> =
  | { readonly held: true; readonly value: T }
  | { readonly held: false; readonly stopped: "recovery:held" | "lock:busy" };

/**
 * One short hold of the canon writer. A pending canon write is recovered
 * first. A write that stays held, or a writer another operation keeps past
 * `waitMs`, ends the pass cleanly instead of failing it.
 */
async function holdWriter<T>(
  io: CanonIo,
  work: (scope: VaultMutationScope, owned: CanonIo) => T | Promise<T>,
  waitMs = 0,
): Promise<Held<T>> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    let entered = false;
    try {
      return await withCanonMutationAsync(io, async (scope, owned): Promise<Held<T>> => {
        entered = true;
        if (inspectCanonRecovery(owned.db).pending) {
          // A held write keeps its durable intent and blocks only new canon
          // writes. Ingest already ran; stop cleanly instead of failing each run.
          try { recoverCanonWritesOwned(scope, owned); }
          catch (error) { if (error instanceof CanonRecoveryError) return { held: false, stopped: "recovery:held" }; throw error; }
        }
        requireCanonFiles(scope, owned);
        return { held: true, value: await work(scope, owned) };
      });
    } catch (error) {
      if (!(error instanceof VaultMutationError) || error.code !== "writer_busy") throw error;
      // Only acquisition is retried; work that already ran is never repeated.
      if (entered || performance.now() >= deadline) return { held: false, stopped: "lock:busy" };
      await new Promise(resolve => setTimeout(resolve, SETTLE_POLL_MS));
    }
  }
}

/**
 * Ingest leftovers become live, extraction files claims, then the receipted
 * writer materializes unwritten live claims under the same budget the rail
 * already charged. The pass holds the canon writer only for local durable
 * work, never across a model request, so owner corrections, undo, purge and a
 * stop request are not held behind it. No model configured: claims stay live
 * and unwritten; doctor says so.
 */
export async function runWritePass(
  db: Database,
  vaultPath: string,
  options: WritePassOptions,
): Promise<WritePassResult> {
  const { budget, extraction, stopRequested, run_id, model_ref, producer, claims, now } = options;
  let capturedClaims: ClaimsIo | undefined;
  if (claims !== undefined) {
    const { db: claimsDb, retrieval, vault_path, now: claimsNow, historical_source_write } = claims;
    capturedClaims = Object.freeze({ db: claimsDb,
      ...(retrieval === undefined ? {} : { retrieval }),
      ...(vault_path === undefined ? {} : { vault_path }),
      ...(claimsNow === undefined ? {} : { now: claimsNow }),
      ...(historical_source_write === undefined ? {} : { historical_source_write }),
    });
  }
  options = Object.freeze({ budget,
    ...(extraction === undefined ? {} : { extraction }),
    ...(stopRequested === undefined ? {} : { stopRequested }),
    ...(run_id === undefined ? {} : { run_id }),
    ...(model_ref === undefined ? {} : { model_ref }),
    ...(producer === undefined ? {} : { producer }),
    ...(capturedClaims === undefined ? {} : { claims: capturedClaims }),
    ...(now === undefined ? {} : { now }),
  });
  if (options.claims !== undefined && options.claims.db !== db) throw new Error("claims ledger does not match write pass");
  requireAtomicExtractReplay(db);
  const io = snapshotCanonIo({
    db, vault_path: vaultPath,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const tally = emptyTally();
  const metrics = emptyMetrics();
  const result = (): WritePassResult => ({ ...tally, oversized: { ...tally.oversized }, ...metricResult(metrics) });

  const opened = await holdWriter(io, (_scope, owned) => { tally.revived = reviveUncontestedSkipped(owned.db); });
  if (!opened.held) { tally.stopped = opened.stopped; return result(); }
  if (options.producer !== undefined && options.claims !== undefined) {
    await runExtraction(io, options, options.producer, options.claims, metrics, tally);
    // The next pass writes canon; a stop, a held write or a busy writer ends this one now.
    if (tally.stopped === STOP_REQUESTED || tally.stopped === "recovery:held" || tally.stopped === "lock:busy") return result();
  }
  const jobs = await runWorldJobs({
    db, vaultPath, now: options.now ?? (() => new Date().toISOString()),
    stopRequested: options.stopRequested ?? (() => false), modelConfigured: modelConfigured(options),
  });
  tally.errors.push(...jobs.errors);
  if (jobs.stopped) { tally.stopped = STOP_REQUESTED; return result(); }
  // No model configured: claims stay live and unwritten; doctor says so.
  if (!modelConfigured(options)) return result();
  const written = await holdWriter(io, (scope, owned) => {
    try {
      settleWriteReservations(owned.db, owned.vault_path);
      writeCanon(scope, owned, options.budget, tally);
    } finally {
      settleWriteReservations(owned.db, owned.vault_path);
    }
  });
  if (!written.held) tally.stopped = written.stopped;
  return result();
}

function writeCanon(scope: VaultMutationScope, io: CanonIo, budget: BudgetTracker, tally: PassTally): void {
  const { db } = io;
  for (const typedClaims of pendingWorldCanonClaims(db, WRITE_PASS_LIMIT)) {
    if (tally.canon_writes >= WRITE_PASS_LIMIT) break;
    const primary=typedClaims[0]!;
    const decision=worldCanonTarget(db,primary.claim_id);
    const before=occupyingWriteIds(db);
    try {
      const receipt=applyCanonWriteOwned(scope,io,typedClaims,decision,{writer:"loop",budget});
      tally.canon_writes+=1;tally.claims_written+=receipt.claim_ids.length;
      tally.claims_written_extracted+=typedClaims.filter(claim=>claim.producer==="model"&&receipt.claim_ids.includes(claim.claim_id)).length;
    } catch(error) {
      if(!(error instanceof BudgetExhausted))tally.canon_writes+=newOccupyingWrites(before,occupyingWriteIds(db));
      if(error instanceof BudgetExhausted){tally.stopped=error.stopped;break;}
      tally.errors.push(redactReceiptError(error));
    }
  }

  const pending = listUnwrittenLiveClaims(db, WRITE_PASS_SCAN);
  for (const claim of pending) {
    if (tally.canon_writes >= WRITE_PASS_LIMIT) break;
    try {
      if (requiresSourceTombstoneBinding(db, claim)) requireSourceTombstoneProposal(db, claim, io);
      else requireExternalEvents(db, claim.provenance);
      const decision = segregateLoopDecision(resolveTarget(io, claim));
      if (decision.action === "skip") continue;
      const before = occupyingWriteIds(db);
      try {
        applyCanonWriteOwned(scope, io, claim, decision, {
          writer: "loop",
          budget,
        });
        tally.canon_writes += 1;
        tally.claims_written += 1;
        if (claim.producer === "model") tally.claims_written_extracted += 1;
      } catch (error) {
        // File/JSONL can land before the receipt row; count the SQLite slot.
        if (!(error instanceof BudgetExhausted)) {
          const committed = newOccupyingWrites(before, occupyingWriteIds(db));
          tally.canon_writes += committed;
          tally.claims_written += committed;
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof SelfOriginError) continue;
      if (error instanceof BudgetExhausted) {
        tally.stopped = error.stopped;
        break;
      }
      tally.errors.push(redactReceiptError(error));
    }
  }
}

/** SQLite receipts, live reservations, and pending intents — never the JSONL log. */
function occupyingWriteIds(db: Database): Set<string> {
  const ids = new Set<string>();
  if (tableExists(db, "canon_receipts")) {
    for (const row of db.query<{ receipt_id: string }, []>(
      "SELECT receipt_id FROM canon_receipts WHERE writer = 'loop'",
    ).all()) {
      ids.add(row.receipt_id);
    }
  }
  if (tableExists(db, "canon_write_reservations")) {
    for (const row of db.query<{ receipt_id: string }, []>(
      "SELECT receipt_id FROM canon_write_reservations",
    ).all()) {
      ids.add(row.receipt_id);
    }
  }
  if (tableExists(db, "canon_write_intents")) {
    for (const row of db.query<{ receipt_id: string }, []>(
      "SELECT receipt_id FROM canon_write_intents",
    ).all()) {
      ids.add(row.receipt_id);
    }
  }
  return ids;
}

function newOccupyingWrites(before: Set<string>, after: Set<string>): number {
  let added = 0;
  for (const id of after) {
    if (!before.has(id)) added += 1;
  }
  return added;
}

interface ExtractionPass {
  readonly io: CanonIo;
  readonly db: Database;
  readonly claims: ClaimsIo;
  readonly producer: ExtractionProducerPort;
  /** The same port, observed so each request is charged to the run. */
  readonly observed: ExtractionProducerPort;
  readonly metrics: ProduceMetrics;
  readonly model_ref: string | null;
  readonly limits: ExtractionConfig;
  readonly clock: () => string;
  readonly stopRequested: () => boolean;
  /** Counts claims an answered request carried that journaling declined, in the run's totals. */
  readonly decline: (dropped: readonly DroppedDraftV2[]) => void;
}

async function runExtraction(
  io: CanonIo,
  options: WritePassOptions,
  producer: ExtractionProducerPort,
  claims: ClaimsIo,
  metrics: ProduceMetrics,
  tally: PassTally,
): Promise<void> {
  const { db } = io;
  const runId = options.run_id ?? ulid();
  const clock = options.now ?? (() => new Date().toISOString());
  const limits = options.extraction ?? DEFAULT_EXTRACTION_CONFIG;
  let produced = 0;
  const recordUsage = (report: ReturnType<typeof metricResult>): void => {
    db.query("INSERT INTO extract_usage(run_id,model_ref,metrics,created_at,holder_pid) VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET metrics=excluded.metrics").run(
      runId, options.model_ref ?? null, JSON.stringify({ ...report, claims_extracted: produced }), new Date().toISOString(), process.pid,
    );
  };
  // The day's spend is durable and charged before a request leaves, so a kill
  // mid-call still counts the call; output tokens are charged from the answer.
  const spent = (): string | null => {
    const day = budgetDay(clock());
    const calls = readDailyBudget(db, day, DAILY_CALLS);
    if (calls >= limits.max_calls_per_day) return `max_calls_per_day=${limits.max_calls_per_day} is spent for ${day}`;
    const tokens = readDailyBudget(db, day, DAILY_OUTPUT_TOKENS);
    if (tokens >= limits.max_output_tokens_per_day) return `max_output_tokens_per_day=${limits.max_output_tokens_per_day} is spent for ${day}`;
    return null;
  };
  const observed = observedProducer(producer, metrics, (result) => {
    // One row per run carries the pass's running totals. Before each request
    // it already charges that request as the pass's unanswered last one, so a
    // kill mid-call is still counted and reported as interrupted.
    if (result === undefined) addDailyBudget(db, budgetDay(clock()), DAILY_CALLS, 1);
    else {
      produced += producedCount(result);
      // A legacy producer makes several requests per produce; the first was charged when it left.
      const extraCalls = Number.isSafeInteger(result.usage.calls) ? Math.max(0, result.usage.calls - 1) : 0;
      if (extraCalls > 0) addDailyBudget(db, budgetDay(clock()), DAILY_CALLS, extraCalls);
      const billed = result.usage.output_tokens;
      addDailyBudget(db, budgetDay(clock()), DAILY_OUTPUT_TOKENS, Number.isSafeInteger(billed) && billed > 0 ? billed : 0);
      // An answer, even an empty one, ends the refusal streak; what it passed over stays passed over.
      if (result.status === "ok") { writeRejections(db, null); delete metrics.rejection; }
    }
    recordUsage(result === undefined
      ? metricResult({ ...metrics, calls: metrics.calls + 1, last: { answered: false, usage_unknown: true } })
      : metricResult(metrics));
  }, spent, () => options.stopRequested?.() === true);
  const pass: ExtractionPass = {
    io, db, claims, producer, observed, metrics,
    stopRequested: () => options.stopRequested?.() === true,
    model_ref: options.model_ref ?? null, limits, clock,
    decline(dropped) {
      if (dropped.length === 0) return;
      for (const draft of dropped) count(metrics, draft.reason);
      produced -= dropped.length;
      recordUsage(metricResult(metrics));
    },
  };
  const started = Date.parse(clock());
  const history = readRejections(db, clock());
  if (history !== null) metrics.rejection = { consecutive: history.consecutive, rule: history.rule };
  const waiting = backoffRemaining(history, clock());
  if (history !== null && waiting !== null) {
    tally.stopped = SYSTEMIC_REJECTION;
    tally.errors.push(systemicNotice(history.consecutive, history.rule, waiting));
    return;
  }
  // Every step files its decision and advances the cursor before the next
  // one starts, so a kill loses at most the request in flight.
  for (let taken = 0; taken < pass.limits.max_calls_per_pass; taken++) {
    if (options.stopRequested?.() === true) { tally.stopped = STOP_REQUESTED; return; }
    // A spent pass starts no further step; the next pass resumes from the cursor.
    if (taken > 0 && Date.parse(clock()) - started >= pass.limits.max_pass_seconds * 1_000) return;
    let outcome: StepOutcome;
    try {
      outcome = await extractionStep(pass);
    } catch (error) {
      if (!(error instanceof DurableExtractAuthorizationError)) throw error;
      tally.stopped = `source:${error.code}`;
      return;
    }
    tally.claims_extracted += outcome.extracted;
    tally.claims_deduped += outcome.deduped;
    tally.claims_superseded += outcome.superseded;
    // Records passed over while the model was failing alike are queued again, not skipped.
    tally.records_skipped = Math.max(0, tally.records_skipped + outcome.skipped - outcome.requeued);
    tally.oversized.segments += outcome.segments;
    tally.oversized.skipped += outcome.oversized_skipped;
    tally.errors.push(...outcome.errors);
    tally.stopped = outcome.stopped;
    // The refusal history changed after this step's request was recorded.
    if (metrics.calls > 0 && metrics.last?.usage_unknown !== true) recordUsage(metricResult(metrics));
    if (outcome.next === "stop") return;
  }
}

function systemicNotice(consecutive: number, rule: string, until: string): string {
  return `model refused ${consecutive} requests in a row (${rule}); backing off until ${until}`;
}

interface StepOutcome {
  /**
   * `continue` after durable progress, or after a rejected response to a
   * request that was sent, which the next step asks again for its first record
   * alone; `stop` when nothing is left or the next step could only repeat this one.
   */
  readonly next: "continue" | "stop";
  readonly extracted: number;
  readonly deduped: number;
  readonly superseded: number;
  /** Records passed over for good, each with its reason in `errors`. */
  readonly skipped: number;
  /** Skipped records queued again because the model, not they, was at fault. */
  readonly requeued: number;
  /** Segments of a record too large for one request that this step settled. */
  readonly segments: number;
  /** Records too large for one request passed over with a retry receipt. */
  readonly oversized_skipped: number;
  readonly stopped: string | null;
  readonly errors: readonly string[];
}

const settled = (next: StepOutcome["next"], fields: Partial<Omit<StepOutcome, "next">> = {}): StepOutcome =>
  ({ next, extracted: 0, deduped: 0, superseded: 0, skipped: 0, requeued: 0, segments: 0, oversized_skipped: 0, stopped: null, errors: [], ...fields });

/** A provider that still refuses after the port's bounded retries ends the pass as a typed stop. */
function modelStop(reason: string, diagnostic: ProducerDiagnostic | undefined): string {
  const limited = diagnostic?.stage === "transport" && diagnostic.rule === "http" && diagnostic.http_status === 429;
  return limited ? "model:rate_limited" : `model:${reason}`;
}

/**
 * One durable step: file a pending decision without asking the model again,
 * or make at most one extraction request and settle its outcome. The request
 * runs without the canon writer; filing and the cursor take it briefly after.
 */
async function extractionStep(pass: ExtractionPass): Promise<StepOutcome> {
  const { io, db, claims, producer, observed, metrics, model_ref, limits, clock } = pass;
  const replay = await holdWriter(io, async () => {
    const pending = readDurableExtractBatch(db, producer);
    if (pending === null) return null;
    // Replay files an existing decision; it is not another extraction.
    const filed = await fileProducedDrafts(claims, pending, producer);
    return filed === null
      ? settled("stop", { errors: ["extract cursor changed before durable batch commit"] })
      : settled("continue", { deduped: filed.deduped, superseded: filed.superseded });
  });
  if (!replay.held) return settled("stop", { stopped: replay.stopped });
  if (replay.value !== null) return replay.value;
  const sent = metrics.calls, earlier = metrics.last;
  // A request after a refusal carries only the first record of the one it repeats.
  // The decision is durable, so it holds at one step per pass as well.
  const history = readRejections(db, clock());
  const request = history?.narrow == null ? limits : { ...limits, records_per_request: 1 };
  const mined = isProducerV2(observed)
    ? await mineLiveDrafts(db, observed, request)
    : await mineLiveDrafts(db, observed, request);
  // Only this step's request can explain this step's failure.
  const fresh = metrics.last === earlier ? undefined : metrics.last?.diagnostic;
  const diagnostic = fresh === undefined ? [] : [formatProducerDiagnostic(fresh)];
  switch (mined.mined.status) {
    case "unavailable":
      // The stop aborted this request; the pass ends as asked, and the next one asks again.
      if (pass.stopRequested()) return settled("stop", { stopped: STOP_REQUESTED });
      if (metrics.budget_spent !== undefined) return settled("stop", { stopped: BUDGET_DAY, errors: [`model budget: ${metrics.budget_spent}`] });
      return settled("stop", { stopped: modelStop(mined.mined.reason, fresh), errors: diagnostic });
    case "rejected": {
      const errors = [mined.mined.reason, ...diagnostic];
      // A refusal before sending, such as a legacy request over its budget, repeats identically.
      if (metrics.calls === sent) return settled("stop", { errors });
      const head = mined.model_inputs?.[0]?.event_id;
      if (head === undefined) return settled("stop", { errors });
      const rule = fresh !== undefined && "rule" in fresh ? String(fresh.rule) : mined.mined.reason;
      const refused = recordRejection(history, { head, rule, single: mined.model_inputs?.length === 1 }, clock());
      metrics.rejection = { consecutive: refused.state.consecutive, rule };
      switch (refused.action.kind) {
        // A nondeterministic model often answers the same record well on a second, smaller request.
        case "narrow":
          writeRejections(db, refused.state);
          // A request that could not be narrowed would only repeat itself.
          return settled(history?.narrow === head ? "stop" : "continue", { errors });
        // Different records fail alike: the model is at fault. Nothing more is skipped, and those
        // passed over while it failed go back on the queue for when it answers.
        case "trip": {
          const requeue = refused.action.requeue;
          const held = await holdWriter(io, () => db.transaction(() => {
            const requeued = requeuePassedOverRecords(db, requeue);
            writeRejections(db, refused.state);
            return requeued;
          }).immediate());
          if (!held.held) return settled("stop", { stopped: held.stopped, errors });
          const wait = systemicNotice(refused.state.consecutive, rule, refused.state.backoff_until!);
          return settled("stop", { stopped: SYSTEMIC_REJECTION, requeued: held.value, errors: [...errors, wait] });
        }
        case "skip": {
          // A record rejected on its own twice is passed over, so it cannot hold every later one.
          const { segment, ...whole } = mined;
          const twice = { ...whole, mined: { status: "skipped" as const, reason: "rejected on its own twice" } };
          // A segment keeps its record's filed prefix: the skip receipt lets `serve retry-skipped` resume there.
          const outcome = await advance(pass, segment === undefined ? twice
            : { ...twice, skipped: { event_id: segment.event_id, chars: segment.chars, done: segment.start } }, errors);
          // A segment skipped with a receipt is retried with `serve retry-skipped`, never through the streak.
          if (outcome.next !== "continue") return outcome;
          writeRejections(db, segment === undefined ? refused.state
            : { ...refused.state, passed_over: refused.state.passed_over.filter(id => id !== head) });
          // After a trip the skip is final and the pass waits, so a run of poison records drains one per wait.
          if (!refused.action.pause) return outcome;
          const wait = systemicNotice(refused.state.consecutive, rule, refused.state.backoff_until!);
          return { ...outcome, next: "stop", stopped: SYSTEMIC_REJECTION, errors: [...outcome.errors, wait] };
        }
        default: {
          const _exhaustive: never = refused.action;
          return _exhaustive;
        }
      }
    }
    case "skipped":
      return advance(pass, mined);
    case "empty":
      return mined.cursor === null ? settled("stop") : advance(pass, mined);
    case "deferred":
      return advance(pass, mined);
    case "ok": {
      return settle(pass, mined, async () => {
        // Persist the accepted model output before the first claim write.  A
        // retry must replay this exact decision, never ask a nondeterministic
        // producer to regenerate a partially filed batch.
        const journal = journalExtractBatch(db, mined, model_ref, producer);
        // A claim that parsed but does not resolve is dropped and counted, never the pass's failure.
        pass.decline(journal.dropped);
        const extracted = mined.mined.status === "ok" ? mined.mined.count - journal.dropped.length : 0;
        // Nothing left to file: the step settles like an empty response.
        if (!journal.journaled) return advanceHeld(pass, { ...mined, mined: { status: "empty" } });
        const durable = readDurableExtractBatch(db, producer);
        if (durable === null) throw new Error("durable extraction decision is missing");
        const filed = await fileProducedDrafts(claims, durable, producer);
        return filed === null
          ? settled("stop", { errors: ["extract cursor changed before commit"] })
          : settled("continue", { extracted, deduped: filed.deduped, superseded: filed.superseded,
            segments: mined.segment === undefined ? 0 : 1 });
      });
    }
    default: {
      const _exhaustive: never = mined.mined;
      return _exhaustive;
    }
  }
}

/**
 * Advance the cursor past a step's input without filing claims: empty,
 * deferred or skipped. A skip with a retry receipt is recorded there; any
 * other skip names its reason in the receipt errors.
 */
function advance(pass: ExtractionPass, mined: MineResult, errors: readonly string[] = []): Promise<StepOutcome> {
  return settle(pass, mined, () => advanceHeld(pass, mined, errors));
}

/** The cursor commit of `advance`, for a caller that already holds the writer. */
function advanceHeld(pass: ExtractionPass, mined: MineResult, errors: readonly string[] = []): StepOutcome {
  if (!commitExtractCursor(pass.db, mined)) return settled("stop", { errors: [...errors, "extract cursor changed before commit"] });
  if (mined.skipped !== undefined) return settled("continue", { oversized_skipped: 1, errors });
  if (mined.mined.status === "skipped") return settled("continue", { skipped: 1, errors: [...errors, `record skipped: ${mined.mined.reason}`] });
  return settled("continue", { segments: mined.segment === undefined ? 0 : 1, errors });
}

/**
 * Settle a step's outcome in one short writer hold, and only while the state
 * its request was planned from still holds. An answer in hand waits briefly
 * for a writer another operation holds rather than being discarded at once.
 */
async function settle(pass: ExtractionPass, mined: MineResult, file: () => StepOutcome | Promise<StepOutcome>): Promise<StepOutcome> {
  const held = await holdWriter(pass.io, () => extractDecisionCurrent(pass.db, mined)
    ? file()
    : settled("stop", { errors: ["extraction inputs changed during the request"] }), SETTLE_WAIT_MS);
  return held.held ? held.value : settled("stop", { stopped: held.stopped });
}

async function fileProducedDrafts(
  io: ClaimsIo,
  batch: DurableExtractBatch,
  producer: ExtractionProducerPort,
): Promise<{ deduped: number; superseded: number } | null> {
  const prepared = [];
  if (batch.filing_version === 2) {
    for (const draft of batch.filing_drafts as readonly WorldDraftInsert[]) {
      prepared.push(await prepareClaimInsert(io, draft));
    }
  } else {
    for (const draft of batch.filing_drafts as readonly ClaimDraft[]) {
      prepared.push(await prepareClaimInsert(io, producedClaimInput(io.db, draft, "model", batch.model_ref)));
    }
  }
  const results = fileAndCompleteDurableExtractBatch(io.db, batch, producer, prepared);
  if (results === null) return null;
  let deduped = 0;
  let superseded = 0;
  for (const result of results) {
    if (result.outcome === "stored") superseded += result.superseded.length;
    else if (result.outcome === "duplicate") deduped += 1;
  }
  await retryRetrievalOps(io);
  return { deduped, superseded };
}
