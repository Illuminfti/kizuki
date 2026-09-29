import type { Database } from "bun:sqlite";

/**
 * A purged source record stays purged: sync must not quietly capture the same
 * record again. The refusal is derived from the purge history, keyed by the
 * source (connector) and its source record id, and holds until the owner lifts
 * it for that purge receipt. Source-authorization purges are excluded: the
 * owner re-grants a source through its own consent step.
 */
const SUPPRESSED = `
  FROM event_purge_proofs p
  JOIN event_purges e ON e.receipt_id = p.receipt_id
 WHERE NOT EXISTS (SELECT 1 FROM purge_suppression_lifts l WHERE l.receipt_id = e.receipt_id)
   AND NOT EXISTS (
     SELECT 1 FROM purge_batch_receipts m JOIN source_grants g ON g.purge_receipt_id = m.batch_id
      WHERE m.receipt_id = e.receipt_id)`;

export interface PurgeSuppression {
  connector_id: string;
  source_record_id: string;
  receipt_id: string;
  purged_at: string;
}

/** The purge receipt that suppresses this source record, or null. */
export function findPurgeSuppression(db: Database, connectorId: string, sourceRecordId: string): string | null {
  return (
    db
      .query<{ receipt_id: string }, [string, string]>(
        `SELECT e.receipt_id AS receipt_id ${SUPPRESSED}
            AND p.source_record_id = ? AND e.connector_id = ?
          ORDER BY e.receipt_id LIMIT 1`,
      )
      .get(sourceRecordId, connectorId)?.receipt_id ?? null
  );
}

export function listPurgeSuppressions(db: Database): PurgeSuppression[] {
  return db
    .query<PurgeSuppression, []>(
      `SELECT e.connector_id AS connector_id, p.source_record_id AS source_record_id,
              e.receipt_id AS receipt_id, e.purged_at AS purged_at ${SUPPRESSED}
        ORDER BY e.purged_at, e.receipt_id`,
    )
    .all();
}

/** Lift every suppression of the purge batch this receipt belongs to. Returns the lifted receipts. */
export function liftPurgeSuppressions(db: Database, receiptId: string, at: string): string[] {
  return db.transaction(() => {
    const receipts = db
      .query<{ receipt_id: string }, [string, string]>(
        `SELECT e.receipt_id AS receipt_id ${SUPPRESSED}
            AND e.receipt_id IN (
              SELECT m.receipt_id FROM purge_batch_receipts m
               WHERE m.batch_id = (SELECT batch_id FROM purge_batch_receipts WHERE receipt_id = ?)
                  OR m.batch_id = ?)
          ORDER BY e.receipt_id`,
      )
      .all(receiptId, receiptId)
      .map((row) => row.receipt_id);
    const lift = db.query("INSERT INTO purge_suppression_lifts (receipt_id, lifted_at) VALUES (?, ?)");
    for (const id of receipts) lift.run(id, at);
    return receipts;
  }).immediate();
}
