import { EVENT_SCHEMA, SENSITIVITY_HINTS } from "../contracts/event";
import type {
  AttachmentRef,
  CaptureEventInput,
  SensitivityHint,
  SubjectRef,
} from "../contracts/event";
import { validateEventInput } from "../contracts/event";
import { computeContentHash } from "../util/hash";
import { isRfc3339 } from "../util/time";
import { LedgerStoreError } from "./errors";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HASH = /^[0-9a-f]{64}$/;

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
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new LedgerStoreError("corrupt", `${label} is not valid JSON`);
  }
}

/** Doctor-only sample decoder. Live reads use eventFromRow. */
export function decodeEventRow(row: EventRow): void {
  if (typeof row.event_id !== "string" || !ULID.test(row.event_id)) {
    throw new LedgerStoreError("corrupt", "event_id is not a ULID");
  }
  if (row.deleted !== 0 && row.deleted !== 1) {
    throw new LedgerStoreError("corrupt", "deleted is not 0 or 1");
  }
  if (typeof row.content_hash !== "string" || !HASH.test(row.content_hash)) {
    throw new LedgerStoreError("corrupt", "content_hash is not a sha256 hex digest");
  }
  if (!isRfc3339(row.accepted_at)) {
    throw new LedgerStoreError("corrupt", "accepted_at is not RFC3339");
  }
  if (
    row.sensitivity_hint !== null &&
    !(SENSITIVITY_HINTS as readonly string[]).includes(row.sensitivity_hint)
  ) {
    throw new LedgerStoreError("corrupt", "sensitivity_hint is not a known label");
  }

  const input: CaptureEventInput = {
    schema: EVENT_SCHEMA,
    connector_id: row.connector_id,
    source_record_id: row.source_record_id,
    kind: row.kind,
    occurred_at: row.occurred_at,
    observed_at: row.observed_at,
    text: row.text,
    subjects: parseJson(row.subjects, "subjects") as SubjectRef[],
    ...(row.sensitivity_hint === null
      ? {}
      : { sensitivity_hint: row.sensitivity_hint as SensitivityHint }),
    deleted: row.deleted === 1,
    attachments: parseJson(row.attachments, "attachments") as AttachmentRef[],
    metadata: parseJson(row.metadata, "metadata") as Record<string, unknown>,
  };
  const validated = validateEventInput(input);
  if (!validated.ok) {
    throw new LedgerStoreError("corrupt", "event row failed contract validation");
  }
  const expected = computeContentHash(validated.value);
  if (expected !== row.content_hash) {
    throw new LedgerStoreError("corrupt", "content_hash does not match canonical bytes");
  }
}
