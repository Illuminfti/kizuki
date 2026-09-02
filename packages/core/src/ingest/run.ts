import type { Database } from "bun:sqlite";
import type { Connector, SyncBatch } from "../contracts/connector";
import { getCheckpoint, saveCheckpoint } from "../ledger/connections";
import { accept } from "../ledger/ledger";
import { cascadeTombstone, proposalsForEvent } from "../staging/producers";
import { fileProposal } from "../staging/proposals";

export interface RunResult {
  stored: number;
  duplicates: number;
  errors: string[];
  proposals_created: number;
  withdrawn: number;
  retractions_filed: number;
  cursor: string | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type EventResult = Omit<RunResult, "cursor">;

function processEvent(db: Database, input: unknown): EventResult {
  return db.transaction((): EventResult => {
    const result: EventResult = {
      stored: 0,
      duplicates: 0,
      errors: [],
      proposals_created: 0,
      withdrawn: 0,
      retractions_filed: 0,
    };
    const accepted = accept(db, input);
    if (accepted.status === "error") {
      result.errors.push(accepted.error);
      return result;
    }
    if (accepted.status === "duplicate") {
      result.duplicates = 1;
      return result;
    }

    result.stored = 1;
    if (accepted.event.deleted) {
      const cascade = cascadeTombstone(db, accepted.event);
      result.withdrawn = cascade.withdrawn.length;
      result.retractions_filed = cascade.retractions_filed.length;
      return result;
    }
    for (const proposal of proposalsForEvent(accepted.event)) {
      if (fileProposal(db, proposal).outcome === "stored") {
        result.proposals_created += 1;
      }
    }
    return result;
  }).immediate();
}

export function runBatch(db: Database, batch: SyncBatch): RunResult {
  const result: RunResult = {
    stored: 0,
    duplicates: 0,
    errors: [],
    proposals_created: 0,
    withdrawn: 0,
    retractions_filed: 0,
    cursor: batch.cursor,
  };

  for (const input of batch.events) {
    try {
      const event = processEvent(db, input);
      result.stored += event.stored;
      result.duplicates += event.duplicates;
      result.errors.push(...event.errors);
      result.proposals_created += event.proposals_created;
      result.withdrawn += event.withdrawn;
      result.retractions_filed += event.retractions_filed;
    } catch (error) {
      result.errors.push(errorText(error));
    }
  }

  return result;
}

export async function runBackfill(
  db: Database,
  connector: Connector,
  connector_id: string,
  source_key: string,
): Promise<RunResult> {
  const checkpoint = getCheckpoint(db, connector_id, source_key);
  const result = runBatch(
    db,
    await connector.backfill(checkpoint?.cursor ?? null),
  );
  saveCheckpoint(
    db,
    connector_id,
    source_key,
    result.errors.length === 0 ? result.cursor : checkpoint?.cursor ?? null,
    "backfill",
    result,
  );
  return result;
}

export async function runSync(
  db: Database,
  connector: Connector,
  connector_id: string,
  source_key: string,
): Promise<RunResult> {
  const checkpoint = getCheckpoint(db, connector_id, source_key);
  const cursor = checkpoint?.cursor ?? null;
  const result = runBatch(db, await connector.sync(cursor));
  saveCheckpoint(
    db,
    connector_id,
    source_key,
    result.errors.length === 0 ? result.cursor : cursor,
    "sync",
    result,
  );
  return result;
}

export interface RunToCompletionOptions {
  /** Upper bound on batches per call; exceeding it is an error, not a silent stop. */
  maxBatches?: number;
}

/** Batches beyond this are treated as a connector that will not settle. */
export const DEFAULT_MAX_BATCHES = 10_000;

function drained(result: RunResult): boolean {
  return result.stored + result.duplicates + result.errors.length === 0;
}

function absorb(total: RunResult, batch: RunResult): void {
  total.stored += batch.stored;
  total.duplicates += batch.duplicates;
  total.errors.push(...batch.errors);
  total.proposals_created += batch.proposals_created;
  total.withdrawn += batch.withdrawn;
  total.retractions_filed += batch.retractions_filed;
}

/**
 * Repeats a bounded-batch connector until it returns an empty batch, a null
 * cursor, or an error. An empty batch is a connector saying it has nothing
 * left to give; a connector with more to read has to say so by returning some
 * of it. Each batch and its checkpoint are committed before the next call, so
 * an interruption resumes from the last durable checkpoint rather than
 * replaying the run, and a connector that throws mid-run still returns what
 * the batches before it stored.
 */
export async function runToCompletion(
  db: Database,
  connector: Connector,
  connector_id: string,
  source_key: string,
  mode: "backfill" | "sync",
  opts?: RunToCompletionOptions,
): Promise<RunResult> {
  const maxBatches = opts?.maxBatches ?? DEFAULT_MAX_BATCHES;
  if (!Number.isSafeInteger(maxBatches) || maxBatches <= 0) {
    throw new TypeError("runToCompletion: maxBatches must be a positive integer");
  }
  const stored = (): string | null =>
    getCheckpoint(db, connector_id, source_key)?.cursor ?? null;
  const total: RunResult = {
    stored: 0,
    duplicates: 0,
    errors: [],
    proposals_created: 0,
    withdrawn: 0,
    retractions_filed: 0,
    cursor: stored(),
  };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const before = stored();
    const result =
      mode === "backfill"
        ? await runBackfill(db, connector, connector_id, source_key)
        : await runSync(db, connector, connector_id, source_key);
    absorb(total, result);
    total.cursor = stored();
    if (result.errors.length > 0) return total;
    if (total.cursor === null) return total;
    if (drained(result)) return total;
    if (total.cursor === before) {
      total.errors.push("run made no progress");
      return total;
    }
  }
  total.errors.push(`run did not complete within ${maxBatches} batches`);
  return total;
}
