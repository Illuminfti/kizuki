import { inheritSourcePortBindings } from "../ledger/source-grants";
import { readReceiptsLog } from "../canon/receipts";
import { settleWriteReservations } from "./budget-ledger";
import { ulid } from "../util/ulid";
import type { Database } from "bun:sqlite";
import {
  BudgetExhausted,
  applyCanonWrite,
  resolveTarget,
  type BudgetTracker,
  type TargetDecision,
} from "../canon";
import { machineOriginPath } from "../canon/origin";
import type { Claim } from "../contracts/proposal";
import type { ClaimDraft, ProduceResult, ProducerPort } from "../contracts/producer";
import type { RunModelReport } from "./types";
import {
  insertClaim,
  listUnwrittenLiveClaims,
  reviveUncontestedSkipped,
} from "../claims/store";
import type { ClaimsIo } from "../claims/store";
import {
  commitExtractCursor,
  completeDurableExtractBatch,
  journalExtractBatch,
  mineLiveDrafts,
  readDurableExtractBatch,
} from "./extract";
import { tryWriteFlock } from "./flock";
import { redactReceiptError } from "./receipts";

/** One sync pass never materializes more than this many unwritten claims. */
const WRITE_PASS_LIMIT = 32;
/** Owner-edited skips stay live; scan past them so they cannot fill the write cap. */
const WRITE_PASS_SCAN = 256;

export interface WritePassResult {
  readonly revived: number;
  readonly claims_extracted: number;
  readonly claims_written: number;
  readonly claims_deduped: number;
  readonly claims_superseded: number;
  readonly canon_writes: number;
  readonly claims_rejected: Readonly<Record<string, number>>;
  readonly model: Omit<RunModelReport, "model_ref">;
  readonly stopped: string | null;
  readonly errors: readonly string[];
}

interface ProduceMetrics {
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

function observe(metrics: ProduceMetrics, result: ProduceResult, wallMs: number): void {
  metrics.wall_ms += wallMs;
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

function observedProducer(producer: ProducerPort, metrics: ProduceMetrics, record: (result?: ProduceResult) => void): ProducerPort {
  const observed: ProducerPort = {
    descriptor: producer.descriptor,
    health: () => producer.health(),
    close: () => producer.close(),
    async produce(input) {
      const started = performance.now();
      // Commit intent before crossing the asynchronous external-effect boundary.
      record();
      const result = await producer.produce(input);
      observe(metrics, result, Math.max(0, Math.round(performance.now() - started)));
      record(result);
      return result;
    },
  };
  return inheritSourcePortBindings(producer, observed);
}

function metricResult(metrics: ProduceMetrics): Pick<WritePassResult, "claims_rejected" | "model"> {
  return {
    claims_rejected: metrics.rejected,
    model: {
      calls: metrics.calls,
      input_tokens: metrics.input_tokens,
      output_tokens: metrics.output_tokens,
      unavailable: metrics.unavailable,
      wall_ms: metrics.wall_ms,
    },
  };
}

export interface WritePassOptions {
  readonly budget: BudgetTracker;
  readonly run_id?: string;
  readonly model_ref?: string | null;
  readonly producer?: ProducerPort;
  readonly claims?: ClaimsIo;
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
  const lock = tryWriteFlock(vaultPath);
  if (lock === null) {
    return {
      revived: 0,
      claims_extracted: 0,
      claims_written: 0,
      claims_deduped: 0,
      claims_superseded: 0,
      canon_writes: 0,
      ...metricResult(emptyMetrics()),
      stopped: "lock:busy",
      errors: [],
    };
  }
  try {
    settleWriteReservations(db, vaultPath);
    return await runWritePassLocked(db, vaultPath, options);
  } finally {
    try { settleWriteReservations(db, vaultPath); }
    finally { lock.release(); }
  }
}

async function runWritePassLocked(
  db: Database,
  vaultPath: string,
  options: WritePassOptions,
): Promise<WritePassResult> {
  const revived = reviveUncontestedSkipped(db);
  let extracted = 0;
  let written = 0;
  let deduped = 0;
  let superseded = 0;
  let canonWrites = 0;
  let stopped: string | null = null;
  const errors: string[] = [];
  const metrics = emptyMetrics();

  if (options.producer !== undefined && options.claims !== undefined) {
    const pendingBatch = readDurableExtractBatch(db, options.producer);
    if (pendingBatch !== null) {
      const filed = await fileProducedDrafts(options.claims, pendingBatch.drafts, "model", pendingBatch.model_ref);
      // Replay files an existing decision; it is not another extraction.
      extracted = 0;
      deduped += filed.deduped;
      superseded += filed.superseded;
      if (!completeDurableExtractBatch(db, pendingBatch, options.producer)) {
        errors.push("extract cursor changed before durable batch commit");
      }
    } else {
    const runId = options.run_id ?? ulid();
    const mined = await mineLiveDrafts(db, observedProducer(options.producer, metrics, (result) => {
      db.query("INSERT INTO extract_usage(run_id,model_ref,metrics,created_at,holder_pid) VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET metrics=excluded.metrics").run(
        runId, options.model_ref ?? null, JSON.stringify(result === undefined ? { claims_rejected: {}, claims_extracted: 0, model: { ...metricResult(metrics).model, calls: 1, usage_unknown: true } } : { ...metricResult(metrics), claims_extracted: result.status === "ok" ? result.claims.length : 0 }), new Date().toISOString(), process.pid,
      );
    }));
    switch (mined.mined.status) {
      case "unavailable":
        stopped = `model:${mined.mined.reason}`;
        break;
      case "rejected":
        errors.push(mined.mined.reason);
        break;
      case "empty": {
        if (!commitExtractCursor(db, mined) && mined.cursor !== null) {
          errors.push("extract cursor changed before commit");
        }
        break;
      }
      case "deferred": {
        if (!commitExtractCursor(db, mined)) errors.push("extract deferred inputs changed before commit");
        break;
      }
      case "ok": {
        // Persist the accepted model output before the first claim write.  A
        // retry must replay this exact decision, never ask a nondeterministic
        // producer to regenerate a partially filed batch.
        journalExtractBatch(db, mined, options.model_ref ?? null, options.producer);
        const filed = await fileProducedDrafts(
          options.claims,
          mined.drafts,
          "model",
          options.model_ref ?? null,
        );
        extracted = mined.mined.count;
        deduped += filed.deduped;
        superseded += filed.superseded;
        const durable = readDurableExtractBatch(db, options.producer);
        if (durable === null || !completeDurableExtractBatch(db, durable, options.producer)) {
          errors.push("extract cursor changed before commit");
        }
        break;
      }
      default: {
        const _exhaustive: never = mined.mined;
        return _exhaustive;
      }
    }
    }
  }

  if (!modelConfigured(options)) {
    return {
      revived,
      claims_extracted: extracted,
      claims_written: written,
      claims_deduped: deduped,
      claims_superseded: superseded,
      canon_writes: 0,
      ...metricResult(metrics),
      stopped,
      errors,
    };
  }

  const io = { db, vault_path: vaultPath };
  const pending = listUnwrittenLiveClaims(db, WRITE_PASS_SCAN);
  for (const claim of pending) {
    if (canonWrites >= WRITE_PASS_LIMIT) break;
    const receiptsBefore = loopReceiptCount(db, vaultPath);
    try {
      const decision = segregateLoopDecision(resolveTarget(io, claim));
      if (decision.action === "skip") continue;
      applyCanonWrite(io, claim, decision, {
        writer: "loop",
        budget: options.budget,
      });
      const committed = loopReceiptCount(db, vaultPath) - receiptsBefore;
      canonWrites += committed;
      written += committed;
    } catch (error) {
      // Derived refresh happens after the canon receipt is durable.  Count a
      // committed write even when that optional follow-up fails, so the run
      // receipt and budget cannot hide it.
      const committed = loopReceiptCount(db, vaultPath) - receiptsBefore;
      canonWrites += committed;
      written += committed;
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
    claims_deduped: deduped,
    claims_superseded: superseded,
    canon_writes: canonWrites,
    ...metricResult(metrics),
    stopped,
    errors,
  };
}

function loopReceiptCount(db: Database, vaultPath: string): number {
  const ids = new Set(db.query<{ receipt_id: string }, []>(
    "SELECT receipt_id FROM canon_receipts WHERE writer = 'loop'",
  ).all().map(row => row.receipt_id));
  for (const receipt of readReceiptsLog(vaultPath)) {
    if (receipt.writer === "loop") ids.add(receipt.receipt_id);
  }
  return ids.size;
}

async function fileProducedDrafts(
  io: ClaimsIo,
  drafts: readonly ClaimDraft[],
  producer: Claim["producer"],
  modelRef: string | null,
): Promise<{ deduped: number; superseded: number }> {
  let deduped = 0;
  let superseded = 0;
  for (const draft of drafts) {
    const result = await insertClaim(io, {
      kind: draft.kind,
      subject: draft.subject,
      predicate: draft.predicate,
      object: draft.object,
      polarity: draft.polarity,
      body: draft.body,
      provenance: [...draft.event_ids],
      subjects: [draft.subject],
      producer,
      model_ref: modelRef,
      confidence: draft.confidence,
      taint: "quoted",
      sensitivity: draft.sensitivity,
      ...(draft.valid_from === null ? {} : { valid_from: draft.valid_from }),
      ...(draft.valid_to === null ? {} : { valid_to: draft.valid_to }),
    });
    switch (result.outcome) {
      case "stored":
        superseded += result.superseded.length;
        break;
      case "duplicate":
        deduped += 1;
        break;
      case "skipped":
      case "contested":
        break;
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }
  return { deduped, superseded };
}
