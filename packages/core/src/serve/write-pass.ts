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
import type { ProducerPort } from "../contracts/producer";
import { insertClaim } from "../claims/store";
import type { ClaimsIo } from "../claims/store";
import {
  listUnwrittenLiveClaims,
  reviveUncontestedSkipped,
} from "../claims/store";
import { mineLiveDrafts } from "./extract";
import { tryWriteFlock } from "./flock";
import { redactReceiptError } from "./receipts";

/** One sync pass never materializes more than this many unwritten claims. */
export const WRITE_PASS_LIMIT = 32;

export interface WritePassResult {
  readonly revived: number;
  readonly claims_extracted: number;
  readonly claims_written: number;
  readonly claims_deduped: number;
  readonly claims_superseded: number;
  readonly canon_writes: number;
  readonly stopped: string | null;
  readonly errors: readonly string[];
}

export interface WritePassOptions {
  readonly budget: BudgetTracker;
  readonly model_ref?: string | null;
  readonly producer?: ProducerPort;
  readonly claims?: ClaimsIo;
  readonly now?: () => string;
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

  if (options.producer !== undefined && options.claims !== undefined) {
    const mined = await mineLiveDrafts(db, options.producer);
    switch (mined.mined.status) {
      case "unavailable":
        stopped = `model:${mined.mined.reason}`;
        break;
      case "rejected":
        errors.push(mined.mined.reason);
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
        written += filed.written;
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
    };
  }

  const io = { db, vault_path: vaultPath };
  const pending = listUnwrittenLiveClaims(db, WRITE_PASS_LIMIT);
  for (const claim of pending) {
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
  };
}

export async function fileProducedDrafts(
  io: ClaimsIo,
  drafts: readonly {
    kind: Claim["kind"];
    subject: string;
    predicate: string;
    object: string;
    polarity: Claim["polarity"];
    body: string;
    event_ids: readonly string[];
    confidence: number;
    sensitivity?: Claim["sensitivity"];
  }[],
  producer: Claim["producer"],
  modelRef: string | null,
): Promise<{ written: number; deduped: number; superseded: number }> {
  let written = 0;
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
      ...(draft.sensitivity === undefined ? {} : { sensitivity: draft.sensitivity }),
    });
    switch (result.outcome) {
      case "stored":
        written += 1;
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
  return { written, deduped, superseded };
}
