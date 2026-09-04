import type { Database } from "bun:sqlite";
import { EVENT_SCHEMA, validateEventInput } from "../contracts/event";
import type {
  AttachmentRef,
  CaptureEvent,
  CaptureEventInput,
  SensitivityHint,
  SubjectRef,
} from "../contracts/event";
import { computeContentHash } from "../util/hash";
import { ulid } from "../util/ulid";

export type AcceptErrorKind = "validation" | "infrastructure";

export type AcceptResult =
  | { status: "stored"; event: CaptureEvent }
  | { status: "duplicate" }
  | { status: "error"; error: string; kind: AcceptErrorKind };

export interface AcceptDependencies {
  generateId?: () => string;
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

interface EventRow {
  event_id: string;
  connector_id: string;
  source_record_id: string;
  kind: string;
  occurred_at: string;
  observed_at: string;
  text: string;
  subjects: string;
  sensitivity_hint: string | null;
  deleted: number;
  attachments: string;
  metadata: string;
  content_hash: string;
  accepted_at: string;
}

interface ExistingEventRow {
  event_id: string;
  content_hash: string;
}

type EventInsertBindings = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string | null,
  number,
  string,
  string,
  string,
  string,
];

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
  accepted_at
`;

function fromRow(row: EventRow): CaptureEvent {
  return {
    schema: EVENT_SCHEMA,
    event_id: row.event_id,
    connector_id: row.connector_id,
    source_record_id: row.source_record_id,
    kind: row.kind,
    occurred_at: row.occurred_at,
    observed_at: row.observed_at,
    text: row.text,
    subjects: JSON.parse(row.subjects) as SubjectRef[],
    ...(row.sensitivity_hint === null
      ? {}
      : { sensitivity_hint: row.sensitivity_hint as SensitivityHint }),
    deleted: row.deleted === 1,
    attachments: JSON.parse(row.attachments) as AttachmentRef[],
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    content_hash: row.content_hash,
  };
}

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
    const normalized = validation.value;
    const contentHash = computeContentHash(normalized);
    const eventId = (deps.generateId ?? ulid)();
    const acceptedAt = new Date().toISOString();

    return db.transaction((): AcceptResult => {
      const duplicate = db
        .query<ExistingEventRow, [string, string, string]>(
          `
            SELECT event_id, content_hash
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
      if (duplicate !== null) return { status: "duplicate" };

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

      db.query<never, EventInsertBindings>(
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
            accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );

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
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  const text = error instanceof Error ? error.message : String(error);
  return /SQLITE_(BUSY|LOCKED|CORRUPT|IOERR|FULL|CANTOPEN|READONLY|NOTADB|CONSTRAINT_FOREIGNKEY)/.test(
    `${code} ${text}`,
  );
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
    events: rows.map(fromRow),
    cursor:
      last === undefined
        ? null
        : { accepted_at: last.accepted_at, event_id: last.event_id },
  };
}

export function* replay(
  db: Database,
  filter: ReplayFilter,
): IterableIterator<CaptureEvent> {
  const conditions: string[] = [];
  const bindings: string[] = [];

  if (filter.connector_id !== undefined) {
    conditions.push("connector_id = ?");
    bindings.push(filter.connector_id);
  }
  if (filter.kind !== undefined) {
    conditions.push("kind = ?");
    bindings.push(filter.kind);
  }
  if (filter.since !== undefined) {
    conditions.push("occurred_at >= ?");
    bindings.push(filter.since);
  }

  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  const rows = db
    .query<EventRow, string[]>(
      `
        SELECT ${EVENT_COLUMNS}
        FROM events
        ${where}
        ORDER BY accepted_at, event_id
      `,
    )
    .all(...bindings);
  for (const row of rows) yield fromRow(row);
}

export function count(db: Database): number {
  return (
    db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
      ?.count ?? 0
  );
}
