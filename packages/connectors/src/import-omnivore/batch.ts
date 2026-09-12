import {
  MAX_SYNC_BATCH_BYTES,
  MAX_SYNC_BATCH_EVENTS,
  isPlainObject,
  type CaptureEventInput,
  type Cursor,
  type SyncBatch,
} from "@kizuki/core";
import { KizukiError } from "../errors";
import { sha256Hex } from "../source-id";
import { OMNIVORE_IMPORT_CONNECTOR_ID } from "./parse";

export const OMNIVORE_CURSOR_SCHEMA = "kizuki.import-omnivore.cursor/v1" as const;

export interface OmnivorePageLimits {
  maxEvents?: number;
  maxBytes?: number;
}

interface OmnivoreCursor {
  schema: typeof OMNIVORE_CURSOR_SCHEMA;
  connector_id: typeof OMNIVORE_IMPORT_CONNECTOR_ID;
  export_sha256: string;
  after: number;
}

function fingerprintOf(events: readonly CaptureEventInput[]): string {
  return sha256Hex(
    events
      .map((event) =>
        [
          event.source_record_id,
          event.occurred_at,
          event.text,
          JSON.stringify(event.metadata),
          event.attachments
            .map(
              (attachment) =>
                `${attachment.attachment_id}:${attachment.byte_size ?? 0}`,
            )
            .join(","),
        ].join("\n"),
      )
      .join("\n\n"),
  );
}

function encodeCursor(exportSha256: string, after: number): string {
  const cursor: OmnivoreCursor = {
    schema: OMNIVORE_CURSOR_SCHEMA,
    connector_id: OMNIVORE_IMPORT_CONNECTOR_ID,
    export_sha256: exportSha256,
    after,
  };
  return JSON.stringify(cursor);
}

function resumeAfter(cursor: Cursor | null, exportSha256: string): number {
  if (cursor === null) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor) as unknown;
  } catch (error) {
    throw new KizukiError(
      "parse_error",
      `${OMNIVORE_IMPORT_CONNECTOR_ID}: malformed resume cursor`,
      { cause: error },
    );
  }
  const after = isPlainObject(parsed) ? parsed["after"] : undefined;
  if (
    !isPlainObject(parsed) ||
    parsed["schema"] !== OMNIVORE_CURSOR_SCHEMA ||
    parsed["connector_id"] !== OMNIVORE_IMPORT_CONNECTOR_ID ||
    typeof parsed["export_sha256"] !== "string" ||
    typeof after !== "number" ||
    !Number.isSafeInteger(after) ||
    after < 0
  ) {
    throw new KizukiError(
      "parse_error",
      `${OMNIVORE_IMPORT_CONNECTOR_ID}: resume cursor does not match this source`,
    );
  }
  if (parsed["export_sha256"] !== exportSha256) return 0;
  return after;
}

/**
 * Host ingest refuses a batch above `MAX_SYNC_BATCH_EVENTS` / `_BYTES`.
 * A completed snapshot still returns `cursor: null` so a later re-import of
 * the same folder is duplicates, not a false "already synced" drain.
 */
export function pageOmnivoreEvents(
  events: readonly CaptureEventInput[],
  cursor: Cursor | null,
  limits: OmnivorePageLimits = {},
): SyncBatch {
  const maxEvents = limits.maxEvents ?? MAX_SYNC_BATCH_EVENTS;
  const maxBytes = limits.maxBytes ?? MAX_SYNC_BATCH_BYTES;
  const exportSha256 = fingerprintOf(events);
  const start = Math.min(resumeAfter(cursor, exportSha256), events.length);
  const page: CaptureEventInput[] = [];
  let bytes = 0;
  for (let index = start; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) break;
    if (page.length >= maxEvents) {
      return { events: page, cursor: encodeCursor(exportSha256, index) };
    }
    const piece = Buffer.byteLength(JSON.stringify(event), "utf8");
    const extra = page.length === 0 ? piece + 2 : piece + 1;
    if (page.length > 0 && bytes + extra > maxBytes) {
      return { events: page, cursor: encodeCursor(exportSha256, index) };
    }
    page.push(event);
    bytes += extra;
  }
  return { events: page, cursor: null };
}
