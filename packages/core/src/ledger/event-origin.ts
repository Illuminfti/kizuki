import type { Database } from "bun:sqlite";
import type { CaptureEvent } from "../contracts/event";
import { sha256Hex } from "../util/hash";
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
  constructor() { super("evidence has machine origin"); }
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Only new admission reads the registry, under SQLite's write order. */
export function classifyNewEventOrigin(db: Database,
  event: Pick<CaptureEvent, "text" | "text_hash">,
): "external" | "self" {
  if (!db.inTransaction) throw new EventOriginError();
  try { return classify(db, event); } catch { throw new EventOriginError(); }
}

function classify(db: Database, event: Pick<CaptureEvent, "text" | "text_hash">): "external" | "self" {
  if (!hash(event.text_hash) || sha256Hex(event.text) !== event.text_hash) throw new EventOriginError();
  using statement = db.prepare<{ before_hash: string | null; after_hash: string }, [string, string, string, string]>(`
    SELECT before_hash,after_hash FROM canon_receipts WHERE writer='loop' AND before_hash=?
    UNION ALL SELECT before_hash,after_hash FROM canon_receipts WHERE writer='loop' AND after_hash=?
    UNION ALL SELECT before_hash,after_hash FROM canon_machine_byte_intents WHERE before_hash=?
    UNION ALL SELECT before_hash,after_hash FROM canon_machine_byte_intents WHERE after_hash=? LIMIT 1
  `);
  const matching = statement.get(event.text_hash, event.text_hash, event.text_hash, event.text_hash);
  if (matching !== null && (!hash(matching.after_hash) ||
      (matching.before_hash !== null && !hash(matching.before_hash)))) throw new EventOriginError();
  return event.text.includes("KIZUKI CONTEXT v1") ||
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

/** Validate the immutable admission stamp; later intents cannot restamp evidence. */
export function validateEventOrigin(db: Database, event: CaptureEvent): CaptureEvent {
  using select = db.prepare<EventRow, [string]>("SELECT * FROM events WHERE event_id=?");
  const row = select.get(event.event_id);
  if (row === null) throw new EventOriginError();
  const stored = eventFromRow(row, db);
  if (event.content_hash !== stored.content_hash || event.content_hash_version !== stored.content_hash_version ||
      event.text_hash !== stored.text_hash || event.origin !== stored.origin ||
      event.origin_binding_version !== stored.origin_binding_version || event.origin_binding_kind !== stored.origin_binding_kind ||
      event.origin_binding !== stored.origin_binding) throw new EventOriginError();
  return stored;
}

/** Used at authoritative claim and positive canon-write boundaries. */
export function requireExternalEvents(db: Database, eventIds: readonly string[]): void {
  using statement = db.prepare<EventRow, [string]>("SELECT * FROM events WHERE event_id=?");
  for (const eventId of eventIds) {
    const row = statement.get(eventId);
    if (row === null) throw new EventOriginError();
    if (eventFromRow(row, db).origin === "self") throw new SelfOriginError();
  }
}
