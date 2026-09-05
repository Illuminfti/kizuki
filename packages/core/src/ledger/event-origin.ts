import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import { sha256Hex } from "../util/hash";
import { isRfc3339 } from "../util/time";
import { isUlid } from "../util/ulid";
import { eventFromRow, type EventRow } from "./event-record";

export const ABSENT_BYTE_HASH = sha256Hex("");
export interface MachineByteIntent {
  receipt_id: string;
  before_hash: string | null;
  after_hash: string;
}

export class EventOriginError extends Error {
  readonly code = "event_origin_unavailable";
  constructor() { super("event origin is unavailable"); }
}

export class SelfOriginError extends Error {
  readonly code = "self_origin_evidence";
  constructor() { super("model evidence has machine origin"); }
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** A connector label cannot create the internal native correction proof. */
function isNativeOwnerEvent(db: Database, eventId: string): boolean {
  using statement = db.prepare<{
    connector_id: string; origin: string; request_digest: string; recorded_at: string; filing_state: string;
    event_content_hash: string; content_hash: string; observed_at: string; source_bound: number;
  }, [string]>(`SELECT e.connector_id,n.origin,n.request_digest,n.recorded_at,n.filing_state,
      n.event_content_hash,e.content_hash,e.observed_at,
      EXISTS(SELECT 1 FROM source_event_bindings b WHERE b.event_id=n.event_id) AS source_bound
      FROM native_owner_evidence n LEFT JOIN events e ON e.event_id=n.event_id WHERE n.event_id=?`);
  const proof = statement.get(eventId);
  if (proof === null) return false;
  if (proof.connector_id !== "kizuki.owner" || proof.origin !== "correction" ||
      !hash(proof.request_digest) || !isRfc3339(proof.recorded_at) || proof.source_bound !== 0 ||
      proof.recorded_at !== proof.observed_at || !hash(proof.event_content_hash) ||
      proof.event_content_hash !== proof.content_hash ||
      !["recorded", "filed", "failed"].includes(proof.filing_state)) throw new EventOriginError();
  return true;
}

/** Caller supplies the transaction fence; missing/corrupt registry fails closed. */
export function classifyEventOrigin(db: Database,
  event: Pick<CaptureEvent, "event_id" | "text" | "text_hash" | "origin">,
): "external" | "self" {
  try { return classify(db, event); } catch { throw new EventOriginError(); }
}

function classify(db: Database, event: Pick<CaptureEvent, "event_id" | "text" | "text_hash" | "origin">): "external" | "self" {
  if (!hash(event.text_hash) || sha256Hex(event.text) !== event.text_hash ||
      (event.origin !== "external" && event.origin !== "self")) throw new EventOriginError();
  if (isNativeOwnerEvent(db, event.event_id)) return "external";
  using statement = db.prepare<{ before_hash: string | null; after_hash: string }, [string, string, string, string]>(`
    SELECT before_hash,after_hash FROM canon_receipts WHERE writer='loop' AND before_hash=?
    UNION ALL SELECT before_hash,after_hash FROM canon_receipts WHERE writer='loop' AND after_hash=?
    UNION ALL SELECT before_hash,after_hash FROM canon_machine_byte_intents WHERE before_hash=?
    UNION ALL SELECT before_hash,after_hash FROM canon_machine_byte_intents WHERE after_hash=? LIMIT 1
  `);
  const matching = statement.get(event.text_hash, event.text_hash, event.text_hash, event.text_hash);
  if (matching !== null && (!hash(matching.after_hash) ||
      (matching.before_hash !== null && !hash(matching.before_hash)))) throw new EventOriginError();
  return event.origin === "self" || event.text.includes("KIZUKI CONTEXT v1") ||
    (event.text_hash !== ABSENT_BYTE_HASH && matching !== null) ? "self" : "external";
}

/** Admission and the exact byte intent have one durable SQLite linearization. */
export function commitMachineByteIntent(db: Database, intent: MachineByteIntent, admit: () => void): void {
  if (db.inTransaction) throw new Error("loop byte admission requires a top-level transaction");
  if (!isUlid(intent.receipt_id) || !hash(intent.after_hash) ||
      (intent.before_hash !== null && !hash(intent.before_hash))) throw new EventOriginError();
  db.transaction(() => {
    admit();
    using select = db.prepare<MachineByteIntent, [string]>(
      "SELECT receipt_id,before_hash,after_hash FROM canon_machine_byte_intents WHERE receipt_id=?",
    );
    const prior = select.get(intent.receipt_id);
    using receipt = db.prepare("SELECT 1 FROM canon_receipts WHERE receipt_id=?");
    if (receipt.get(intent.receipt_id) !== null ||
        (prior !== null && (prior.before_hash !== intent.before_hash || prior.after_hash !== intent.after_hash))) {
      throw new Error("machine byte intent conflicts with existing evidence");
    }
    if (prior === null) {
      using insert = db.prepare("INSERT INTO canon_machine_byte_intents VALUES (?,?,?)");
      insert.run(intent.receipt_id, intent.before_hash, intent.after_hash);
    }
  }).immediate();
}

/** Only the annotation changes; accepted payload and revision hash are immutable. */
export function refreshEventOrigin(db: Database, event: CaptureEvent): CaptureEvent {
  const origin = classifyEventOrigin(db, event);
  if (origin === event.origin) return event;
  using update = db.prepare("UPDATE events SET origin=? WHERE event_id=?");
  update.run(origin, event.event_id);
  return { ...event, origin };
}

/** Used at the final model claim and public writer transaction boundaries. */
export function requireExternalEvents(db: Database, eventIds: readonly string[]): void {
  using statement = db.prepare<EventRow, [string]>("SELECT * FROM events WHERE event_id=?");
  for (const eventId of eventIds) {
    const row = statement.get(eventId);
    if (row === null) throw new EventOriginError();
    if (refreshEventOrigin(db, eventFromRow(row)).origin === "self") throw new SelfOriginError();
  }
}
