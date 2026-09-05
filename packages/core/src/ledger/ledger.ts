import type { Database } from "bun:sqlite";
import { authorizeSourceCapture, bindSourceEvent, type SourceAdmission } from "./source-grants";
import { validateEventInput } from "../contracts/event";
import type {
  CaptureEvent,
  CaptureEventInput,
} from "../contracts/event";
import { canonicalSerialize, computeContentHash, computeLegacyContentHash, sha256Hex } from "../util/hash";
import { isRfc3339 } from "../util/time";
import { isUlid, ulid } from "../util/ulid";
import { EventRecordError, eventFromRow as fromRow, type EventRow } from "./event-record";
import { EventOriginError, classifyNewEventOrigin } from "./event-origin";
import { computeOriginBinding, nativeRequestDigest } from "./event-origin-binding";
import { classifySqliteFailure, LedgerStoreError } from "./errors";
import { LEDGER_ID_MAX, LEDGER_KIND_MAX, MAX_READ_SINCE, REPLAY_PAGE_SIZE } from "./limits";
import { tableExists } from "./schema";

export type AcceptErrorKind = "validation";

export type AcceptResult =
  | { status: "stored"; event: CaptureEvent }
  | { status: "duplicate" }
  | { status: "error"; error: string; kind: AcceptErrorKind };

export interface AcceptDependencies {
  generateId?: () => string;
  source?: SourceAdmission;
}

export interface LedgerCursor {
  accepted_at: string;
  event_id: string;
}

export interface LedgerPage {
  events: CaptureEvent[];
  /** Last committed token. Null only means beginning-of-stream. */
  cursor: LedgerCursor | null;
  exhausted: boolean;
}

export interface ReplayFilter {
  connector_id?: string;
  kind?: string;
  since?: string;
}

interface ExistingEventRow {
  event_id: string;
  content_hash: string;
}

const EVENT_COLUMNS = `
  event_id,
  connector_id,
  source_record_id,
  kind,
  occurred_at,
  observed_at,
  text,
  subjects,
  sensitivity_hint,
  deleted,
  attachments,
  metadata,
  content_hash,
  accepted_at,
  content_hash_version,
  text_hash,
  origin,
  origin_binding_version,
  origin_binding_kind,
  origin_binding
`;

function decodeStored(row: EventRow, db: Database): CaptureEvent {
  try {
    return fromRow(row, db);
  } catch (error) {
    if (error instanceof EventRecordError || error instanceof EventOriginError) {
      throw new LedgerStoreError("corrupt", error.message, { cause: error });
    }
    throw error;
  }
}

export function accept(
  db: Database,
  input: unknown | CaptureEventInput,
  deps: AcceptDependencies = {},
): AcceptResult {
  const validation = validateEventInput(input);
  if (!validation.ok) {
    return {
      status: "error",
      error: validation.errors.join("; "),
      kind: "validation",
    };
  }

  try {
    let normalized = validation.value;
    let contentHash = computeContentHash(normalized);
    const eventId = (deps.generateId ?? ulid)();
    if (!isUlid(eventId)) {
      return {
        status: "error",
        error: "event_id: generated id is not a canonical ULID",
        kind: "validation",
      };
    }

    return db.transaction((): AcceptResult => {
      if (deps.source !== undefined) { normalized = authorizeSourceCapture(db, normalized, deps.source); contentHash = computeContentHash(normalized); }
      const textHash = sha256Hex(normalized.text);
      let duplicate = db
        .query<EventRow, [string, string, string]>(
          `
            SELECT ${EVENT_COLUMNS}
            FROM events
            WHERE connector_id = ?
              AND source_record_id = ?
              AND content_hash = ?
            LIMIT 1
          `,
        )
        .get(
          normalized.connector_id,
          normalized.source_record_id,
          contentHash,
        );
      if (duplicate !== null && (duplicate.content_hash_version !== 2 ||
          canonicalSerialize(fromRow(duplicate, db)) !== canonicalSerialize(normalized))) throw new EventRecordError();
      if (duplicate === null) {
        using statement = db.prepare<EventRow, [string, string, string]>(`SELECT ${EVENT_COLUMNS} FROM events
          WHERE connector_id=? AND source_record_id=? AND content_hash=? AND content_hash_version=1 LIMIT 1`);
        const legacy = statement.get(normalized.connector_id, normalized.source_record_id, computeLegacyContentHash(normalized));
        if (legacy !== null && canonicalSerialize(fromRow(legacy, db)) === canonicalSerialize(normalized)) duplicate = legacy;
      }
      if (duplicate !== null) {
        if (deps.source !== undefined) bindSourceEvent(db, duplicate.event_id, deps.source, true);
        fromRow(duplicate, db);
        return { status: "duplicate" };
      }

      const idCollision = db
        .query<ExistingEventRow, [string]>(
          "SELECT event_id, content_hash FROM events WHERE event_id = ?",
        )
        .get(eventId);
      if (idCollision !== null) {
        const detail =
          idCollision.content_hash === contentHash
            ? "already belongs to another source record"
            : "existing row has a different content_hash";
        return {
          status: "error",
          error: `event_id collision for ${eventId}: ${detail}`,
          kind: "validation",
        };
      }

      const origin = classifyNewEventOrigin(db, { text: normalized.text, text_hash: textHash });
      insertBoundEvent(db, normalized, eventId, origin, "capture", null);

      if (deps.source !== undefined) bindSourceEvent(db, eventId, deps.source);
      const stored = db
        .query<EventRow, [string]>(
          `SELECT ${EVENT_COLUMNS} FROM events WHERE event_id = ?`,
        )
        .get(eventId);
      if (stored === null) {
        throw new LedgerStoreError("corrupt", "stored event could not be read back");
      }
      return { status: "stored", event: decodeStored(stored, db) };
    }).immediate();
  } catch (error) {
    const infra = classifySqliteFailure(error);
    if (infra !== null) throw infra;
    if (error instanceof LedgerStoreError) throw error;
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      kind: "validation",
    };
  }
}

/** Private insertion primitive: callers already own the write transaction. */
function insertBoundEvent(db: Database, input: CaptureEventInput, eventId: string,
  origin: CaptureEvent["origin"], kind: CaptureEvent["origin_binding_kind"], requestDigest: string | null,
): void {
  const acceptedAt = new Date().toISOString();
  const identity = { event_id: eventId, content_hash_version: 2 as const,
    content_hash: computeContentHash(input), text_hash: sha256Hex(input.text), origin };
  using insert = db.prepare(`INSERT INTO events (${EVENT_COLUMNS}) VALUES (${Array(20).fill("?").join(",")})`);
  insert.run(eventId, input.connector_id, input.source_record_id, input.kind, input.occurred_at, input.observed_at,
    input.text, JSON.stringify(input.subjects), input.sensitivity_hint ?? null, input.deleted ? 1 : 0,
    JSON.stringify(input.attachments), JSON.stringify(input.metadata), identity.content_hash, acceptedAt, 2,
    identity.text_hash, origin, 1, kind, computeOriginBinding(identity, acceptedAt, kind, requestDigest));
}

/** Internal Core native operation. Public capture has no exemption parameter. */
export function recordNativeCorrectionEvent(db: Database, input: CaptureEventInput, requestDigest: string): {
  event_id: string; duplicate: boolean;
} {
  const checked = validateEventInput(input);
  if (!checked.ok || checked.value.connector_id !== "kizuki.owner" || !/^[a-f0-9]{64}$/.test(requestDigest)) {
    throw new Error("invalid native correction recording");
  }
  if (db.inTransaction) throw new Error("native correction recording requires a top-level transaction");
  const event = checked.value;
  return db.transaction(() => {
    using existing = db.prepare<EventRow, [string, string]>(`SELECT * FROM events
      WHERE connector_id=? AND source_record_id=? ORDER BY accepted_at,event_id LIMIT 1`);
    const prior = existing.get(event.connector_id, event.source_record_id);
    if (prior !== null) {
      const stored = fromRow(prior, db);
      if (nativeRequestDigest(db, stored.event_id) !== requestDigest) {
        throw new Error("correction recording conflicts with existing evidence");
      }
      return { event_id: stored.event_id, duplicate: true };
    }
    const eventId = ulid();
    insertBoundEvent(db, event, eventId, "external", "native", requestDigest);
    using proof = db.prepare(`INSERT INTO native_owner_evidence
      (event_id,origin,request_digest,recorded_at,filing_state,event_content_hash) VALUES (?,'correction',?,?,'recorded',?)`);
    proof.run(eventId, requestDigest, event.observed_at, computeContentHash(event));
    const stored = readEvent(db, eventId);
    if (stored === null) throw new Error("native correction recording failed");
    return { event_id: stored.event_id, duplicate: false };
  }).immediate();
}

function assertReadLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new LedgerStoreError("usage", "readSince limit must be a non-negative integer");
  }
  if (limit > MAX_READ_SINCE) {
    throw new LedgerStoreError(
      "usage",
      `readSince limit must be at most ${MAX_READ_SINCE}`,
    );
  }
}

function pageFromRows(
  rows: EventRow[],
  limit: number,
  previous: LedgerCursor | null,
  db: Database,
): LedgerPage {
  const last = rows.at(-1);
  return {
    events: rows.map((row) => decodeStored(row, db)),
    cursor:
      last === undefined
        ? previous
        : { accepted_at: last.accepted_at, event_id: last.event_id },
    exhausted: rows.length < limit,
  };
}

/** Internal authoritative lookup used by bounded deferred extraction replay. */
export function readEvent(db: Database, eventId: string): CaptureEvent | null {
  const row = db.query<EventRow, [string]>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE event_id = ?`,
  ).get(eventId);
  return row === null ? null : decodeStored(row, db);
}

export function readSince(
  db: Database,
  cursor: LedgerCursor | null,
  limit: number,
): LedgerPage {
  assertReadLimit(limit);
  if (limit === 0) {
    return { events: [], cursor, exhausted: true };
  }

  const rows =
    cursor === null
      ? db
          .query<EventRow, [number]>(
            `
              SELECT ${EVENT_COLUMNS}
              FROM events
              ORDER BY accepted_at, event_id
              LIMIT ?
            `,
          )
          .all(limit)
      : db
          .query<EventRow, [string, string, string, number]>(
            `
              SELECT ${EVENT_COLUMNS}
              FROM events
              WHERE accepted_at > ?
                 OR (accepted_at = ? AND event_id > ?)
              ORDER BY accepted_at, event_id
              LIMIT ?
            `,
          )
          .all(cursor.accepted_at, cursor.accepted_at, cursor.event_id, limit);

  return pageFromRows(rows, limit, cursor, db);
}

function assertIdentifier(value: string, label: string, max: number): string {
  if (value.length === 0 || value.length > max) {
    throw new LedgerStoreError("usage", `${label} length must be 1..${max}`);
  }
  if ([...value].some((ch) => ch.charCodeAt(0) < 32)) {
    throw new LedgerStoreError("usage", `${label} contains a control character`);
  }
  return value;
}

export function normalizeReplayFilter(filter: ReplayFilter): ReplayFilter {
  const out: ReplayFilter = {};
  if (filter.connector_id !== undefined) {
    if (typeof filter.connector_id !== "string") {
      throw new LedgerStoreError("usage", "connector_id must be a string");
    }
    out.connector_id = assertIdentifier(filter.connector_id, "connector_id", LEDGER_ID_MAX);
  }
  if (filter.kind !== undefined) {
    if (typeof filter.kind !== "string") {
      throw new LedgerStoreError("usage", "kind must be a string");
    }
    out.kind = assertIdentifier(filter.kind, "kind", LEDGER_KIND_MAX);
  }
  if (filter.since !== undefined) {
    if (!isRfc3339(filter.since)) {
      throw new LedgerStoreError("usage", "since must be an RFC3339 timestamp");
    }
    out.since = filter.since;
  }
  return out;
}

const LIVE_PREDICATE = `
  events.deleted = 0
  AND NOT EXISTS (
    SELECT 1 FROM events AS tombstone
     WHERE tombstone.deleted = 1
       AND tombstone.connector_id = events.connector_id
       AND tombstone.source_record_id = events.source_record_id
       AND (
         tombstone.accepted_at > events.accepted_at
         OR (
           tombstone.accepted_at = events.accepted_at
           AND tombstone.event_id > events.event_id
         )
       )
  )
`;

function replayWhere(
  filter: ReplayFilter,
  cursor: LedgerCursor | null,
  liveOnly: boolean,
): { sql: string; bindings: Array<string | number> } {
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (filter.connector_id !== undefined) {
    conditions.push("events.connector_id = ?");
    bindings.push(filter.connector_id);
  }
  if (filter.kind !== undefined) {
    conditions.push("events.kind = ?");
    bindings.push(filter.kind);
  }
  if (filter.since !== undefined) {
    conditions.push("events.occurred_at >= ?");
    bindings.push(filter.since);
  }
  if (liveOnly) conditions.push(LIVE_PREDICATE);
  if (cursor !== null) {
    conditions.push(
      "(events.accepted_at > ? OR (events.accepted_at = ? AND events.event_id > ?))",
    );
    bindings.push(cursor.accepted_at, cursor.accepted_at, cursor.event_id);
  }
  return {
    sql: conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`,
    bindings,
  };
}

function* replayPages(
  db: Database,
  filter: ReplayFilter,
  liveOnly: boolean,
): IterableIterator<CaptureEvent> {
  const normalized = normalizeReplayFilter(filter);
  let cursor: LedgerCursor | null = null;
  for (;;) {
    const where = replayWhere(normalized, cursor, liveOnly);
    const rows = db
      .query<EventRow, Array<string | number>>(
        `
          SELECT ${EVENT_COLUMNS}
          FROM events
          ${where.sql}
          ORDER BY events.accepted_at, events.event_id
          LIMIT ?
        `,
      )
      .all(...where.bindings, REPLAY_PAGE_SIZE);
    for (const row of rows) yield decodeStored(row, db);
    const last = rows.at(-1);
    if (last === undefined || rows.length < REPLAY_PAGE_SIZE) return;
    cursor = { accepted_at: last.accepted_at, event_id: last.event_id };
  }
}

export function* replay(
  db: Database,
  filter: ReplayFilter,
): IterableIterator<CaptureEvent> {
  yield* replayPages(db, filter, false);
}

/** Live events only: a later tombstone of the same source record is omitted. */
export function* replayLive(
  db: Database,
  filter: ReplayFilter = {},
): IterableIterator<CaptureEvent> {
  yield* replayPages(db, filter, true);
}

export function latestLedgerCursor(db: Database): LedgerCursor | null {
  if (!tableExists(db, "events")) return null;
  return (
    db
      .query<LedgerCursor, []>(
        `SELECT accepted_at, event_id
           FROM events
          ORDER BY accepted_at DESC, event_id DESC
          LIMIT 1`,
      )
      .get() ?? null
  );
}

export function count(db: Database): number {
  return (
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
      ?.count ?? 0
  );
}
