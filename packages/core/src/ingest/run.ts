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
