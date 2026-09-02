import { isRfc3339 } from "../util/time";
import { isNonEmptyString, isPlainObject } from "../util/validate";
import type { ValidationResult } from "../util/validate";

export const EVENT_SCHEMA = "kizuki.event/v1" as const;

export const SUBJECT_ROLES = ["about", "from", "to"] as const;
export type SubjectRole = (typeof SUBJECT_ROLES)[number];

export const SENSITIVITY_HINTS = ["public", "personal", "private"] as const;
export type SensitivityHint = (typeof SENSITIVITY_HINTS)[number];

export function isSensitivityHint(value: unknown): value is SensitivityHint {
  return (
    typeof value === "string" &&
    (SENSITIVITY_HINTS as readonly string[]).includes(value)
  );
}

/**
 * The lattice `public < personal < private` (RFC 0002 §8.1). Sensitivity
 * resolves as a `max` over the floor, the default or model label and the
 * owner's, so every caller that combines two labels needs the same rule:
 * refinement only ever moves up.
 */
export function raiseSensitivity(
  left: SensitivityHint,
  right: SensitivityHint,
): SensitivityHint {
  return SENSITIVITY_HINTS.indexOf(left) >= SENSITIVITY_HINTS.indexOf(right)
    ? left
    : right;
}

export interface SubjectRef {
  subject_id: string; // stable id within the emitting connector's namespace
  role: SubjectRole;
  display_name?: string;
}

export interface AttachmentRef {
  attachment_id: string; // stable id within the source record
  media_type: string;
  filename?: string;
  byte_size?: number;
}

export interface CaptureEvent {
  schema: typeof EVENT_SCHEMA;
  event_id: string; // ULID, spine-generated
  connector_id: string;
  source_record_id: string; // stable id in the source system
  kind: string; // message | email | calendar_event | ...
  occurred_at: string; // RFC3339, validated at accept
  observed_at: string; // RFC3339, validated at accept
  text: string;
  subjects: SubjectRef[]; // who this is about/from/to
  sensitivity_hint?: SensitivityHint;
  deleted: boolean; // tombstone from source
  attachments: AttachmentRef[];
  metadata: Record<string, unknown>; // persisted verbatim
  content_hash: string; // sha256 of canonical serialization —
  // computed by the spine, never caller-supplied
}

/** What a connector hands to `accept`. The spine supplies event_id and content_hash. */
export type CaptureEventInput = Omit<CaptureEvent, "event_id" | "content_hash">;

function validateSubject(
  raw: unknown,
  path: string,
  errors: string[],
): SubjectRef | undefined {
  if (!isPlainObject(raw)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  let failed = false;
  if (!isNonEmptyString(raw["subject_id"])) {
    errors.push(`${path}.subject_id: must be a non-empty string`);
    failed = true;
  }
  const role = raw["role"];
  if (
    typeof role !== "string" ||
    !(SUBJECT_ROLES as readonly string[]).includes(role)
  ) {
    errors.push(`${path}.role: must be one of ${SUBJECT_ROLES.join(" | ")}`);
    failed = true;
  }
  const displayName = raw["display_name"];
  if (displayName !== undefined && typeof displayName !== "string") {
    errors.push(`${path}.display_name: must be a string when present`);
    failed = true;
  }
  if (failed) return undefined;
  return {
    subject_id: raw["subject_id"] as string,
    role: role as SubjectRole,
    ...(typeof displayName === "string" ? { display_name: displayName } : {}),
  };
}

function validateAttachment(
  raw: unknown,
  path: string,
  errors: string[],
): AttachmentRef | undefined {
  if (!isPlainObject(raw)) {
    errors.push(`${path}: must be an object`);
    return undefined;
  }
  let failed = false;
  if (!isNonEmptyString(raw["attachment_id"])) {
    errors.push(`${path}.attachment_id: must be a non-empty string`);
    failed = true;
  }
  if (!isNonEmptyString(raw["media_type"])) {
    errors.push(`${path}.media_type: must be a non-empty string`);
    failed = true;
  }
  const filename = raw["filename"];
  if (filename !== undefined && typeof filename !== "string") {
    errors.push(`${path}.filename: must be a string when present`);
    failed = true;
  }
  const byteSize = raw["byte_size"];
  if (
    byteSize !== undefined &&
    (typeof byteSize !== "number" ||
      !Number.isInteger(byteSize) ||
      byteSize < 0)
  ) {
    errors.push(
      `${path}.byte_size: must be a non-negative integer when present`,
    );
    failed = true;
  }
  if (failed) return undefined;
  return {
    attachment_id: raw["attachment_id"] as string,
    media_type: raw["media_type"] as string,
    ...(typeof filename === "string" ? { filename } : {}),
    ...(typeof byteSize === "number" ? { byte_size: byteSize } : {}),
  };
}

/**
 * Validates a connector-supplied event. Unknown top-level keys are dropped
 * rather than rejected: the returned value carries contract fields only, so a
 * connector cannot smuggle a caller-supplied `content_hash` past the spine.
 */
export function validateEventInput(
  input: unknown,
): ValidationResult<CaptureEventInput> {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ["event: must be a plain object"] };
  }

  if (input["schema"] !== EVENT_SCHEMA) {
    errors.push(`schema: must be "${EVENT_SCHEMA}"`);
  }
  if (!isNonEmptyString(input["connector_id"])) {
    errors.push("connector_id: must be a non-empty string");
  }
  if (!isNonEmptyString(input["source_record_id"])) {
    errors.push("source_record_id: must be a non-empty string");
  }
  if (!isNonEmptyString(input["kind"])) {
    errors.push("kind: must be a non-empty string");
  }
  if (!isRfc3339(input["occurred_at"])) {
    errors.push("occurred_at: must be an RFC3339 timestamp");
  }
  if (!isRfc3339(input["observed_at"])) {
    errors.push("observed_at: must be an RFC3339 timestamp");
  }
  if (typeof input["text"] !== "string") {
    errors.push("text: must be a string");
  }

  const subjects: SubjectRef[] = [];
  const rawSubjects = input["subjects"];
  if (!Array.isArray(rawSubjects)) {
    errors.push("subjects: must be an array");
  } else {
    rawSubjects.forEach((raw, i) => {
      const subject = validateSubject(raw, `subjects[${i}]`, errors);
      if (subject !== undefined) subjects.push(subject);
    });
  }

  const hint = input["sensitivity_hint"];
  if (
    hint !== undefined &&
    (typeof hint !== "string" ||
      !(SENSITIVITY_HINTS as readonly string[]).includes(hint))
  ) {
    errors.push(
      `sensitivity_hint: must be one of ${SENSITIVITY_HINTS.join(" | ")}`,
    );
  }

  if (typeof input["deleted"] !== "boolean") {
    errors.push("deleted: must be a boolean");
  }

  const attachments: AttachmentRef[] = [];
  const rawAttachments = input["attachments"];
  if (!Array.isArray(rawAttachments)) {
    errors.push("attachments: must be an array");
  } else {
    rawAttachments.forEach((raw, i) => {
      const attachment = validateAttachment(raw, `attachments[${i}]`, errors);
      if (attachment !== undefined) attachments.push(attachment);
    });
  }

  if (!isPlainObject(input["metadata"])) {
    errors.push("metadata: must be a plain object");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      schema: EVENT_SCHEMA,
      connector_id: input["connector_id"] as string,
      source_record_id: input["source_record_id"] as string,
      kind: input["kind"] as string,
      occurred_at: input["occurred_at"] as string,
      observed_at: input["observed_at"] as string,
      text: input["text"] as string,
      subjects,
      ...(hint !== undefined
        ? { sensitivity_hint: hint as SensitivityHint }
        : {}),
      deleted: input["deleted"] as boolean,
      attachments,
      metadata: input["metadata"] as Record<string, unknown>,
    },
  };
}
