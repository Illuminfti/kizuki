import type { Database } from "bun:sqlite";
import { authorizeSourceCapture, bindSourceEvent, type SourceAdmission } from "./source-grants";
import { validateEventInput } from "../contracts/event";
import { tableExists } from "./schema";
import type {
  CaptureEvent,
  CaptureEventInput,
} from "../contracts/event";
import { canonicalSerialize, computeContentHash, computeLegacyContentHash, sha256Hex } from "../util/hash";
import { isUlid, ulid } from "../util/ulid";
import { EventRecordError, eventFromRow as fromRow, type EventRow } from "./event-record";
import { EventOriginError, classifyNewEventOrigin } from "./event-origin";
import { computeOriginBinding, nativeRequestDigest } from "./event-origin-binding";

export type AcceptErrorKind = "validation" | "infrastructure";

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
        throw new Error(`stored event ${eventId} could not be read back`);
      }
      return { status: "stored", event: fromRow(stored, db) };
    }).immediate();
  } catch (error) {
    return {
      status: "error",
      error: errorText(error),
      kind: isInfrastructureError(error) ? "infrastructure" : "validation",
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

function isInfrastructureError(error: unknown): boolean {
  if (error instanceof EventRecordError || error instanceof EventOriginError) return true;
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  const text = error instanceof Error ? error.message : String(error);
  return /SQLITE_(BUSY|LOCKED|CORRUPT|IOERR|FULL|CANTOPEN|READONLY|NOTADB|CONSTRAINT_FOREIGNKEY)/.test(
    `${code} ${text}`,
  );
}

/** Internal authoritative lookup used by bounded deferred extraction replay. */
export function readEvent(db: Database, eventId: string): CaptureEvent | null {
  const row = db.query<EventRow, [string]>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE event_id = ?`,
  ).get(eventId);
  return row === null ? null : fromRow(row, db);
}

export function readSince(
  db: Database,
  cursor: LedgerCursor | null,
  limit: number,
): { events: CaptureEvent[]; cursor: LedgerCursor | null } {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError("readSince limit must be a non-negative integer");
  }
  if (limit === 0) return { events: [], cursor: null };

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

  const last = rows.at(-1);
  return {
    events: rows.map(row => fromRow(row, db)),
    cursor:
      last === undefined
        ? null
        : { accepted_at: last.accepted_at, event_id: last.event_id },
  };
}

const REPLAY_PAGE = 500;

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

function replayPage(
  db: Database,
  filter: ReplayFilter,
  cursor: LedgerCursor | null,
  liveOnly: boolean,
): { events: CaptureEvent[]; cursor: LedgerCursor | null } {
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

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

  const where =
    conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  bindings.push(REPLAY_PAGE);
  const rows = db
    .query<EventRow, (string | number)[]>(
      `
        SELECT ${EVENT_COLUMNS}
        FROM events
        ${where}
        ORDER BY events.accepted_at, events.event_id
        LIMIT ?
      `,
    )
    .all(...bindings);
  const last = rows.at(-1);
  return {
    events: rows.map(row => fromRow(row, db)),
    cursor:
      last === undefined
        ? null
        : { accepted_at: last.accepted_at, event_id: last.event_id },
  };
}

function* replayPages(
  db: Database,
  filter: ReplayFilter,
  liveOnly: boolean,
): IterableIterator<CaptureEvent> {
  let cursor: LedgerCursor | null = null;
  for (;;) {
    const page = replayPage(db, filter, cursor, liveOnly);
    if (page.events.length === 0) return;
    for (const event of page.events) yield event;
    if (page.cursor === null || page.events.length < REPLAY_PAGE) return;
    cursor = page.cursor;
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
