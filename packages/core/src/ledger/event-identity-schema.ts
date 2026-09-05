import type { Database } from "bun:sqlite";
import { EVENT_LIMITS } from "../contracts/event";
import { classifyEventOrigin } from "./event-origin";
import { EventRecordError, eventFromRow, type EventRow } from "./event-record";
import { isRfc3339 } from "../util/time";

const HASH_CHECK = (column: string): string =>
  `(typeof(${column})='text' AND length(${column})=64 AND ${column} NOT GLOB '*[^0123456789abcdef]*')`;

/** Called only inside the ledger's all-or-nothing immediate migration. */
export function applyEventIdentityV16(db: Database): void {
  // Check serialized sizes without materializing unbounded historical values.
  const sizes: readonly [string, number][] = [
    ["event_id", 26], ["connector_id", EVENT_LIMITS.identifierBytes],
    ["source_record_id", EVENT_LIMITS.sourceRecordIdBytes], ["kind", EVENT_LIMITS.identifierBytes],
    ["occurred_at", EVENT_LIMITS.timestampBytes], ["observed_at", EVENT_LIMITS.timestampBytes],
    ["text", EVENT_LIMITS.textBytes], ["subjects", EVENT_LIMITS.eventBytes],
    ["attachments", EVENT_LIMITS.eventBytes], ["metadata", EVENT_LIMITS.eventBytes],
    ["content_hash", 64], ["accepted_at", EVENT_LIMITS.timestampBytes],
  ];
  const overBound = sizes.map(([column, bound]) =>
    `(typeof(${column})!='text' OR length(CAST(${column} AS BLOB))>${bound})`).join(" OR ");
  using bounded = db.prepare(`SELECT 1 FROM events WHERE ${overBound}
    OR typeof(deleted)!='integer' OR deleted NOT IN (0,1)
    OR (sensitivity_hint IS NOT NULL AND (typeof(sensitivity_hint)!='text'
      OR length(CAST(sensitivity_hint AS BLOB))>8
      OR sensitivity_hint NOT IN ('public','personal','private'))) LIMIT 1`);
  if (bounded.get() !== null) throw new EventRecordError();
  const badLoopHash = `NOT ${HASH_CHECK("after_hash")} OR (before_hash IS NOT NULL AND NOT ${HASH_CHECK("before_hash")})`;
  using loopHashes = db.prepare(`SELECT 1 FROM canon_receipts WHERE writer='loop' AND (${badLoopHash}) LIMIT 1`);
  if (loopHashes.get() !== null) {
    throw new Error("machine byte registry is invalid");
  }
  // Preexisting proofs are trusted legacy records, but their referents and
  // bounded fields must be valid before attaching the immutable event hash.
  using nativeBounds = db.prepare(`SELECT 1 FROM native_owner_evidence n LEFT JOIN events e ON e.event_id=n.event_id
    WHERE e.event_id IS NULL OR e.connector_id!='kizuki.owner' OR n.origin!='correction'
      OR NOT ${HASH_CHECK("n.request_digest")}
      OR typeof(n.recorded_at)!='text' OR length(CAST(n.recorded_at AS BLOB))>${EVENT_LIMITS.timestampBytes}
      OR n.recorded_at!=e.observed_at OR n.filing_state NOT IN ('recorded','filed','failed')
      OR EXISTS(SELECT 1 FROM source_event_bindings b WHERE b.event_id=n.event_id) LIMIT 1`);
  if (nativeBounds.get() !== null) throw new EventRecordError();
  using nativeDates = db.prepare<{ recorded_at: string }, []>("SELECT recorded_at FROM native_owner_evidence");
  for (const row of nativeDates.iterate()) if (!isRfc3339(row.recorded_at)) throw new EventRecordError();
  db.exec(`
    ALTER TABLE events ADD COLUMN content_hash_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE events ADD COLUMN text_hash TEXT NOT NULL DEFAULT '';
    ALTER TABLE events ADD COLUMN origin TEXT NOT NULL DEFAULT 'external' CHECK(origin IN ('external','self'));
    ALTER TABLE native_owner_evidence ADD COLUMN event_content_hash TEXT NOT NULL DEFAULT '';
    UPDATE native_owner_evidence SET event_content_hash=(SELECT content_hash FROM events WHERE event_id=native_owner_evidence.event_id);
    CREATE INDEX canon_loop_before_hash ON canon_receipts(before_hash) WHERE writer='loop';
    CREATE INDEX canon_loop_after_hash ON canon_receipts(after_hash) WHERE writer='loop';
    CREATE TABLE canon_machine_byte_intents (
      receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id)=26 AND receipt_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'),
      before_hash TEXT CHECK(before_hash IS NULL OR ${HASH_CHECK("before_hash")}),
      after_hash TEXT NOT NULL CHECK(${HASH_CHECK("after_hash")})
    ) STRICT;
    CREATE INDEX canon_machine_before_hash ON canon_machine_byte_intents(before_hash);
    CREATE INDEX canon_machine_after_hash ON canon_machine_byte_intents(after_hash);
  `);
  using page = db.prepare<EventRow, [string]>("SELECT * FROM events WHERE event_id>? ORDER BY event_id LIMIT 32");
  using update = db.prepare("UPDATE events SET content_hash_version=1,text_hash=?,origin=? WHERE event_id=?");
  let after = "";
  for (;;) {
    const rows = page.all(after);
    if (rows.length === 0) break;
    for (const row of rows) {
      const event = eventFromRow(row, "legacy");
      const origin = classifyEventOrigin(db, event);
      update.run(event.text_hash, origin, event.event_id);
      after = event.event_id;
    }
  }
  const invalid = `typeof(NEW.content_hash_version)!='integer' OR NEW.content_hash_version NOT IN (1,2)
    OR NOT ${HASH_CHECK("NEW.text_hash")} OR NEW.origin NOT IN ('external','self')`;
  db.exec(`
    CREATE TRIGGER events_identity_insert BEFORE INSERT ON events WHEN ${invalid}
      BEGIN SELECT RAISE(ABORT,'event identity fields are required'); END;
    CREATE TRIGGER events_identity_update BEFORE UPDATE OF content_hash_version,text_hash,origin ON events WHEN ${invalid}
      OR (OLD.origin='self' AND NEW.origin='external' AND NOT EXISTS (
        SELECT 1 FROM native_owner_evidence n WHERE n.event_id=OLD.event_id AND n.origin='correction'
        AND NEW.connector_id='kizuki.owner' AND n.event_content_hash=NEW.content_hash
        AND n.recorded_at=NEW.observed_at
        AND NOT EXISTS(SELECT 1 FROM source_event_bindings b WHERE b.event_id=OLD.event_id)))
      BEGIN SELECT RAISE(ABORT,'event identity annotation is invalid'); END;
    CREATE TRIGGER native_owner_hash_insert BEFORE INSERT ON native_owner_evidence WHEN NOT ${HASH_CHECK("NEW.event_content_hash")}
      BEGIN SELECT RAISE(ABORT,'native owner event hash is required'); END;
    CREATE TRIGGER native_owner_hash_update BEFORE UPDATE OF event_content_hash ON native_owner_evidence WHEN NOT ${HASH_CHECK("NEW.event_content_hash")}
      BEGIN SELECT RAISE(ABORT,'native owner event hash is invalid'); END;
    CREATE TRIGGER canon_loop_hash_insert BEFORE INSERT ON canon_receipts WHEN NEW.writer='loop' AND (
      NOT ${HASH_CHECK("NEW.after_hash")} OR (NEW.before_hash IS NOT NULL AND NOT ${HASH_CHECK("NEW.before_hash")}))
      BEGIN SELECT RAISE(ABORT,'machine byte registry is invalid'); END;
    CREATE TRIGGER canon_loop_hash_update BEFORE UPDATE OF writer,before_hash,after_hash ON canon_receipts WHEN NEW.writer='loop' AND (
      NOT ${HASH_CHECK("NEW.after_hash")} OR (NEW.before_hash IS NOT NULL AND NOT ${HASH_CHECK("NEW.before_hash")}))
      BEGIN SELECT RAISE(ABORT,'machine byte registry is invalid'); END;
  `);
}
