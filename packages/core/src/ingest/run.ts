import { sourceCaptureAdmission, type SourceAdmission } from "../ledger/source-grants";
import type { Database } from "bun:sqlite";
import type { Connector, Manifest, SyncBatch } from "../contracts/connector";
import {
  EVENT_LIMITS,
  validateEventInput,
  type CaptureEventInput,
} from "../contracts/event";
import {
  CONNECTOR_OPERATION_DEADLINE_MS,
  MAX_SYNC_BATCH_BYTES,
  MAX_SYNC_BATCH_EVENTS,
} from "../contracts/connector";
import { KizukiError } from "../contracts/errors";
import {
  assertCursorSize,
  checkpointModeCursor,
  getCheckpoint,
  hasSuccessfulSyncRun,
  LedgerError,
  type Checkpoint,
  type ConnectionRun,
  requireActiveConnection,
  type ConnectionRunStatus,
} from "../ledger/connections";
import { LedgerStoreError } from "../ledger/errors";
import { accept } from "../ledger/ledger";
import { resolveSensitivity } from "../sensitivity/resolve";
import { getConnectorSensitivity } from "../sensitivity/store";
import { cascadeTombstone, produceForEvent } from "../staging/producers";
import type { ProducerGrants } from "../staging/producers";
import { fileProposal } from "../staging/proposals";
import type { SourceTombstoneContext } from "../canon/source-tombstone";
import { DeadlineError, withDeadline } from "../util/deadline";
import { ulid } from "../util/ulid";
import { cloneExactJson } from "../util/validate";

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
  context?: SourceTombstoneContext,
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
        switch (accepted.kind) {
          case "infrastructure":
            throw new LedgerStoreError("infrastructure", accepted.error);
          case "validation":
            result.errors.push(accepted.error);
            return result;
          default: {
            const _exhaustive: never = accepted.kind;
            throw new LedgerStoreError("infrastructure", String(_exhaustive));
          }
        }
      }
      if (accepted.status === "duplicate") {
        result.duplicates = 1;
        return result;
      }

      result.stored = 1;
      if (accepted.event.deleted) {
        const cascade = cascadeTombstone(db, accepted.event, context);
        result.withdrawn = cascade.withdrawn.length;
        result.retractions_filed = cascade.retractions_filed.length;
        return result;
      }
      const produced = produceForEvent(accepted.event, grants);
      if (produced.status !== "ok") return result;
      for (const proposal of produced.proposals) {
        if (fileProposal(db, proposal).outcome === "stored") {
          result.proposals_created += 1;
        }
      }
      return result;
    })
    .immediate();
}

const HAS_MORE_ERROR = "sync batch has_more must be an own boolean data property";

/** Envelope JSON bounds: deep enough for a valid event, capped at the batch byte ceiling. */
const BATCH_JSON_LIMITS = {
  maxDepth: EVENT_LIMITS.metadataDepth + 2,
  maxKeysPerObject: EVENT_LIMITS.metadataKeysPerObject,
  maxArrayLength: Math.max(MAX_SYNC_BATCH_EVENTS, EVENT_LIMITS.metadataArrayLength),
  maxStringBytes: MAX_SYNC_BATCH_BYTES,
  maxKeyBytes: EVENT_LIMITS.metadataKeyBytes,
  maxTotalBytes: MAX_SYNC_BATCH_BYTES,
} as const;

/** Own data property only; accessors return null without executing. */
function ownData(
  object: object,
  key: string,
): { present: false } | { present: true; value: unknown } | null {
  const property = Object.getOwnPropertyDescriptor(object, key);
  if (property === undefined) return { present: false };
  if (!Object.hasOwn(property, "value")) return null;
  return { present: true, value: property.value };
}

function batchShapeError(errors: string[]): string {
  for (const error of errors) {
    if (error.includes(`exceeds ${MAX_SYNC_BATCH_BYTES}`)) {
      return `sync batch exceeds ${MAX_SYNC_BATCH_BYTES} bytes`;
    }
  }
  return errors[0] ?? "sync batch could not be read as plain data";
}

/**
 * Snapshot a connector batch into frozen exact JSON before any live inspect
 * or serialize. Accessors and toJSON stay unexecuted; failures are content-free.
 */
function ingressBatch(
  batch: SyncBatch,
): { ok: true; value: SyncBatch } | { ok: false; error: string } {
  try {
    const hasMoreField = ownData(batch, "has_more");
    if (hasMoreField === null || (hasMoreField.present && typeof hasMoreField.value !== "boolean")) {
      return { ok: false, error: HAS_MORE_ERROR };
    }
    const eventsField = ownData(batch, "events");
    if (eventsField === null || !eventsField.present) {
      return { ok: false, error: "sync batch events must be an own data property" };
    }
    const cursorField = ownData(batch, "cursor");
    if (cursorField === null || !cursorField.present) {
      return { ok: false, error: "sync batch cursor must be an own data property" };
    }
    const statusField = ownData(batch, "status");
    if (statusField === null) {
      return { ok: false, error: "sync batch status must be an own data property" };
    }
    const detailField = ownData(batch, "detail");
    if (detailField === null) {
      return { ok: false, error: "sync batch detail must be an own data property" };
    }

    let cursor: string | null;
    try {
      cursor = assertCursorSize(cursorField.value as string | null, "cursor");
    } catch (error) {
      return {
        ok: false,
        error: error instanceof LedgerError ? error.message : "cursor is not a cursor",
      };
    }

    const eventsValue = eventsField.value;
    if (!Array.isArray(eventsValue)) {
      return { ok: false, error: "events: must be an array" };
    }
    const length = Object.getOwnPropertyDescriptor(eventsValue, "length")?.value;
    if (typeof length === "number" && length > MAX_SYNC_BATCH_EVENTS) {
      return { ok: false, error: `sync batch exceeds ${MAX_SYNC_BATCH_EVENTS} events` };
    }

    const errors: string[] = [];
    const cloned = cloneExactJson(eventsValue, "events", BATCH_JSON_LIMITS, errors);
    if (cloned === undefined || !Array.isArray(cloned)) {
      return { ok: false, error: batchShapeError(errors) };
    }
    const encoded = new TextEncoder().encode(JSON.stringify(cloned));
    if (encoded.byteLength > MAX_SYNC_BATCH_BYTES) {
      return { ok: false, error: `sync batch exceeds ${MAX_SYNC_BATCH_BYTES} bytes` };
    }

    // The snapshot must not inherit hostile completion/status fields from Object.prototype.
    const snapshot = Object.assign(Object.create(null), {
      events: cloned as unknown as CaptureEventInput[],
      cursor,
      ...(hasMoreField.present ? { has_more: hasMoreField.value as boolean } : {}),
      ...(statusField.present && (statusField.value === "ok" || statusField.value === "unavailable")
        ? { status: statusField.value }
        : {}),
      ...(detailField.present && typeof detailField.value === "string"
        ? { detail: detailField.value }
        : {}),
    }) as SyncBatch;
    return { ok: true, value: Object.freeze(snapshot) };
  } catch {
    return { ok: false, error: "sync batch could not be read as plain data" };
  }
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
  context?: SourceTombstoneContext,
): RunResult {
  const ingress = ingressBatch(batch);
  if (!ingress.ok) return refusedRun(ingress.error, null);

  const result: RunResult = {
    stored: 0,
    duplicates: 0,
    errors: [],
    proposals_created: 0,
    withdrawn: 0,
    retractions_filed: 0,
    cursor: ingress.value.cursor,
  };

  for (const input of ingress.value.events) {
    try {
      const event = processEvent(db, input, grants, source, context);
      result.stored += event.stored;
      result.duplicates += event.duplicates;
      result.errors.push(...event.errors);
      result.proposals_created += event.proposals_created;
      result.withdrawn += event.withdrawn;
      result.retractions_filed += event.retractions_filed;
    } catch (error) {
      result.errors.push(errorText(error));
      if (error instanceof LedgerStoreError) {
        return result;
      }
    }
  }

  // bun:sqlite close() can leave this batch in the WAL; PASSIVE copies idle frames.
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
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
  return null;
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

function decodeAttemptedCursor(cursor: string): string | null {
  try {
    return assertCursorSize(cursor, "attempted_cursor");
  } catch {
    return null;
  }
}

function persistCheckpointRow(
  db: Database,
  connector_id: string,
  source_key: string,
  cursor: string | null,
  mode: "backfill" | "sync",
  result: RunResult,
  backfillComplete: boolean,
): Checkpoint {
  const at = new Date().toISOString();
  db.query(
    `INSERT INTO checkpoints
       (connector_id, source_key, cursor, mode, updated_at, last_run_at, last_result, backfill_complete, backfill_cursor, sync_cursor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (connector_id, source_key) DO UPDATE SET
       cursor = excluded.cursor,
       mode = excluded.mode,
       updated_at = excluded.updated_at,
       last_run_at = excluded.last_run_at,
       last_result = excluded.last_result,
       backfill_complete = CASE
         WHEN excluded.backfill_complete = 1 THEN 1
         ELSE checkpoints.backfill_complete
       END,
       backfill_cursor = CASE
         WHEN excluded.mode = 'backfill' THEN excluded.cursor
         ELSE checkpoints.backfill_cursor
       END,
       sync_cursor = CASE
         WHEN excluded.mode = 'sync' THEN excluded.cursor
         ELSE checkpoints.sync_cursor
       END`,
  ).run(
    connector_id,
    source_key,
    cursor,
    mode,
    at,
    at,
    JSON.stringify(result),
    backfillComplete ? 1 : 0,
    mode === "backfill" ? cursor : null,
    mode === "sync" ? cursor : null,
  );
  const checkpoint = getCheckpoint(db, connector_id, source_key);
  if (checkpoint === null) throw new LedgerError("saved checkpoint was not found");
  return checkpoint;
}

/**
 * The one ingest write path: bind to the live connection, store resume
 * state, and append an immutable run receipt. last_result.cursor is the
 * cursor that was actually committed.
 */
function persistRun(
  db: Database,
  connector_id: string,
  source_key: string,
  mode: "backfill" | "sync",
  previous_cursor: string | null,
  attempted_cursor: string | null,
  result: RunResult,
  status: ConnectionRunStatus,
  backfillComplete = false,
): RunResult {
  const committed_cursor =
    status === "ok" ? assertCursorSize(attempted_cursor, "attempted_cursor") : previous_cursor;
  const storedResult: RunResult = {
    stored: result.stored,
    duplicates: result.duplicates,
    errors: result.errors,
    proposals_created: result.proposals_created,
    withdrawn: result.withdrawn,
    retractions_filed: result.retractions_filed,
    cursor: committed_cursor,
  };
  const started = new Date().toISOString();
  return db
    .transaction((): RunResult => {
      requireActiveConnection(db, connector_id, source_key);
      const checkpoint = persistCheckpointRow(
        db,
        connector_id,
        source_key,
        committed_cursor,
        mode,
        storedResult,
        backfillComplete,
      );
      const run: ConnectionRun = {
        run_id: ulid(),
        connector_id,
        source_key,
        mode,
        started_at: started,
        finished_at: checkpoint.last_run_at,
        previous_cursor,
        attempted_cursor:
          attempted_cursor === null
            ? null
            : attempted_cursor === committed_cursor
              ? committed_cursor
              : decodeAttemptedCursor(attempted_cursor),
        committed_cursor,
        stored: storedResult.stored,
        duplicates: storedResult.duplicates,
        errors: storedResult.errors,
        status,
      };
      db.query(
        `INSERT INTO connection_runs
           (run_id, connector_id, source_key, mode, started_at, finished_at,
            previous_cursor, attempted_cursor, committed_cursor,
            stored, duplicates, errors, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.run_id,
        run.connector_id,
        run.source_key,
        run.mode,
        run.started_at,
        run.finished_at,
        run.previous_cursor,
        run.attempted_cursor,
        run.committed_cursor,
        run.stored,
        run.duplicates,
        JSON.stringify(run.errors),
        run.status,
      );
      return checkpoint.last_result;
    })
    .immediate();
}

interface ConnectorStep { result: RunResult; terminal: boolean; }

async function runConnector(
  db: Database,
  connector: Connector,
  connector_id: string,
  source_key: string,
  mode: "backfill" | "sync",
  context?: SourceTombstoneContext,
): Promise<ConnectorStep> {
  const checkpoint = getCheckpoint(db, connector_id, source_key);
  const storedPrevious = checkpointModeCursor(checkpoint, mode);
  let admission: SourceAdmission | null;
  try {
    requireActiveConnection(db, connector_id, source_key);
    admission = sourceCaptureAdmission(db, connector_id, source_key);
  } catch (error) {
    return { result: refusedRun(errorText(error), storedPrevious), terminal: false };
  }

  const manifest = connector.manifest();
  if (manifest.connector_id !== connector_id) {
    const result = refusedRun(
      `${connector_id}: manifest connector_id does not match the enrolled connection`,
      storedPrevious,
    );
    return { result: persistRun(db, connector_id, source_key, mode, storedPrevious, storedPrevious, result, "refused"), terminal: false };
  }
  if (mode === "backfill" && manifest.capabilities.backfill !== true) {
    const result = refusedRun(
      `${connector_id}: manifest does not declare backfill`,
      storedPrevious,
    );
    return { result: persistRun(db, connector_id, source_key, mode, storedPrevious, storedPrevious, result, "refused"), terminal: false };
  }
  if (mode === "sync" && manifest.capabilities.sync !== true) {
    const result = refusedRun(
      `${connector_id}: manifest does not declare sync`,
      storedPrevious,
    );
    return { result: persistRun(db, connector_id, source_key, mode, storedPrevious, storedPrevious, result, "refused"), terminal: false };
  }

  const previous =
    mode === "sync" &&
    storedPrevious === null &&
    manifest.capabilities.sync_from_backfill_before_first_success === true &&
    checkpoint !== null &&
    checkpoint.backfill_cursor !== null &&
    !hasSuccessfulSyncRun(db, connector_id, source_key)
      ? checkpoint.backfill_cursor
      : storedPrevious;

  let received: SyncBatch;
  try {
    received = await withDeadline(
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
    return { result: persistRun(db, connector_id, source_key, mode, previous, previous, result, status), terminal: false };
  }

  const ingress = ingressBatch(received);
  if (!ingress.ok) {
    const result = refusedRun(ingress.error, previous);
    return { result: persistRun(db, connector_id, source_key, mode, previous, previous, result, "refused"), terminal: false };
  }
  const batch = ingress.value;
  const hasMore = batch.has_more;

  if (batch.status === "unavailable") {
    const result = refusedRun(
      batch.detail ?? `${connector_id}: connector unavailable`,
      previous,
    );
    return { result: persistRun(db, connector_id, source_key, mode, previous, batch.cursor, result, "unavailable"), terminal: false };
  }

  const refusal = batchRefusal(manifest, connector_id, batch);
  if (refusal !== null) {
    const result = refusedRun(refusal, previous);
    return { result: persistRun(db, connector_id, source_key, mode, previous, batch.cursor, result, "refused"), terminal: false };
  }

  const processed = runBatch(
    db,
    labelBatch(db, connector_id, source_key, batch),
    sourceGrants(manifest),
    admission ?? undefined,
    context,
  );
  const status: ConnectionRunStatus = processed.errors.length === 0 ? "ok" : "failed";
  const result = persistRun(
    db,
    connector_id,
    source_key,
    mode,
    previous,
    batch.cursor,
    processed,
    status,
    mode === "backfill" && status === "ok" && hasMore === false,
  );
  return { result, terminal: status === "ok" && hasMore === false, continue_empty: status === "ok" && hasMore === true };
}

export async function runBackfill(
  db: Database,
  connector: Connector,
  connector_id: string,
  source_key: string,
  context?: SourceTombstoneContext,
): Promise<RunResult> {
  return (await runConnector(db, connector, connector_id, source_key, "backfill", context)).result;
}

export async function runSync(
  db: Database,
  connector: Connector,
  connector_id: string,
  source_key: string,
  context?: SourceTombstoneContext,
): Promise<RunResult> {
  return (await runConnector(db, connector, connector_id, source_key, "sync", context)).result;
}

export interface RunToCompletionOptions {
  /** Upper bound on batches per call; exceeding it is an error, not a silent stop. */
  maxBatches?: number;
  /** Host-owned vault path, required when a source tombstone targets receipted canon. */
  vault_path?: string;
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
 * cursor, successful terminal batch, or an error. An empty batch is a connector
 * saying it has nothing left to give; a connector with more to read has to say so by returning some
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
    checkpointModeCursor(getCheckpoint(db, connector_id, source_key), mode);
  const total: RunResult = emptyResult(stored());
  const context = opts?.vault_path === undefined ? undefined : { vault_path: opts.vault_path };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const before = stored();
    const { result, terminal, continue_empty } = await runConnector(db, connector, connector_id, source_key, mode, context);
    absorb(total, result);
    total.cursor = stored();
    if (result.errors.length > 0) return total;
    if (terminal) return total;
    if (total.cursor === null) return total;
    if (drained(result) && !continue_empty) return total;
    if (total.cursor === before) {
      total.errors.push("run made no progress");
      return total;
    }
  }
  total.errors.push(`run did not complete within ${maxBatches} batches`);
  return total;
}
