import type { Database } from "bun:sqlite";
import type { CaptureEventInput } from "../contracts/event";
import { accept } from "../ledger/ledger";
import { OWNER_CONNECTOR_ID } from "./types";

/** Internal native correction recording. Connector labels never mint authority. */
export function recordNativeCorrection(
  db: Database,
  event: CaptureEventInput,
  requestDigest: string,
): { event_id: string; duplicate: boolean } {
  if (event.connector_id !== OWNER_CONNECTOR_ID || !/^[a-f0-9]{64}$/.test(requestDigest)) {
    throw new Error("invalid native correction recording");
  }
  return db.transaction(() => {
    const existing = db.query<{ event_id: string; request_digest: string | null }, [string, string]>(
      `SELECT e.event_id,n.request_digest FROM events e
       LEFT JOIN native_owner_evidence n ON n.event_id=e.event_id
       WHERE e.connector_id=? AND e.source_record_id=? ORDER BY e.accepted_at,e.event_id LIMIT 1`,
    ).get(OWNER_CONNECTOR_ID, event.source_record_id);
    if (existing !== null) {
      if (existing.request_digest !== requestDigest) throw new Error("correction recording conflicts with existing evidence");
      return { event_id: existing.event_id, duplicate: true };
    }
    const stored = accept(db, event);
    if (stored.status !== "stored") throw new Error("native correction recording failed");
    db.query("INSERT INTO native_owner_evidence VALUES (?, 'correction', ?, ?, 'recorded')")
      .run(stored.event.event_id, requestDigest, event.observed_at);
    return { event_id: stored.event.event_id, duplicate: false };
  }).immediate();
}
