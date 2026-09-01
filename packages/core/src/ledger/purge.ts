import type { Database } from "bun:sqlite";
import { ulid } from "../util/ulid";

export interface PurgeReceipt {
  receipt_id: string;
  event_id: string;
  connector_id: string;
  reason: string;
  purged_at: string;
}

export type PurgeFilter =
  | { event_id?: string }
  | { connector_id?: string }
  | { subject_handle?: string };

interface PurgeCandidate {
  event_id: string;
  connector_id: string;
}

function selector(filter: PurgeFilter): { where: string; bindings: string[] } {
  const conditions: string[] = [];
  const bindings: string[] = [];

  if ("event_id" in filter && filter.event_id !== undefined) {
    conditions.push("events.event_id = ?");
    bindings.push(filter.event_id);
  }
  if ("connector_id" in filter && filter.connector_id !== undefined) {
    conditions.push("events.connector_id = ?");
    bindings.push(filter.connector_id);
  }
  if ("subject_handle" in filter && filter.subject_handle !== undefined) {
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM json_each(events.subjects) AS subject
        WHERE json_extract(subject.value, '$.subject_id') = ?
      )
    `);
    bindings.push(filter.subject_handle);
  }

  if (conditions.length === 0) {
    throw new Error("purgeEvents requires a non-empty filter");
  }
  return { where: conditions.join(" AND "), bindings };
}

export function purgeEvents(
  db: Database,
  filter: PurgeFilter,
  reason: string,
): PurgeReceipt[] {
  const { where, bindings } = selector(filter);

  return db.transaction(() => {
    const candidates = db
      .query<PurgeCandidate, string[]>(
        `
          SELECT events.event_id, events.connector_id
          FROM events
          WHERE ${where}
          ORDER BY events.accepted_at, events.event_id
        `,
      )
      .all(...bindings);
    if (candidates.length === 0) return [];

    const insertReceipt = db.query<
      never,
      [string, string, string, string, string]
    >(
      `
        INSERT INTO event_purges (
          receipt_id,
          event_id,
          connector_id,
          reason,
          purged_at
        ) VALUES (?, ?, ?, ?, ?)
      `,
    );
    const deleteEvent = db.query<never, [string]>(
      "DELETE FROM events WHERE event_id = ?",
    );
    const purgedAt = new Date().toISOString();
    const receipts: PurgeReceipt[] = [];

    for (const candidate of candidates) {
      const receipt: PurgeReceipt = {
        receipt_id: ulid(),
        event_id: candidate.event_id,
        connector_id: candidate.connector_id,
        reason,
        purged_at: purgedAt,
      };
      insertReceipt.run(
        receipt.receipt_id,
        receipt.event_id,
        receipt.connector_id,
        receipt.reason,
        receipt.purged_at,
      );
      deleteEvent.run(candidate.event_id);
      receipts.push(receipt);
    }
    return receipts;
  }).immediate();
}
