import type { Database } from "bun:sqlite";
import type {
  AttachmentRef,
  CaptureEvent,
  SensitivityHint,
  SubjectRef,
} from "@kizuki/core";

export interface Candidate {
  event: CaptureEvent;
  /** The ledger order key; the caller pages on it. */
  accepted_at: string;
}

export interface CandidateFilter {
  connector_id?: string;
  event_id?: string;
  since?: string;
}

export interface CandidateCursor {
  accepted_at: string;
  event_id: string;
}

export const CANDIDATE_PAGE = 500;

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

const COLUMNS = `
  e.event_id,
  e.connector_id,
  e.source_record_id,
  e.kind,
  e.occurred_at,
  e.observed_at,
  e.text,
  e.subjects,
  e.sensitivity_hint,
  e.deleted,
  e.attachments,
  e.metadata,
  e.content_hash,
  e.accepted_at
`;

function toCandidate(row: EventRow): Candidate {
  return {
    accepted_at: row.accepted_at,
    event: {
      schema: "kizuki.event/v1",
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
    },
  };
}

/**
 * One bounded page of events that may be sent, in ledger order. A record the
 * source later deleted is excluded by its tombstone even when the earlier,
 * undeleted row is still in the ledger: what the owner retracted upstream is
 * not sent anywhere.
 */
export function selectCandidates(
  db: Database,
  cursor: CandidateCursor | null,
  filter: CandidateFilter,
): Candidate[] {
  const conditions: string[] = [
    "e.deleted = 0",
    `NOT EXISTS (SELECT 1 FROM events t
                  WHERE t.connector_id = e.connector_id
                    AND t.source_record_id = e.source_record_id
                    AND t.deleted = 1)`,
  ];
  const bindings: string[] = [];
  if (filter.event_id !== undefined) {
    conditions.push("e.event_id = ?");
    bindings.push(filter.event_id);
  } else {
    if (filter.connector_id !== undefined) {
      conditions.push("e.connector_id = ?");
      bindings.push(filter.connector_id);
    }
    if (filter.since !== undefined) {
      conditions.push("e.occurred_at >= ?");
      bindings.push(filter.since);
    }
  }
  if (cursor !== null) {
    conditions.push(
      "(e.accepted_at > ? OR (e.accepted_at = ? AND e.event_id > ?))",
    );
    bindings.push(cursor.accepted_at, cursor.accepted_at, cursor.event_id);
  }

  return db
    .query<EventRow, string[]>(
      `SELECT ${COLUMNS} FROM events e
        WHERE ${conditions.join("\n          AND ")}
        ORDER BY e.accepted_at, e.event_id
        LIMIT ${CANDIDATE_PAGE}`,
    )
    .all(...bindings)
    .map(toCandidate);
}
