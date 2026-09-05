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
import { EventOriginError, classifyEventOrigin, refreshEventOrigin } from "./event-origin";

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
  origin
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
    const acceptedAt = new Date().toISOString();

    return db.transaction((): AcceptResult => {
      if (deps.source !== undefined) { normalized = authorizeSourceCapture(db, normalized, deps.source); contentHash = computeContentHash(normalized); }
      const textHash = sha256Hex(normalized.text);
      const origin = classifyEventOrigin(db, { event_id: eventId, text: normalized.text, text_hash: textHash, origin: "external" });
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
          canonicalSerialize(fromRow(duplicate)) !== canonicalSerialize(normalized))) throw new EventRecordError();
      if (duplicate === null) {
        using statement = db.prepare<EventRow, [string, string, string]>(`SELECT ${EVENT_COLUMNS} FROM events
          WHERE connector_id=? AND source_record_id=? AND content_hash=? AND content_hash_version=1 LIMIT 1`);
        const legacy = statement.get(normalized.connector_id, normalized.source_record_id, computeLegacyContentHash(normalized));
        if (legacy !== null && canonicalSerialize(fromRow(legacy)) === canonicalSerialize(normalized)) duplicate = legacy;
      }
      if (duplicate !== null) {
        if (deps.source !== undefined) bindSourceEvent(db, duplicate.event_id, deps.source, true);
        refreshEventOrigin(db, fromRow(duplicate));
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

      db.query<never, (string | number | null)[]>(
        `
          INSERT INTO events (
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
            origin
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        eventId,
        normalized.connector_id,
        normalized.source_record_id,
        normalized.kind,
        normalized.occurred_at,
        normalized.observed_at,
        normalized.text,
        JSON.stringify(normalized.subjects),
        normalized.sensitivity_hint ?? null,
        normalized.deleted ? 1 : 0,
        JSON.stringify(normalized.attachments),
        JSON.stringify(normalized.metadata),
        contentHash,
        acceptedAt,
        2,
        textHash,
        origin,
      );

      if (deps.source !== undefined) bindSourceEvent(db, eventId, deps.source);
      const stored = db
        .query<EventRow, [string]>(
          `SELECT ${EVENT_COLUMNS} FROM events WHERE event_id = ?`,
        )
        .get(eventId);
      if (stored === null) {
        throw new Error(`stored event ${eventId} could not be read back`);
      }
      return { status: "stored", event: fromRow(stored) };
    }).immediate();
  } catch (error) {
    return {
      status: "error",
      error: errorText(error),
      kind: isInfrastructureError(error) ? "infrastructure" : "validation",
    };
  }
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
  return row === null ? null : fromRow(row);
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
    events: rows.map(row => fromRow(row)),
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
    events: rows.map(row => fromRow(row)),
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
