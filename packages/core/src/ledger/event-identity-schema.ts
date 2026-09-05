import type { Database } from "bun:sqlite";
import { EVENT_LIMITS } from "../contracts/event";
import { classifyNewEventOrigin } from "./event-origin";
import { EventRecordError, eventFromRow, type EventRow } from "./event-record";
import { computeOriginBinding, nativeRequestDigest } from "./event-origin-binding";
import { assertLegacyOriginsUnconsumed, LEGACY_ORIGIN_CANDIDATES, LEGACY_ORIGIN_MAX_CANDIDATES, LegacyOriginRebuildRequired } from "./legacy-origin-preflight";
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
    ALTER TABLE events ADD COLUMN origin_binding_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE events ADD COLUMN origin_binding_kind TEXT NOT NULL DEFAULT '';
    ALTER TABLE events ADD COLUMN origin_binding TEXT NOT NULL DEFAULT '';
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
  bindLegacyEventOrigins(db);
  installEventIdentityGuards(db);
}

/** The only compatibility route; callers own an unpublished immediate transaction. */
export function bindLegacyEventOrigins(db: Database): void {
  if (!db.inTransaction) throw new EventRecordError();
  db.exec(`CREATE TABLE ${LEGACY_ORIGIN_CANDIDATES} (
    event_id TEXT PRIMARY KEY, accepted_at TEXT NOT NULL) WITHOUT ROWID`);
  try {
    using page = db.prepare<EventRow, [string]>("SELECT * FROM events WHERE event_id>? ORDER BY event_id LIMIT 32");
    using update = db.prepare(`UPDATE events SET content_hash_version=1,text_hash=?,origin=?,
      origin_binding_version=1,origin_binding_kind='legacy',origin_binding=? WHERE event_id=?`);
    using candidate = db.prepare(`INSERT INTO ${LEGACY_ORIGIN_CANDIDATES}(event_id,accepted_at) VALUES (?,?)`);
    let after = "";
    let candidates = 0;
    for (;;) {
      const rows = page.all(after);
      if (rows.length === 0) break;
      for (const row of rows) {
        const event = eventFromRow(row, db, "legacy");
        const nativeDigest = nativeRequestDigest(db, event.event_id);
        const origin = nativeDigest === null ? classifyNewEventOrigin(db, event) : "external";
        if (origin === "self" && !event.text.includes("KIZUKI CONTEXT v1")) {
          if (++candidates > LEGACY_ORIGIN_MAX_CANDIDATES) throw new LegacyOriginRebuildRequired();
          candidate.run(event.event_id, row.accepted_at);
        }
        update.run(event.text_hash, origin, computeOriginBinding({ ...event, origin }, row.accepted_at, "legacy", nativeDigest), event.event_id);
        after = event.event_id;
      }
    }
    if (candidates > 0) assertLegacyOriginsUnconsumed(db);
  } finally {
    db.exec(`DROP TABLE ${LEGACY_ORIGIN_CANDIDATES}`);
  }
}

export function installEventIdentityGuards(db: Database): void {
  const invalid = `typeof(NEW.content_hash_version)!='integer' OR NEW.content_hash_version NOT IN (1,2)
    OR NOT ${HASH_CHECK("NEW.text_hash")} OR NEW.origin NOT IN ('external','self')
    OR typeof(NEW.origin_binding_version)!='integer' OR NEW.origin_binding_version!=1
    OR NEW.origin_binding_kind NOT IN ('capture','native','legacy') OR NOT ${HASH_CHECK("NEW.origin_binding")}`;
  db.exec(`
    CREATE TRIGGER events_identity_insert BEFORE INSERT ON events WHEN ${invalid}
      BEGIN SELECT RAISE(ABORT,'event identity fields are required'); END;
    CREATE TRIGGER events_identity_update BEFORE UPDATE ON events WHEN
      NEW.origin IS NOT OLD.origin OR NEW.origin_binding_version IS NOT OLD.origin_binding_version
      OR NEW.origin_binding_kind IS NOT OLD.origin_binding_kind OR NEW.origin_binding IS NOT OLD.origin_binding
      OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.event_id IS NOT OLD.event_id
      OR NEW.content_hash IS NOT OLD.content_hash OR NEW.content_hash_version IS NOT OLD.content_hash_version
      OR NEW.text_hash IS NOT OLD.text_hash
      BEGIN SELECT RAISE(ABORT,'event origin binding is immutable'); END;
    CREATE TRIGGER native_owner_hash_insert BEFORE INSERT ON native_owner_evidence WHEN NOT ${HASH_CHECK("NEW.event_content_hash")}
      BEGIN SELECT RAISE(ABORT,'native owner event hash is required'); END;
    CREATE TRIGGER native_owner_hash_update BEFORE UPDATE ON native_owner_evidence WHEN
      NEW.event_id IS NOT OLD.event_id OR NEW.origin IS NOT OLD.origin OR NEW.request_digest IS NOT OLD.request_digest
      OR NEW.recorded_at IS NOT OLD.recorded_at OR NEW.event_content_hash IS NOT OLD.event_content_hash
      BEGIN SELECT RAISE(ABORT,'native owner proof is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS canon_loop_hash_insert BEFORE INSERT ON canon_receipts WHEN NEW.writer='loop' AND (
      NOT ${HASH_CHECK("NEW.after_hash")} OR (NEW.before_hash IS NOT NULL AND NOT ${HASH_CHECK("NEW.before_hash")}))
      BEGIN SELECT RAISE(ABORT,'machine byte registry is invalid'); END;
    CREATE TRIGGER IF NOT EXISTS canon_loop_hash_update BEFORE UPDATE OF writer,before_hash,after_hash ON canon_receipts WHEN NEW.writer='loop' AND (
      NOT ${HASH_CHECK("NEW.after_hash")} OR (NEW.before_hash IS NOT NULL AND NOT ${HASH_CHECK("NEW.before_hash")}))
      BEGIN SELECT RAISE(ABORT,'machine byte registry is invalid'); END;
  `);
}
