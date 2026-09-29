import type { Database } from "bun:sqlite";
import type { RecordHistory } from "@kizuki/connectors";

/**
 * What the ledger says about a mirrored source's records, for the two
 * connectors that follow a tree the owner edits. Identifiers and counts only,
 * never event text.
 */

interface Stamp {
  readonly accepted_at: string;
  readonly event_id: string;
}

function after(left: Stamp, right: Stamp): boolean {
  return (
    left.accepted_at > right.accepted_at ||
    (left.accepted_at === right.accepted_at && left.event_id > right.event_id)
  );
}

/**
 * For each record a later event renamed, the latest such event. A record whose
 * own latest event is older than its rename has moved away: it is no longer
 * present in the mirror although nothing tombstoned it.
 */
export function movedAwayMarks(
  db: Database,
  connectorId: string,
  sourceKey: string,
): Map<string, Stamp> {
  const marks = new Map<string, Stamp>();
  const rows = db
    .query<{ origin: string; accepted_at: string; event_id: string }, [string, string]>(
      `SELECT json_extract(e.metadata, '$.moved_from') AS origin,
              e.accepted_at AS accepted_at, e.event_id AS event_id
         FROM events e JOIN source_event_bindings b ON b.event_id = e.event_id
        WHERE b.source_key = ? AND e.connector_id = ? AND e.deleted = 0
          AND json_type(e.metadata, '$.moved_from') = 'text'`,
    )
    .all(sourceKey, connectorId);
  for (const row of rows) {
    const known = marks.get(row.origin);
    if (known === undefined || after(row, known)) marks.set(row.origin, row);
  }
  return marks;
}

export function movedAway(
  marks: ReadonlyMap<string, Stamp>,
  relpath: string,
  latest: Stamp,
): boolean {
  const mark = marks.get(relpath);
  return mark !== undefined && after(mark, latest);
}

const CHUNK = 500;

/** Event counts and withdrawal state for the named records of one source. */
export function recordHistory(
  db: Database,
  connectorId: string,
  sourceKey: string,
  relpaths: readonly string[],
): Map<string, RecordHistory> {
  const history = new Map<string, RecordHistory>();
  const marks = movedAwayMarks(db, connectorId, sourceKey);
  for (let start = 0; start < relpaths.length; start += CHUNK) {
    const chunk = relpaths.slice(start, start + CHUNK);
    const rows = db
      .query<
        { rec: string; events: number; deleted: number; accepted_at: string; event_id: string },
        string[]
      >(
        `SELECT rec, events, deleted, accepted_at, event_id FROM (
           SELECT e.source_record_id AS rec, e.deleted AS deleted,
                  e.accepted_at AS accepted_at, e.event_id AS event_id,
                  count(*) OVER (PARTITION BY e.source_record_id) AS events,
                  ROW_NUMBER() OVER (
                    PARTITION BY e.source_record_id
                    ORDER BY e.accepted_at DESC, e.event_id DESC
                  ) AS rn
             FROM events e JOIN source_event_bindings b ON b.event_id = e.event_id
            WHERE b.source_key = ? AND e.connector_id = ?
              AND e.source_record_id IN (${chunk.map(() => "?").join(",")})
         ) WHERE rn = 1`,
      )
      .all(sourceKey, connectorId, ...chunk);
    for (const row of rows) {
      history.set(row.rec, {
        events: row.events,
        withdrawn: row.deleted === 1 || movedAway(marks, row.rec, row),
      });
    }
  }
  return history;
}
