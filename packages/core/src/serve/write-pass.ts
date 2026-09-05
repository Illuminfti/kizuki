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
import type { ClaimDraft, ProducerPort } from "../contracts/producer";
import {
  insertClaim,
  listUnwrittenLiveClaims,
  reviveUncontestedSkipped,
} from "../claims/store";
import type { ClaimsIo } from "../claims/store";
import { mineLiveDrafts } from "./extract";
import { tryWriteFlock } from "./flock";
import { redactReceiptError } from "./receipts";
import type { RunModelReport } from "./types";

/** One sync pass never materializes more than this many unwritten claims. */
const WRITE_PASS_LIMIT = 32;
/** Owner-edited skips stay live; scan past them so they cannot fill the write cap. */
const WRITE_PASS_SCAN = 256;
const NO_MODEL_USAGE: Pick<
  RunModelReport,
  "calls" | "input_tokens" | "output_tokens" | "unavailable"
> = { calls: 0, input_tokens: 0, output_tokens: 0, unavailable: 0 };

export interface WritePassResult {
  readonly revived: number;
  readonly claims_extracted: number;
  readonly claims_written: number;
  readonly claims_deduped: number;
  readonly claims_superseded: number;
  readonly canon_writes: number;
  readonly stopped: string | null;
  readonly errors: readonly string[];
  /** Model calls actually attempted this pass; zero when none was configured. */
  readonly model: Pick<
    RunModelReport,
    "calls" | "input_tokens" | "output_tokens" | "unavailable"
  >;
}

export interface WritePassOptions {
  readonly budget: BudgetTracker;
  readonly model_ref?: string | null;
  readonly producer?: ProducerPort;
  readonly claims?: ClaimsIo;
}

function modelConfigured(modelRef: string | null | undefined): boolean {
  return typeof modelRef === "string" && modelRef.length > 0;
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
      stopped: "lock:busy",
      errors: [],
      model: NO_MODEL_USAGE,
    };
  }
  try {
    return await runWritePassLocked(db, vaultPath, options);
  } finally {
    lock.release();
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
  const model = { ...NO_MODEL_USAGE };

  if (options.producer !== undefined && options.claims !== undefined) {
    const mined = await mineLiveDrafts(db, options.producer);
    model.calls = mined.usage.calls;
    model.input_tokens = mined.usage.input_tokens;
    model.output_tokens = mined.usage.output_tokens;
    switch (mined.mined.status) {
      case "unavailable":
        // A provider that never usefully answered, distinct from one that
        // answered and was refused (case "rejected" below) — see #438.
        stopped = `model:${mined.mined.reason}`;
        model.unavailable = 1;
        break;
      case "rejected":
        errors.push(
          mined.mined.detail === undefined
            ? mined.mined.reason
            : `${mined.mined.reason}: ${mined.mined.detail}`,
        );
        break;
      case "empty":
        break;
      case "ok": {
        const filed = await fileProducedDrafts(
          options.claims,
          mined.drafts,
          "model",
          options.model_ref ?? null,
        );
        extracted = mined.mined.count;
        deduped += filed.deduped;
        superseded += filed.superseded;
        break;
      }
      default: {
        const _exhaustive: never = mined.mined;
        return _exhaustive;
      }
    }
  }

  if (!modelConfigured(options.model_ref)) {
    return {
      revived,
      claims_extracted: extracted,
      claims_written: written,
      claims_deduped: deduped,
      claims_superseded: superseded,
      canon_writes: 0,
      stopped,
      errors,
      model,
    };
  }

  const io = { db, vault_path: vaultPath };
  const pending = listUnwrittenLiveClaims(db, WRITE_PASS_SCAN);
  for (const claim of pending) {
    if (canonWrites >= WRITE_PASS_LIMIT) break;
    try {
      const decision = segregateLoopDecision(resolveTarget(io, claim));
      if (decision.action === "skip") continue;
      applyCanonWrite(io, claim, decision, {
        writer: "loop",
        budget: options.budget,
      });
      canonWrites += 1;
      written += 1;
    } catch (error) {
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
    stopped,
    errors,
    model,
  };
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
