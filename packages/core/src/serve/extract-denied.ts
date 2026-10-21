import type { Database } from "bun:sqlite";
import type { LedgerCursor } from "../ledger/ledger";
import { inspectSourceGrant, sourceExtractionDenied, sourcePortBindingDigest, type SourceGrant } from "../ledger/source-grants";
import type { ExtractionProducerPort } from "./extract-v2";
import type { DeferredInput } from "./extract";
import { isUlid } from "../util/ulid";
import { isRfc3339 } from "../util/time";

/** Metadata only; model requests and their durable manifests keep EXTRACT_BATCH. */
export const DENIED_FRONTIER_LIMIT = 1_024;
export type DeniedFrontierProof = { readonly producer: ExtractionProducerPort; readonly binding_digest: string };
export type SourceLookup = (sourceKey: string) => SourceGrant | null;
export function extractionSourceLookup(db: Database): SourceLookup {
  const grants = new Map<string,SourceGrant|null>();
  return key => {
    if (!grants.has(key)) grants.set(key,inspectSourceGrant(db,key));
    return grants.get(key)!;
  };
}

/** Never inspect denied captured bytes to decide how much local work to do. */
export function deniedFrontier(
  db: Database, after: LedgerCursor | null, producer: ExtractionProducerPort,
  grantOf: SourceLookup = extractionSourceLookup(db), limit = DENIED_FRONTIER_LIMIT,
): { cursor: LedgerCursor; inputs: DeferredInput[] } | null {
  if (!Number.isInteger(limit) || limit < 1 || limit > DENIED_FRONTIER_LIMIT) throw new Error("invalid denied frontier bound");
  const rows = db.query<{event_id:string;accepted_at:string;source_key:string|null},(string|number)[]>(`
    SELECT events.event_id,events.accepted_at,b.source_key FROM events
    LEFT JOIN source_event_bindings b ON b.event_id=events.event_id
    ${after === null ? "" : "WHERE events.accepted_at>? OR (events.accepted_at=? AND events.event_id>?)"}
    ORDER BY events.accepted_at,events.event_id LIMIT ?`).all(...(after === null ? [] : [after.accepted_at,after.accepted_at,after.event_id]),limit);
  const inputs: DeferredInput[] = [];
  const digest = sourcePortBindingDigest(producer);
  let cursor: LedgerCursor | null = null;
  for (const row of rows) {
    // An absent/unrecognized binding takes the ordinary validating path.
    if (!isUlid(row.event_id) || !isRfc3339(row.accepted_at) || row.source_key === null || !isUlid(row.source_key)) break;
    const grant = grantOf(row.source_key);
    if (grant === null || !sourceExtractionDenied(grant,producer)) break;
    inputs.push({event_id:row.event_id,source_key:row.source_key,checked_revision:grant.revision,checked_binding_digest:digest});
    cursor = {event_id:row.event_id,accepted_at:row.accepted_at};
  }
  return cursor === null ? null : {cursor,inputs};
}

/** Only metadata-proven denials bypass body validation; every event remains queued. */
export function queueDeniedFrontier(db: Database, inputs: readonly DeferredInput[]): void {
  if (!db.inTransaction) throw new Error("denied frontier requires its checkpoint transaction");
  const insert = db.query(`INSERT OR IGNORE INTO extract_deferred_inputs
    (event_id,source_key,checked_revision,checked_binding_digest) VALUES (?,?,?,?)`);
  for (const input of inputs) insert.run(input.event_id,input.source_key,input.checked_revision,input.checked_binding_digest);
}
