import type { Database } from "bun:sqlite";
import { EVENT_LIMITS, EVENT_SCHEMA, validateEventInput, type CaptureEvent } from "../contracts/event";
import { computeOriginBinding, nativeRequestDigest } from "./event-origin-binding";
import { isRfc3339 } from "../util/time";
import { computeContentHash, computeLegacyContentHash, sha256Hex } from "../util/hash";
import { isUlid } from "../util/ulid";
import { snapshotDataRecord, utf8ByteLength } from "../util/validate";

export class EventRecordError extends Error {
  readonly code = "event_record_invalid";
  constructor() { super("event record is invalid"); }
}

export type LegacyEventRecord = Omit<CaptureEvent, "origin_binding_version" | "origin_binding_kind" | "origin_binding">;

/** Shape/hash parsing for unpublished restore staging, not admission validation. */
export function parseEventRecord(raw: unknown, format: "legacy"): LegacyEventRecord;
export function parseEventRecord(raw: unknown, format: "current"): CaptureEvent;
export function parseEventRecord(raw: unknown, format: "legacy" | "current"): LegacyEventRecord | CaptureEvent;
export function parseEventRecord(raw: unknown, format: "legacy" | "current"): LegacyEventRecord | CaptureEvent {
  const errors: string[] = [];
  const data = snapshotDataRecord(raw, "event", errors, 21);
  if (data === undefined || errors.length > 0) throw new EventRecordError();
  const { event_id, content_hash, ...rest } = data;
  if (typeof event_id !== "string" || !isUlid(event_id) ||
      typeof content_hash !== "string" || !/^[a-f0-9]{64}$/.test(content_hash)) throw new EventRecordError();
  let input: Record<string, unknown> = rest;
  let version: 1 | 2 = 1;
  let origin: "external" | "self" = "external";
  if (format === "current") {
    const { content_hash_version, text_hash, origin: storedOrigin,
      origin_binding_version, origin_binding_kind, origin_binding, ...envelope } = rest;
    if ((content_hash_version !== 1 && content_hash_version !== 2) ||
        typeof text_hash !== "string" || !/^[a-f0-9]{64}$/.test(text_hash) ||
        (storedOrigin !== "external" && storedOrigin !== "self") || origin_binding_version !== 1 ||
        !["capture", "native", "legacy"].includes(origin_binding_kind as string) ||
        typeof origin_binding !== "string" || !/^[a-f0-9]{64}$/.test(origin_binding)) throw new EventRecordError();
    input = envelope;
    version = content_hash_version;
    origin = storedOrigin;
  }
  const checked = validateEventInput(input);
  if (!checked.ok) throw new EventRecordError();
  const expected = version === 1 ? computeLegacyContentHash(checked.value) : computeContentHash(checked.value);
  const textHash = sha256Hex(checked.value.text);
  if (content_hash !== expected || (format === "current" && rest["text_hash"] !== textHash)) throw new EventRecordError();
  const event: LegacyEventRecord = { ...checked.value, event_id, content_hash, content_hash_version: version, text_hash: textHash, origin };
  return format === "legacy" ? event : { ...event, origin_binding_version: 1,
    origin_binding_kind: rest["origin_binding_kind"] as CaptureEvent["origin_binding_kind"],
    origin_binding: rest["origin_binding"] as string };
}

export function validateEventRecord(raw: unknown, context: {
  accepted_at: string; native_request_digest: string | null;
}): CaptureEvent {
  const event = parseEventRecord(raw, "current");
  const proof = context.native_request_digest;
  if (!isRfc3339(context.accepted_at) || context.accepted_at.length > EVENT_LIMITS.timestampBytes ||
      (proof !== null && !/^[a-f0-9]{64}$/.test(proof)) ||
      (event.origin_binding_kind === "capture" && proof !== null) ||
      (event.origin_binding_kind === "native" && proof === null) ||
      (proof !== null && (event.origin !== "external" || event.connector_id !== "kizuki.owner")) ||
      event.origin_binding !== computeOriginBinding(event, context.accepted_at, event.origin_binding_kind, proof)) {
    throw new EventRecordError();
  }
  return event;
}

export interface EventRow {
  event_id: string;
  connector_id: string;
  source_record_id: string;
  kind: string;
  occurred_at: string;
  observed_at: string;
  text: string;
  subjects: string;
  sensitivity_hint: string | null;
  deleted: number;
  attachments: string;
  metadata: string;
  content_hash: string;
  accepted_at: string;
  content_hash_version: 1 | 2;
  text_hash: string;
  origin: "external" | "self";
  origin_binding_version: 1;
  origin_binding_kind: CaptureEvent["origin_binding_kind"];
  origin_binding: string;
}

function parseField(raw: string): unknown {
  if (typeof raw !== "string" || raw.length > EVENT_LIMITS.eventBytes ||
      utf8ByteLength(raw) > EVENT_LIMITS.eventBytes) throw new EventRecordError();
  try { return JSON.parse(raw); } catch { throw new EventRecordError(); }
}

/** Check serialized field bounds before parsing historical or duplicate rows. */
export function eventFromRow(row: EventRow, db: Database, format: "legacy"): LegacyEventRecord;
export function eventFromRow(row: EventRow, db: Database, format?: "current"): CaptureEvent;
export function eventFromRow(row: EventRow, db: Database, format: "legacy" | "current" = "current"): LegacyEventRecord | CaptureEvent {
  if ((row.deleted !== 0 && row.deleted !== 1) || !isRfc3339(row.accepted_at) || row.accepted_at.length > EVENT_LIMITS.timestampBytes) throw new EventRecordError();
  const raw = {
    schema: EVENT_SCHEMA, event_id: row.event_id, connector_id: row.connector_id,
    source_record_id: row.source_record_id, kind: row.kind,
    occurred_at: row.occurred_at, observed_at: row.observed_at, text: row.text,
    subjects: parseField(row.subjects),
    ...(row.sensitivity_hint === null ? {} : { sensitivity_hint: row.sensitivity_hint }),
    deleted: row.deleted === 1, attachments: parseField(row.attachments), metadata: parseField(row.metadata),
    content_hash: row.content_hash,
    ...(format === "legacy" ? {} : {
      content_hash_version: row.content_hash_version, text_hash: row.text_hash, origin: row.origin,
      origin_binding_version: row.origin_binding_version, origin_binding_kind: row.origin_binding_kind,
      origin_binding: row.origin_binding,
    }),
  };
  if (format === "legacy") return parseEventRecord(raw, "legacy");
  try {
    return validateEventRecord(raw, {
      accepted_at: row.accepted_at, native_request_digest: nativeRequestDigest(db, row.event_id),
    });
  } catch { throw new EventRecordError(); }
}
