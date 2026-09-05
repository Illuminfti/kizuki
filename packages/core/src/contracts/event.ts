import { isRfc3339 } from "../util/time";
import {
  cloneExactJson,
  isPlainObject,
  snapshotDataArray,
  snapshotDataRecord,
  utf8ByteLength,
} from "../util/validate";
import type { ValidationResult } from "../util/validate";

export const EVENT_SCHEMA = "kizuki.event/v1" as const;

export const EVENT_LIMITS = Object.freeze({
  identifierBytes: 256,
  // Omnivore permits a 1 MiB native id. Snapshot importers retain duplicate
  // identities by appending up to "#1000000" within their record bound.
  sourceRecordIdBytes: 1_048_584,
  subjectIdBytes: 1_024,
  attachmentIdBytes: 2_048,
  displayNameBytes: 512,
  filenameBytes: 1024,
  mediaTypeBytes: 256,
  timestampBytes: 64,
  textBytes: 1_048_576,
  subjectCount: 256,
  attachmentCount: 256,
  metadataDepth: 16,
  metadataKeysPerObject: 256,
  metadataArrayLength: 1024,
  metadataStringBytes: 65_536,
  metadataKeyBytes: 256,
  metadataBytes: 1_048_576,
  eventBytes: 2_097_152,
  attachmentByteSizeMax: Number.MAX_SAFE_INTEGER,
} as const);

const EVENT_INPUT_KEYS = [
  "schema",
  "connector_id",
  "source_record_id",
  "kind",
  "occurred_at",
  "observed_at",
  "text",
  "subjects",
  "sensitivity_hint",
  "deleted",
  "attachments",
  "metadata",
] as const;

const SUBJECT_KEYS = ["subject_id", "role", "display_name"] as const;
const ATTACHMENT_KEYS = [
  "attachment_id",
  "media_type",
  "filename",
  "byte_size",
] as const;

export const SUBJECT_ROLES = ["about", "from", "to"] as const;
export type SubjectRole = (typeof SUBJECT_ROLES)[number];

export const SENSITIVITY_HINTS = ["public", "personal", "private"] as const;
export type SensitivityHint = (typeof SENSITIVITY_HINTS)[number];

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
  source_record_id: string;
  kind: string; // message | email | calendar_event | ...
  occurred_at: string; // RFC3339, validated at accept
  observed_at: string; // RFC3339, validated at accept
  text: string;
  subjects: SubjectRef[]; // who this is about/from/to
  sensitivity_hint?: SensitivityHint;
  deleted: boolean; // tombstone from source
  attachments: AttachmentRef[];
  metadata: Record<string, unknown>; // persisted verbatim exact JSON
  content_hash: string; // sha256 of canonical serialization —
  // computed by the spine, never caller-supplied
}

/** What a connector hands to `accept`. The spine supplies event_id and content_hash. */
export type CaptureEventInput = Omit<CaptureEvent, "event_id" | "content_hash">;

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
  errors: string[],
): void {
  const allow = new Set<string>(allowed);
  if (Object.keys(raw).some((key) => !allow.has(key))) {
    errors.push(`${path}: contains unknown keys`);
  }
}

const identifierSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const MARK = /\p{M}/u;
const FORMAT = /\p{Cf}/u;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const WHITE_SPACE = /\p{White_Space}/u;

/**
 * Identifiers keep their opaque source spelling. This only decides whether
 * that spelling has visible grapheme content that is safe to display and use
 * as an identity; it never normalizes or replaces source bytes.
 */
function isVisibleIdentifier(value: string): boolean {
  if (value.trim() !== value || CONTROL_OR_LINE_SEPARATOR.test(value)) return false;
  // CGJ is a default-ignorable mark whose source spelling is visually
  // indistinguishable in identifiers, including when adjacent to visible text.
  if (value.includes("\u034f")) return false;
  // A cluster is usable when it contains visible source content. This admits
  // native emoji selectors, joins and tag sequences without rewriting them.
  return [...identifierSegmenter.segment(value)].every(({ segment }) => {
    const chars = [...segment];
    // Ordinary internal whitespace is valid in opaque source names; trimming
    // above still excludes it at either edge and as the entire identifier.
    if (chars.every((ch) => WHITE_SPACE.test(ch))) return true;
    return chars.some((ch) =>
      !MARK.test(ch) && !FORMAT.test(ch) && !DEFAULT_IGNORABLE.test(ch) && !WHITE_SPACE.test(ch),
    );
  });
}

function checkString(
  value: unknown,
  path: string,
  errors: string[],
  maxBytes: number,
  opts: { required: boolean; allowEmpty: boolean; identifier?: boolean },
): value is string {
  if (value === undefined) {
    if (opts.required) {
      errors.push(
        opts.allowEmpty ? `${path}: must be a string` : `${path}: must be a non-empty string`,
      );
    }
    return false;
  }
  if (typeof value !== "string") {
    errors.push(
      opts.allowEmpty
        ? `${path}: must be a string${opts.required ? "" : " when present"}`
        : `${path}: must be a non-empty string`,
    );
    return false;
  }
  if (!opts.allowEmpty && value.length === 0) {
    errors.push(`${path}: must be a non-empty string`);
    return false;
  }
  // UTF-8 is never shorter than the UTF-16 source string. Reject obvious
  // overages before identifier grapheme validation allocates per code point.
  if (value.length > maxBytes) {
    errors.push(`${path}: exceeds ${maxBytes} UTF-8 bytes`);
    return false;
  }
  if (utf8ByteLength(value) > maxBytes) {
    errors.push(`${path}: exceeds ${maxBytes} UTF-8 bytes`);
    return false;
  }
  if ((opts.identifier ?? !opts.allowEmpty) && value.length > 0 && !isVisibleIdentifier(value)) {
    errors.push(`${path}: must be a visible identifier without controls or edge whitespace`);
    return false;
  }
  return true;
}

function checkTimestamp(
  value: unknown,
  path: string,
  errors: string[],
): value is string {
  if (typeof value !== "string") {
    errors.push(`${path}: must be an RFC3339 timestamp`);
    return false;
  }
  if (utf8ByteLength(value) > EVENT_LIMITS.timestampBytes) {
    errors.push(`${path}: exceeds ${EVENT_LIMITS.timestampBytes} UTF-8 bytes`);
    return false;
  }
  if (!isRfc3339(value)) {
    errors.push(`${path}: must be an RFC3339 timestamp`);
    return false;
  }
  return true;
}

function freezeRecord<T extends object>(value: T): T {
  return Object.freeze(value);
}

function validateSubject(
  raw: unknown,
  path: string,
  errors: string[],
): SubjectRef | undefined {
  const data = snapshotDataRecord(raw, path, errors, SUBJECT_KEYS.length);
  if (data === undefined) return undefined;
  const unknownBefore = errors.length;
  rejectUnknownKeys(data, path, SUBJECT_KEYS, errors);
  let failed = errors.length > unknownBefore;
  if (
    !checkString(data["subject_id"], `${path}.subject_id`, errors, EVENT_LIMITS.subjectIdBytes, {
      required: true,
      allowEmpty: false,
    })
  ) {
    failed = true;
  }
  const role = data["role"];
  if (
    typeof role !== "string" ||
    !(SUBJECT_ROLES as readonly string[]).includes(role)
  ) {
    errors.push(`${path}.role: must be one of ${SUBJECT_ROLES.join(" | ")}`);
    failed = true;
  }
  const displayName = data["display_name"];
  if (
    displayName !== undefined &&
    !checkString(displayName, `${path}.display_name`, errors, EVENT_LIMITS.displayNameBytes, {
      required: false,
      allowEmpty: true,
    })
  ) {
    failed = true;
  }
  if (failed) return undefined;
  return freezeRecord({
    subject_id: data["subject_id"] as string,
    role: role as SubjectRole,
    ...(typeof displayName === "string" ? { display_name: displayName } : {}),
  });
}

function validateAttachment(
  raw: unknown,
  path: string,
  errors: string[],
): AttachmentRef | undefined {
  const data = snapshotDataRecord(raw, path, errors, ATTACHMENT_KEYS.length);
  if (data === undefined) return undefined;
  const unknownBefore = errors.length;
  rejectUnknownKeys(data, path, ATTACHMENT_KEYS, errors);
  let failed = errors.length > unknownBefore;
  if (
    !checkString(
      data["attachment_id"],
      `${path}.attachment_id`,
      errors,
      EVENT_LIMITS.attachmentIdBytes,
      { required: true, allowEmpty: false },
    )
  ) {
    failed = true;
  }
  if (
    !checkString(data["media_type"], `${path}.media_type`, errors, EVENT_LIMITS.mediaTypeBytes, {
      required: true,
      allowEmpty: false,
    })
  ) {
    failed = true;
  }
  const filename = data["filename"];
  if (
    filename !== undefined &&
    !checkString(filename, `${path}.filename`, errors, EVENT_LIMITS.filenameBytes, {
      required: false,
      allowEmpty: true,
      identifier: true,
    })
  ) {
    failed = true;
  }
  const byteSize = data["byte_size"];
  if (byteSize !== undefined) {
    if (
      typeof byteSize !== "number" ||
      !Number.isSafeInteger(byteSize) ||
      byteSize < 0 ||
      byteSize > EVENT_LIMITS.attachmentByteSizeMax
    ) {
      errors.push(
        `${path}.byte_size: must be a non-negative integer at most ${EVENT_LIMITS.attachmentByteSizeMax} when present`,
      );
      failed = true;
    }
  }
  if (failed) return undefined;
  return freezeRecord({
    attachment_id: data["attachment_id"] as string,
    media_type: data["media_type"] as string,
    ...(typeof filename === "string" ? { filename } : {}),
    ...(typeof byteSize === "number" ? { byte_size: byteSize } : {}),
  });
}

function rejectDuplicateSubjects(subjects: SubjectRef[], errors: string[]): void {
  const seen = new Set<string>();
  for (const subject of subjects) {
    const key = `${subject.subject_id}\0${subject.role}`;
    if (seen.has(key)) {
      errors.push(
        "subjects: duplicate subject and role",
      );
      continue;
    }
    seen.add(key);
  }
}

function rejectDuplicateAttachments(
  attachments: AttachmentRef[],
  errors: string[],
): void {
  const seen = new Set<string>();
  for (const attachment of attachments) {
    if (seen.has(attachment.attachment_id)) {
      errors.push(
        "attachments: duplicate attachment identifier",
      );
      continue;
    }
    seen.add(attachment.attachment_id);
  }
}

/**
 * Validates a connector-supplied event. Unknown keys are rejected: the
 * frozen schema has no extension bag, and a caller-supplied `event_id` or
 * `content_hash` is not ingress. The returned value is a frozen exact-JSON
 * snapshot — hashing and persistence must use this object, not the input.
 */
export function validateEventInput(
  input: unknown,
): ValidationResult<CaptureEventInput> {
  try {
    return validateSnapshot(input);
  } catch {
    return { ok: false, errors: ["event: input could not be read as plain data"] };
  }
}

function validateSnapshot(raw: unknown): ValidationResult<CaptureEventInput> {
  const errors: string[] = [];
  const input = snapshotDataRecord(raw, "event", errors, EVENT_INPUT_KEYS.length);
  if (input === undefined) return { ok: false, errors };
  rejectUnknownKeys(input, "event", EVENT_INPUT_KEYS, errors);

  if (input["schema"] !== EVENT_SCHEMA) {
    errors.push(`schema: must be "${EVENT_SCHEMA}"`);
  }
  checkString(input["connector_id"], "connector_id", errors, EVENT_LIMITS.identifierBytes, {
    required: true,
    allowEmpty: false,
  });
  checkString(
    input["source_record_id"],
    "source_record_id",
    errors,
    EVENT_LIMITS.sourceRecordIdBytes,
    { required: true, allowEmpty: false },
  );
  checkString(input["kind"], "kind", errors, EVENT_LIMITS.identifierBytes, {
    required: true,
    allowEmpty: false,
  });
  checkTimestamp(input["occurred_at"], "occurred_at", errors);
  checkTimestamp(input["observed_at"], "observed_at", errors);
  checkString(input["text"], "text", errors, EVENT_LIMITS.textBytes, {
    required: true,
    allowEmpty: true,
  });

  const subjects: SubjectRef[] = [];
  const rawSubjects = snapshotDataArray(input["subjects"], "subjects", EVENT_LIMITS.subjectCount, errors);
  if (rawSubjects !== undefined) {
    rawSubjects.forEach((raw, i) => {
      const subject = validateSubject(raw, `subjects[${i}]`, errors);
      if (subject !== undefined) subjects.push(subject);
    });
    rejectDuplicateSubjects(subjects, errors);
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
  const rawAttachments = snapshotDataArray(input["attachments"], "attachments", EVENT_LIMITS.attachmentCount, errors);
  if (rawAttachments !== undefined) {
    rawAttachments.forEach((raw, i) => {
      const attachment = validateAttachment(raw, `attachments[${i}]`, errors);
      if (attachment !== undefined) attachments.push(attachment);
    });
    rejectDuplicateAttachments(attachments, errors);
  }

  let metadata: Record<string, unknown> | undefined;
  const rawMetadata = input["metadata"];
  if (!isPlainObject(rawMetadata)) {
    errors.push("metadata: must be a plain object");
  } else {
    const cloned = cloneExactJson(rawMetadata, "metadata", {
      maxDepth: EVENT_LIMITS.metadataDepth,
      maxKeysPerObject: EVENT_LIMITS.metadataKeysPerObject,
      maxArrayLength: EVENT_LIMITS.metadataArrayLength,
      maxStringBytes: EVENT_LIMITS.metadataStringBytes,
      maxKeyBytes: EVENT_LIMITS.metadataKeyBytes,
      maxTotalBytes: EVENT_LIMITS.metadataBytes,
    }, errors);
    if (cloned !== undefined && isPlainObject(cloned)) {
      metadata = cloned;
    } else if (cloned !== undefined) {
      errors.push("metadata: must be a plain object");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const value = freezeRecord({
    schema: EVENT_SCHEMA,
    connector_id: input["connector_id"] as string,
    source_record_id: input["source_record_id"] as string,
    kind: input["kind"] as string,
    occurred_at: input["occurred_at"] as string,
    observed_at: input["observed_at"] as string,
    text: input["text"] as string,
    subjects: Object.freeze(subjects) as SubjectRef[],
    ...(hint !== undefined
      ? { sensitivity_hint: hint as SensitivityHint }
      : {}),
    deleted: input["deleted"] as boolean,
    attachments: Object.freeze(attachments) as AttachmentRef[],
    metadata: metadata as Record<string, unknown>,
  });

  if (utf8ByteLength(JSON.stringify(value)) > EVENT_LIMITS.eventBytes) {
    return {
      ok: false,
      errors: [`event: exceeds ${EVENT_LIMITS.eventBytes} UTF-8 bytes`],
    };
  }

  return { ok: true, value };
}
