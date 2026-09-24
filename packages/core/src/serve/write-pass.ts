import { pendingWorldCanonClaims, worldCanonTarget } from "../canon/world-materialization";
import { requireSourceTombstoneProposal, requiresSourceTombstoneBinding } from "../canon/source-tombstone";
import { inheritSourcePortBindings } from "../ledger/source-grants";
import { SelfOriginError, requireExternalEvents } from "../ledger/event-origin";
import { settleWriteReservations } from "./budget-ledger";
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
import type { ProduceResultV2, ProducerV2Port } from "../contracts/producer-v2";
import { formatProducerDiagnostic, readProducerDiagnostic } from "../producer/diagnostics";
import { invokeProducer, invokeProducerV2 } from "../producer/result";
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
  fileAndCompleteDurableExtractBatch,
  DurableExtractAuthorizationError,
  journalExtractBatch,
  mineLiveDrafts,
  producedClaimInput,
  readDurableExtractBatch,
  requireAtomicExtractReplay,
  type DurableExtractBatch,
} from "./extract";
import { isProducerV2, type ExtractionProducerPort } from "./extract-v2";
import { redactReceiptError } from "./receipts";

/** One sync pass never materializes more than this many unwritten claims. */
const WRITE_PASS_LIMIT = 32;
/** Owner-edited skips stay live; scan past them so they cannot fill the write cap. */
const WRITE_PASS_SCAN = 256;

export interface WritePassResult {
  readonly revived: number;
  readonly claims_extracted: number;
  readonly claims_written: number;
  readonly claims_written_extracted: number;
  readonly claims_deduped: number;
  readonly claims_superseded: number;
  readonly canon_writes: number;
  readonly claims_rejected: Readonly<Record<string, number>>;
  readonly model: Omit<RunModelReport, "model_ref">;
  readonly oversized: RunOversizedReport;
  readonly stopped: string | null;
  readonly errors: readonly string[];
}

interface ProduceMetrics {
  diagnostic?: ProducerDiagnostic;
  usage_unknown?: true;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  unavailable: number;
  wall_ms: number;
  rejected: Record<string, number>;
}

function emptyMetrics(): ProduceMetrics {
  return { calls: 0, input_tokens: 0, output_tokens: 0, unavailable: 0, wall_ms: 0, rejected: {} };
}

function count(metrics: ProduceMetrics, reason: string): void {
  metrics.rejected[reason] = (metrics.rejected[reason] ?? 0) + 1;
}

type ExtractionProduceResult = ProduceResult | ProduceResultV2;

function observe(metrics: ProduceMetrics, result: ExtractionProduceResult, wallMs: number): void {
  metrics.wall_ms += wallMs;
  if (result.status !== "ok") {
    const diagnostic = readProducerDiagnostic(result.diagnostic);
    if (diagnostic !== undefined) metrics.diagnostic = diagnostic;
  }
  switch (result.status) {
    case "ok":
      metrics.calls += result.usage.calls;
      metrics.input_tokens += result.usage.input_tokens;
      metrics.output_tokens += result.usage.output_tokens;
      for (const dropped of result.dropped ?? []) count(metrics, dropped.reason);
      return;
    case "rejected":
      metrics.calls += result.usage.calls;
      metrics.input_tokens += result.usage.input_tokens;
      metrics.output_tokens += result.usage.output_tokens;
      count(metrics, result.reason);
      return;
    case "unavailable":
      metrics.calls += result.usage.calls;
      metrics.input_tokens += result.usage.input_tokens;
      metrics.output_tokens += result.usage.output_tokens;
      metrics.unavailable += 1;
      return;
  }
}

function observedProducer(
  producer: ExtractionProducerPort,
  metrics: ProduceMetrics,
  record: (result?: ExtractionProduceResult) => void,
): ExtractionProducerPort {
  if (isProducerV2(producer)) {
    const observed: ProducerV2Port = {
      descriptor: producer.descriptor,
      model_ref: producer.model_ref,
      health: () => producer.health(),
      close: () => producer.close(),
      async produce(input) {
        const started = performance.now();
        record();
        const validated = await invokeProducerV2(producer, input);
        const result = validated.result;
        observe(metrics, result, Math.max(0, Math.round(performance.now() - started)));
        if (validated.usage_known) record(result);
        else { metrics.usage_unknown = true; metrics.calls = Math.max(1, metrics.calls); }
        return result;
      },
    };
    return inheritSourcePortBindings(producer, observed);
  }
  const observed: ProducerPort = {
    descriptor: producer.descriptor,
    health: () => producer.health(),
    close: () => producer.close(),
    async produce(input) {
      const started = performance.now();
      // Commit intent before crossing the asynchronous external-effect boundary.
      record();
      const validated = await invokeProducer(producer, input);
      const result = validated.result;
      observe(metrics, result, Math.max(0, Math.round(performance.now() - started)));
      if (validated.usage_known) record(result);
      else {
        metrics.usage_unknown = true;
        metrics.calls = Math.max(1, metrics.calls);
        // Keep the original durable intent: failed validation cannot refund a call.
      }
      return result;
    },
  };
  return inheritSourcePortBindings(producer, observed);
}

function metricResult(metrics: ProduceMetrics): Pick<WritePassResult, "claims_rejected" | "model"> {
  return {
    claims_rejected: metrics.rejected,
    model: {
      ...(metrics.diagnostic === undefined ? {} : { diagnostic: metrics.diagnostic }),
      ...(metrics.usage_unknown === undefined ? {} : { usage_unknown: true }),
      calls: metrics.calls,
      input_tokens: metrics.input_tokens,
      output_tokens: metrics.output_tokens,
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
  readonly run_id?: string;
  readonly model_ref?: string | null;
  readonly producer?: ExtractionProducerPort;
  readonly claims?: ClaimsIo;
  /** RFC3339 clock shared with rails, receipt timestamps, and reservation days. */
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

/**
 * Ingest leftovers become live, then the receipted writer materializes
 * unwritten live claims under the same budget the rail already charged.
 * No model configured: claims stay live and unwritten; doctor says so.
 */
export async function runWritePass(
  db: Database,
  vaultPath: string,
  options: WritePassOptions,
): Promise<WritePassResult> {
  const { budget, extraction, run_id, model_ref, producer, claims, now } = options;
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
  try {
    return await withCanonMutationAsync(io, async (scope, owned) => {
      if (inspectCanonRecovery(owned.db).pending) {
        // A held write keeps its durable intent and blocks only new canon
        // writes. Ingest already ran; stop cleanly instead of failing each run.
        try { recoverCanonWritesOwned(scope, owned); }
        catch (error) { if (error instanceof CanonRecoveryError) return stoppedWritePass("recovery:held"); throw error; }
      }
      try {
        settleWriteReservations(owned.db, owned.vault_path);
        return await runWritePassOwned(scope, owned, options);
      } finally {
        settleWriteReservations(owned.db, owned.vault_path);
      }
    });
  } catch (error) {
    if (!(error instanceof VaultMutationError) || error.code !== "writer_busy") throw error;
    return stoppedWritePass("lock:busy");
  }
}

function stoppedWritePass(stopped: string): WritePassResult {
  return {
    revived: 0,
    claims_extracted: 0,
    claims_written: 0,
    claims_written_extracted: 0,
    claims_deduped: 0,
    claims_superseded: 0,
    canon_writes: 0,
    ...metricResult(emptyMetrics()),
    oversized: { segments: 0, skipped: 0 },
    stopped,
    errors: [],
  };
}

async function runWritePassOwned(
  scope: VaultMutationScope,
  io: CanonIo,
  options: WritePassOptions,
): Promise<WritePassResult> {
  requireCanonFiles(scope, io);
  const { db } = io;
  const revived = reviveUncontestedSkipped(db);
  let extracted = 0;
  let written = 0;
  let writtenExtracted = 0;
  let deduped = 0;
  let superseded = 0;
  let canonWrites = 0;
  let stopped: string | null = null;
  const errors: string[] = [];
  const metrics = emptyMetrics();
  const oversized = { segments: 0, skipped: 0 };

  if (options.producer !== undefined && options.claims !== undefined) {
    const runId = options.run_id ?? ulid();
    let produced = 0;
    const observed = observedProducer(options.producer, metrics, (result) => {
      // One row per run carries the pass's running totals. Before each request
      // it already charges that request, so a kill mid-call is still counted.
      if (result !== undefined) produced += producedCount(result);
      const usage = result === undefined
        ? { claims_rejected: metrics.rejected, claims_extracted: produced,
            model: { ...metricResult(metrics).model, calls: metrics.calls + 1, usage_unknown: true } }
        : { ...metricResult(metrics), claims_extracted: produced };
      db.query("INSERT INTO extract_usage(run_id,model_ref,metrics,created_at,holder_pid) VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET metrics=excluded.metrics").run(
        runId, options.model_ref ?? null, JSON.stringify(usage), new Date().toISOString(), process.pid,
      );
    });
    const pass: ExtractionPass = {
      db, claims: options.claims, producer: options.producer, observed, metrics,
      model_ref: options.model_ref ?? null, limits: options.extraction ?? DEFAULT_EXTRACTION_CONFIG,
    };
    // Every step files its decision and advances the cursor before the next
    // one starts, so a kill loses at most the request in flight.
    let retried = false;
    for (let taken = 0; taken < pass.limits.max_calls_per_pass; taken++) {
      let outcome: StepOutcome;
      try {
        outcome = await extractionStep(pass);
      } catch (error) {
        if (!(error instanceof DurableExtractAuthorizationError)) throw error;
        stopped = `source:${error.code}`;
        break;
      }
      extracted += outcome.extracted;
      deduped += outcome.deduped;
      superseded += outcome.superseded;
      oversized.segments += outcome.segments;
      oversized.skipped += outcome.skipped;
      errors.push(...outcome.errors);
      stopped = outcome.stopped;
      // A rejected response is asked for once more: a nondeterministic model
      // often answers the same records well on the next request.
      if (outcome.next === "stop" || (outcome.next === "retry" && retried)) break;
      retried = outcome.next === "retry";
    }
  }

  if (!modelConfigured(options)) {
    return {
      revived,
      claims_extracted: extracted,
      claims_written: written,
      claims_written_extracted: writtenExtracted,
      claims_deduped: deduped,
      claims_superseded: superseded,
      canon_writes: 0,
      ...metricResult(metrics),
      oversized,
      stopped,
      errors,
    };
  }

  for (const typedClaims of pendingWorldCanonClaims(db, WRITE_PASS_LIMIT)) {
    if (canonWrites >= WRITE_PASS_LIMIT) break;
    const primary=typedClaims[0]!;
    const decision=worldCanonTarget(db,primary.claim_id);
    const before=occupyingWriteIds(db);
    try {
      const receipt=applyCanonWriteOwned(scope,io,typedClaims,decision,{writer:"loop",budget:options.budget});
      canonWrites+=1;written+=receipt.claim_ids.length;
      writtenExtracted+=typedClaims.filter(claim=>claim.producer==="model"&&receipt.claim_ids.includes(claim.claim_id)).length;
    } catch(error) {
      if(!(error instanceof BudgetExhausted))canonWrites+=newOccupyingWrites(before,occupyingWriteIds(db));
      if(error instanceof BudgetExhausted){stopped=error.stopped;break;}
      errors.push(redactReceiptError(error));
    }
  }

  const pending = listUnwrittenLiveClaims(db, WRITE_PASS_SCAN);
  for (const claim of pending) {
    if (canonWrites >= WRITE_PASS_LIMIT) break;
    try {
      if (requiresSourceTombstoneBinding(db, claim)) requireSourceTombstoneProposal(db, claim, io);
      else requireExternalEvents(db, claim.provenance);
      const decision = segregateLoopDecision(resolveTarget(io, claim));
      if (decision.action === "skip") continue;
      const before = occupyingWriteIds(db);
      try {
        applyCanonWriteOwned(scope, io, claim, decision, {
          writer: "loop",
          budget: options.budget,
        });
        canonWrites += 1;
        written += 1;
        if (claim.producer === "model") writtenExtracted += 1;
      } catch (error) {
        // File/JSONL can land before the receipt row; count the SQLite slot.
        if (!(error instanceof BudgetExhausted)) {
          const committed = newOccupyingWrites(before, occupyingWriteIds(db));
          canonWrites += committed;
          written += committed;
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof SelfOriginError) continue;
      if (error instanceof BudgetExhausted) {
        stopped = error.stopped;
        break;
      }
      errors.push(redactReceiptError(error));
    }
  }

  return {
    revived,
    claims_extracted: extracted,
    claims_written: written,
    claims_written_extracted: writtenExtracted,
    claims_deduped: deduped,
    claims_superseded: superseded,
    canon_writes: canonWrites,
    ...metricResult(metrics),
    oversized,
    stopped,
    errors,
  };
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
  readonly db: Database;
  readonly claims: ClaimsIo;
  readonly producer: ExtractionProducerPort;
  /** The same port, observed so each request is charged to the run. */
  readonly observed: ExtractionProducerPort;
  readonly metrics: ProduceMetrics;
  readonly model_ref: string | null;
  readonly limits: ExtractionConfig;
}

interface StepOutcome {
  /**
   * `continue` after durable progress; `retry` after a rejected response to a
   * request that was sent, which the next step may repeat once; `stop` when
   * nothing is left or the next step could only repeat this one.
   */
  readonly next: "continue" | "retry" | "stop";
  readonly extracted: number;
  readonly deduped: number;
  readonly superseded: number;
  /** Segments of an oversized record this step filed. */
  readonly segments: number;
  /** Oversized records this step passed over with a skip receipt. */
  readonly skipped: number;
  readonly stopped: string | null;
  readonly errors: readonly string[];
}

const settled = (next: StepOutcome["next"], fields: Partial<Omit<StepOutcome, "next">> = {}): StepOutcome =>
  ({ next, extracted: 0, deduped: 0, superseded: 0, segments: 0, skipped: 0, stopped: null, errors: [], ...fields });

/** A provider that still refuses after the port's bounded retries ends the pass as a typed stop. */
function modelStop(reason: string, diagnostic: ProducerDiagnostic | undefined): string {
  const limited = diagnostic?.stage === "transport" && diagnostic.rule === "http" && diagnostic.http_status === 429;
  return limited ? "model:rate_limited" : `model:${reason}`;
}

/**
 * One durable step: file a pending decision without asking the model again,
 * or make at most one extraction request and commit its outcome.
 */
async function extractionStep(pass: ExtractionPass): Promise<StepOutcome> {
  const { db, claims, producer, observed, metrics, model_ref, limits } = pass;
  const pending = readDurableExtractBatch(db, producer);
  if (pending !== null) {
    // Replay files an existing decision; it is not another extraction.
    const filed = await fileProducedDrafts(claims, pending, producer);
    return filed === null
      ? settled("stop", { errors: ["extract cursor changed before durable batch commit"] })
      : settled("continue", { deduped: filed.deduped, superseded: filed.superseded });
  }
  const sent = metrics.calls, earlier = metrics.diagnostic;
  const mined = isProducerV2(observed)
    ? await mineLiveDrafts(db, observed, limits)
    : await mineLiveDrafts(db, observed, limits);
  const segmentCount = mined.segment === undefined ? 0 : 1;
  // Only this step's request can explain this step's failure.
  const fresh = metrics.diagnostic === earlier ? undefined : metrics.diagnostic;
  const diagnostic = fresh === undefined ? [] : [formatProducerDiagnostic(fresh)];
  switch (mined.mined.status) {
    case "unavailable":
      return settled("stop", { stopped: modelStop(mined.mined.reason, fresh), errors: diagnostic });
    case "rejected":
      // A refusal before sending, such as a record too large for any request, repeats identically.
      return settled(metrics.calls > sent ? "retry" : "stop", { errors: [mined.mined.reason, ...diagnostic] });
    case "empty":
      if (commitExtractCursor(db, mined)) return settled("continue", { segments: segmentCount });
      return settled("stop", { errors: mined.cursor === null ? [] : ["extract cursor changed before commit"] });
    case "deferred":
      return commitExtractCursor(db, mined)
        ? settled("continue")
        : settled("stop", { errors: ["extract deferred inputs changed before commit"] });
    case "skipped":
      // No safe split fits one request: the record is passed over with a receipt, not retried here.
      return commitExtractCursor(db, mined)
        ? settled("continue", { skipped: mined.mined.count })
        : settled("stop", { errors: ["extract cursor changed before commit"] });
    case "ok": {
      // Persist the accepted model output before the first claim write.  A
      // retry must replay this exact decision, never ask a nondeterministic
      // producer to regenerate a partially filed batch.
      journalExtractBatch(db, mined, model_ref, producer);
      const durable = readDurableExtractBatch(db, producer);
      if (durable === null) throw new Error("durable extraction decision is missing");
      const filed = await fileProducedDrafts(claims, durable, producer);
      return filed === null
        ? settled("stop", { errors: ["extract cursor changed before commit"] })
        : settled("continue", { extracted: mined.mined.count, deduped: filed.deduped, superseded: filed.superseded, segments: segmentCount });
    }
    default: {
      const _exhaustive: never = mined.mined;
      return _exhaustive;
    }
  }
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
