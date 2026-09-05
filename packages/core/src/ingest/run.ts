import { sourceCaptureAdmission, type SourceAdmission } from "../ledger/source-grants";
import type { Database } from "bun:sqlite";
import type { Connector, Manifest, SyncBatch } from "../contracts/connector";
import { validateEventInput } from "../contracts/event";
import {
  CONNECTOR_OPERATION_DEADLINE_MS,
  MAX_SYNC_BATCH_BYTES,
  MAX_SYNC_BATCH_EVENTS,
} from "../contracts/connector";
import { KizukiError } from "../contracts/errors";
import {
  assertCursorSize,
  getCheckpoint,
  recordConnectorRun,
  requireActiveConnection,
  type ConnectionRunStatus,
} from "../ledger/connections";
import { accept } from "../ledger/ledger";
import { resolveSensitivity } from "../sensitivity/resolve";
import { getConnectorSensitivity } from "../sensitivity/store";
import { cascadeTombstone, proposalsForEvent } from "../staging/producers";
import type { ProducerGrants } from "../staging/producers";
import { fileProposal } from "../staging/proposals";
import { DeadlineError, withDeadline } from "../util/deadline";

/**
 * What the manifest of the connector a batch came from grants that source.
 * The host reads it from the connector it enrolled, never from an event, so
 * captured metadata cannot ask for an authority its own source was not given.
 */
export function sourceGrants(manifest: Manifest): ProducerGrants {
  return { page_candidates: manifest.capabilities.page_candidates === true };
}

export interface RunResult {
  stored: number;
  duplicates: number;
  errors: string[];
  proposals_created: number;
  withdrawn: number;
  retractions_filed: number;
  cursor: string | null;
}

export class InfrastructureError extends Error {
  override readonly name = "InfrastructureError";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyResult(cursor: string | null): RunResult {
  return {
    stored: 0,
    duplicates: 0,
    errors: [],
    proposals_created: 0,
    withdrawn: 0,
    retractions_filed: 0,
    cursor,
  };
}

type EventResult = Omit<RunResult, "cursor">;

function processEvent(
  db: Database,
  input: unknown,
  grants: ProducerGrants,
  source?: SourceAdmission,
): EventResult {
  return db
    .transaction((): EventResult => {
      const result: EventResult = {
        stored: 0,
        duplicates: 0,
        errors: [],
        proposals_created: 0,
        withdrawn: 0,
        retractions_filed: 0,
      };
      const accepted = accept(db, input, source === undefined ? {} : { source });
      if (accepted.status === "error") {
        if (accepted.kind === "infrastructure") {
          throw new InfrastructureError(accepted.error);
        }
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
      for (const proposal of proposalsForEvent(accepted.event, grants)) {
        if (fileProposal(db, proposal).outcome === "stored") {
          result.proposals_created += 1;
        }
      }
      return result;
    })
    .immediate();
}

function batchBudgetRefusal(batch: SyncBatch): string | null {
  if (batch.events.length > MAX_SYNC_BATCH_EVENTS) {
    return `sync batch exceeds ${MAX_SYNC_BATCH_EVENTS} events`;
  }
  const encoded = new TextEncoder().encode(JSON.stringify(batch.events));
  if (encoded.byteLength > MAX_SYNC_BATCH_BYTES) {
    return `sync batch exceeds ${MAX_SYNC_BATCH_BYTES} bytes`;
  }
  if (batch.cursor !== null) {
    try {
      assertCursorSize(batch.cursor, "cursor");
    } catch (error) {
      return errorText(error);
    }
  }
  return null;
}

/**
 * The grants are the caller's to name: this seam is handed a batch with no
 * connector behind it, so nothing here can decide what that batch is entitled
 * to, and a default would decide it by omission.
 */
export function runBatch(
  db: Database,
  batch: SyncBatch,
  grants: ProducerGrants,
  source?: SourceAdmission,
): RunResult {
  const result: RunResult = {
    stored: 0,
    duplicates: 0,
    errors: [],
    proposals_created: 0,
    withdrawn: 0,
    retractions_filed: 0,
    cursor: batch.cursor,
  };

  const budget = batchBudgetRefusal(batch);
  if (budget !== null) {
    result.errors.push(budget);
    return result;
  }

  for (const input of batch.events) {
    try {
      const event = processEvent(db, input, grants, source);
      result.stored += event.stored;
      result.duplicates += event.duplicates;
      result.errors.push(...event.errors);
      result.proposals_created += event.proposals_created;
      result.withdrawn += event.withdrawn;
      result.retractions_filed += event.retractions_filed;
    } catch (error) {
      result.errors.push(errorText(error));
      if (error instanceof InfrastructureError) return result;
    }
  }

  return result;
}

/**
 * Why this batch may not run under the enrolled connection's grants, or null.
 * Authority belongs to the connector the host enrolled: the grant is read from
 * that manifest, so an event carrying a different source's id — or a kind the
 * manifest never declared — would be staged under authority nobody gave it.
 * One mismatch refuses the whole batch rather than the event, because a batch
 * that mixes sources is not a batch this connection can vouch for.
 *
 * The message names only the enrolled id: every other string on this path came
 * from the connector, and a runner's error is not where one is echoed back.
 */
function batchRefusal(
  manifest: Manifest,
  connector_id: string,
  batch: SyncBatch,
): string | null {
  if (manifest.connector_id !== connector_id) {
    return `${connector_id}: manifest connector_id does not match the enrolled connection`;
  }
  const kinds = new Set(manifest.kinds);
  for (const event of batch.events) {
    if (event.connector_id !== connector_id) {
      return `${connector_id}: batch carries an event from another connector`;
    }
    if (!kinds.has(event.kind)) {
      return `${connector_id}: batch carries a kind the manifest does not declare`;
    }
  }
  return batchBudgetRefusal(batch);
}

function refusedRun(reason: string, cursor: string | null): RunResult {
  return {
    stored: 0,
    duplicates: 0,
    errors: [reason],
    proposals_created: 0,
    withdrawn: 0,
    retractions_filed: 0,
    cursor,
  };
}

/**
 * The connector supplies a hint, but the enrolled connection supplies the
 * authority that turns it into a serving label. Preserve malformed inputs for
 * `accept` so this trusted step cannot turn a bad connector event into a
 * valid private one.
 */
function labelBatch(
  db: Database,
  connectorId: string,
  sourceKey: string,
  batch: SyncBatch,
): SyncBatch {
  const policy = getConnectorSensitivity(db, connectorId, sourceKey);
  const floor = policy?.floor ?? "private";
  const defaultSensitivity = policy?.default_sensitivity ?? "private";
  return {
    ...batch,
    events: batch.events.map((input) => {
      const validated = validateEventInput(input);
      if (!validated.ok) return input;
      return {
        ...validated.value,
        sensitivity_hint: resolveSensitivity({
          connector_floor: floor,
          connector_default: defaultSensitivity,
          ...(validated.value.sensitivity_hint === undefined
            ? {}
            : { event_hint: validated.value.sensitivity_hint }),
        }).sensitivity,
      };
    }),
  };
}

function isUnavailable(error: unknown, batch: SyncBatch | null): boolean {
  if (batch?.status === "unavailable") return true;
  if (error instanceof DeadlineError) return true;
  if (error instanceof KizukiError) {
    switch (error.code) {
      case "unauthenticated":
      case "unreachable":
      case "rate_limited":
      case "missing_secret":
      case "provider_error":
      case "timeout":
      case "unavailable":
        return true;
      case "misconfigured":
      case "protocol":
      case "unknown_connector":
      case "parse_error":
      case "not_supported":
      case "malformed_record":
      case "source_schema":
      case "corrupted":
        return false;
      default: {
        const _exhaustive: never = error.code;
        return _exhaustive;
      }
    }
  }
  return false;
}

function persistRun(
  db: Database,
  connector_id: string,
  source_key: string,
  mode: "backfill" | "sync",
  previous: string | null,
  attempted: string | null,
  result: RunResult,
  status: ConnectionRunStatus,
): RunResult {
  return recordConnectorRun(
    db,
    connector_id,
    source_key,
    mode,
    previous,
    attempted,
    result,
    status,
  ).checkpoint.last_result;
}

async function runConnector(
  db: Database,
  connector: Connector,
  connector_id: string,
  source_key: string,
  mode: "backfill" | "sync",
): Promise<RunResult> {
  const previous = getCheckpoint(db, connector_id, source_key)?.cursor ?? null;
  let admission: SourceAdmission | null;
  try {
    requireActiveConnection(db, connector_id, source_key);
    admission = sourceCaptureAdmission(db, connector_id, source_key);
  } catch (error) {
    return refusedRun(errorText(error), previous);
  }

  const manifest = connector.manifest();
  if (manifest.connector_id !== connector_id) {
    const result = refusedRun(
      `${connector_id}: manifest connector_id does not match the enrolled connection`,
      previous,
    );
    return persistRun(db, connector_id, source_key, mode, previous, previous, result, "refused");
  }
  if (mode === "backfill" && manifest.capabilities.backfill !== true) {
    const result = refusedRun(
      `${connector_id}: manifest does not declare backfill`,
      previous,
    );
    return persistRun(db, connector_id, source_key, mode, previous, previous, result, "refused");
  }
  if (mode === "sync" && manifest.capabilities.sync !== true) {
    const result = refusedRun(
      `${connector_id}: manifest does not declare sync`,
      previous,
    );
    return persistRun(db, connector_id, source_key, mode, previous, previous, result, "refused");
  }

  let batch: SyncBatch;
  try {
    batch = await withDeadline(
      mode === "backfill"
        ? connector.backfill(previous)
        : connector.sync(previous),
      CONNECTOR_OPERATION_DEADLINE_MS,
      `${mode} timed out`,
    );
  } catch (error) {
    const result = refusedRun(errorText(error), previous);
    const status: ConnectionRunStatus = isUnavailable(error, null)
      ? "unavailable"
      : "failed";
    return persistRun(db, connector_id, source_key, mode, previous, previous, result, status);
  }

  if (batch.status === "unavailable") {
    const result = refusedRun(
      batch.detail ?? `${connector_id}: connector unavailable`,
      previous,
    );
    return persistRun(db, connector_id, source_key, mode, previous, batch.cursor, result, "unavailable");
  }

  try {
    assertCursorSize(batch.cursor, "cursor");
  } catch (error) {
    const result = refusedRun(errorText(error), previous);
    return persistRun(db, connector_id, source_key, mode, previous, batch.cursor, result, "refused");
  }

  const refusal = batchRefusal(manifest, connector_id, batch);
  if (refusal !== null) {
    const result = refusedRun(refusal, previous);
    return persistRun(db, connector_id, source_key, mode, previous, batch.cursor, result, "refused");
  }

  const processed = runBatch(
    db,
    labelBatch(db, connector_id, source_key, batch),
    sourceGrants(manifest),
    admission ?? undefined,
  );
  const status: ConnectionRunStatus = processed.errors.length === 0 ? "ok" : "failed";
  return persistRun(
    db,
    connector_id,
    source_key,
    mode,
    previous,
    batch.cursor,
    processed,
    status,
  );
}

export function runBackfill(
  db: Database,
  connector: Connector,
  connector_id: string,
  source_key: string,
): Promise<RunResult> {
  return runConnector(db, connector, connector_id, source_key, "backfill");
}

export function runSync(
  db: Database,
  connector: Connector,
  connector_id: string,
  source_key: string,
): Promise<RunResult> {
  return runConnector(db, connector, connector_id, source_key, "sync");
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
  const total: RunResult = emptyResult(stored());
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const before = stored();
    const result = await runConnector(db, connector, connector_id, source_key, mode);
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
