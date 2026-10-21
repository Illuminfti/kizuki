import type { Database } from "bun:sqlite";

/**
 * The independent witnesses behind a set of events. One source record is one
 * witness: a re-sync of it, whatever its bytes, is the same lineage. Events
 * bound to an enrolled source are keyed by that source, so equal record ids in
 * two sources stay independent; unbound events fall back to their connector.
 */
export function sourceRoots(db: Database, eventIds: readonly string[]): Set<string> {
  const roots = new Set<string>();
  const select = db.query<{ connector_id: string; source_record_id: string; source_key: string | null }, [string]>(
    `SELECT e.connector_id, e.source_record_id, b.source_key
       FROM events e LEFT JOIN source_event_bindings b ON b.event_id = e.event_id
      WHERE e.event_id = ?`,
  );
  for (const eventId of eventIds) {
    const row = select.get(eventId);
    if (row !== null) roots.add(JSON.stringify([row.source_key ?? row.connector_id, row.source_record_id]));
  }
  return roots;
}
