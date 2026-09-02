import { PAGE_CANDIDATE_KEY } from "@kizuki/core";
import type {
  CaptureEventInput,
  PageSensitivity,
  SubjectRef,
} from "@kizuki/core";
import {
  mappedValue,
  parseLegacyTimestamp,
  sanitizeLine,
  subjectId,
} from "../legacy/coerce";
import {
  LEGACY_DEFAULT_SENSITIVITY,
  atLegacyFloor,
} from "../legacy/sensitivity";
import {
  LEGACY_EVENTS_CONNECTOR_ID,
  ROWID_ALIAS,
  consumedColumns,
} from "./mapping";
import type { LegacyEventsMapping } from "./mapping";
import type { LegacyRow } from "./source";

/**
 * One exported row to one ledger event, or a reported skip. Pure: the same row
 * and mapping always produce the same event, which is what makes re-importing
 * an export idempotent.
 */

export const MAX_TEXT_LENGTH = 262_144;
const MAX_SOURCE_RECORD_ID = 512;
const MAX_METADATA_STRING = 16_384;
const MAX_SUBJECTS = 200;

export type RowSkipReason =
  | "malformed_json"
  | "not_an_object"
  | "line_too_long"
  | "source_record_id_missing"
  | "occurred_at_invalid"
  | "observed_at_invalid"
  | "kind_unmapped";

export interface RowSkip {
  /** The source position in decimal: exact, and safe to serialize. */
  position: string;
  reason: RowSkipReason;
}

export type RowResult = { event: CaptureEventInput } | { skipped: RowSkip };

export interface RowOptions {
  observedAt: string;
  mappingHash: string;
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return null;
}

function truncate(value: string, max: number): { value: string; cut: boolean } {
  const points = [...value];
  return points.length > max
    ? { value: points.slice(0, max).join(""), cut: true }
    : { value, cut: false };
}

function recordId(raw: unknown): { id: string; hashed: boolean } | null {
  const text = scalarText(raw);
  if (text === null || text.length === 0) return null;
  if (text.length <= MAX_SOURCE_RECORD_ID) return { id: text, hashed: false };
  // A key too long to store is still a stable key once hashed, so a re-import
  // of the same row still dedupes.
  return {
    id: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
    hashed: true,
  };
}

function rowKind(
  values: Record<string, unknown>,
  mapping: LegacyEventsMapping,
): string | null {
  if ("const" in mapping.kind) return mapping.kind.const;
  const raw = scalarText(values[mapping.kind.column]);
  if (raw === null) return mapping.kind.default;
  return mappedValue(mapping.kind.values, raw) ?? mapping.kind.default;
}

function rowText(
  values: Record<string, unknown>,
  mapping: LegacyEventsMapping,
): string {
  if ("column" in mapping.text)
    return scalarText(values[mapping.text.column]) ?? "";
  const parts: string[] = [];
  for (const column of mapping.text.columns) {
    const part = scalarText(values[column]);
    if (part !== null && part.length > 0) parts.push(part);
  }
  return parts.join(mapping.text.join);
}

function subjectValues(raw: unknown, split: string | null): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string");
  }
  const text = scalarText(raw);
  if (text === null) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      // Not a JSON array after all; fall through to the split rule.
    }
  }
  return split === null ? [text] : text.split(split);
}

function rowSubjects(
  values: Record<string, unknown>,
  mapping: LegacyEventsMapping,
): SubjectRef[] {
  const subjects: SubjectRef[] = [];
  const seen = new Set<string>();
  for (const rule of mapping.subjects) {
    for (const value of subjectValues(values[rule.column], rule.split)) {
      if (subjects.length >= MAX_SUBJECTS) return subjects;
      const id = subjectId(rule.namespace, value);
      if (id === null) continue;
      const key = `${id}\u0000${rule.role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const display = sanitizeLine(value, 120);
      const local = id.slice(id.indexOf(":") + 1);
      subjects.push({
        subject_id: id,
        role: rule.role,
        // The id is lowercased and stripped; the display keeps whatever the
        // source wrote, but only when that says something the id does not.
        ...(display === local ? {} : { display_name: display }),
      });
    }
  }
  return subjects;
}

/**
 * Every row leaves labeled. A mapping that says nothing about a row, or says
 * something the mapping cannot read, is the unknown case RFC 0002 §8.1 puts at
 * the connector default, and §8.2 keeps the result at or above the floor: an
 * export of the owner's own messages is not published because a column in it
 * said "pub".
 */
function rowHint(
  values: Record<string, unknown>,
  mapping: LegacyEventsMapping,
): PageSensitivity {
  return atLegacyFloor(mappedHint(values, mapping) ?? LEGACY_DEFAULT_SENSITIVITY);
}

function mappedHint(
  values: Record<string, unknown>,
  mapping: LegacyEventsMapping,
): PageSensitivity | null {
  if (mapping.sensitivity_hint === null) return null;
  if ("const" in mapping.sensitivity_hint)
    return mapping.sensitivity_hint.const;
  const raw = scalarText(values[mapping.sensitivity_hint.column]);
  if (raw === null) return null;
  return mappedValue(mapping.sensitivity_hint.values, raw) ?? null;
}

function isDeleted(
  values: Record<string, unknown>,
  mapping: LegacyEventsMapping,
): boolean {
  if (mapping.deleted === null) return false;
  const value = values[mapping.deleted.column];
  if (value === undefined || value === null) return false;
  return mapping.deleted.true_values.some(
    (candidate) => candidate === value || String(candidate) === String(value),
  );
}

/**
 * Names the importer stamps itself. A column of the same name is a source
 * value, and a source value that overwrote a stamp would let an export claim
 * the connector's own mapping hash, invent a blob it never dropped, or mark a
 * live row deleted. Evidence and trusted stamps stay separate: the column is
 * refused, and the report says which ones were.
 */
const RESERVED_METADATA: ReadonlySet<string> = new Set([
  ROWID_ALIAS,
  // The floor stages `metadata[PAGE_CANDIDATE_KEY]` as a typed page. This
  // connector emits capture notes and is never entitled to one, so a column
  // that happens to carry the key must not become an instruction.
  PAGE_CANDIDATE_KEY,
  "mapping_hash",
  "legacy_deleted",
  "text_truncated",
  "__blobs",
  "__truncated",
  "__reserved_columns",
  "__source_record_id_hashed",
  // Assigning it by name on a plain object moves the prototype instead of
  // storing a value, so it is never a key this importer carries.
  "__proto__",
]);

interface SourceMetadata {
  /** Null-prototype: a column named after an Object member is still data. */
  columns: Record<string, unknown>;
  blobs: string[];
  truncated: string[];
  reserved: string[];
}

function rowMetadata(
  values: Record<string, unknown>,
  mapping: LegacyEventsMapping,
): SourceMetadata {
  const columns: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const blobs: string[] = [];
  const truncated: string[] = [];
  const reserved: string[] = [];
  const consumed = consumedColumns(mapping);
  const wanted =
    mapping.metadata.columns === "rest"
      ? Object.keys(values).filter((column) => !consumed.has(column))
      : mapping.metadata.columns;

  for (const column of wanted) {
    if (RESERVED_METADATA.has(column)) {
      if (!reserved.includes(column)) reserved.push(column);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(values, column)) continue;
    const value = values[column];
    // An empty cell is not evidence, and carrying it would put a null in
    // every event of a wide legacy table.
    if (value === null || value === undefined) continue;
    if (value instanceof Uint8Array) {
      // A blob is opaque bytes of unknown provenance; the name is evidence
      // enough and the bytes never enter the ledger.
      blobs.push(column);
      continue;
    }
    if (typeof value === "string" && value.length > MAX_METADATA_STRING) {
      columns[column] = value.slice(0, MAX_METADATA_STRING);
      truncated.push(column);
      continue;
    }
    columns[column] = value;
  }
  return { columns, blobs, truncated, reserved };
}

export function rowToEvent(
  row: LegacyRow,
  mapping: LegacyEventsMapping,
  opts: RowOptions,
): RowResult {
  if (row.values === null) {
    return {
      skipped: {
        position: row.position.toString(),
        reason: row.problem ?? "not_an_object",
      },
    };
  }
  const values = row.values;

  const id = recordId(values[mapping.source_record_id.column]);
  if (id === null) {
    return {
      skipped: { position: row.position.toString(), reason: "source_record_id_missing" },
    };
  }
  const kind = rowKind(values, mapping);
  if (kind === null) {
    return { skipped: { position: row.position.toString(), reason: "kind_unmapped" } };
  }
  const occurredAt = parseLegacyTimestamp(
    values[mapping.occurred_at.column],
    mapping.occurred_at.format,
  );
  if (occurredAt === null) {
    return {
      skipped: { position: row.position.toString(), reason: "occurred_at_invalid" },
    };
  }
  let observedAt = opts.observedAt;
  if (mapping.observed_at !== null) {
    const mapped = parseLegacyTimestamp(
      values[mapping.observed_at.column],
      mapping.observed_at.format,
    );
    if (mapped === null) {
      return {
        skipped: { position: row.position.toString(), reason: "observed_at_invalid" },
      };
    }
    observedAt = mapped;
  }

  const base = {
    schema: "kizuki.event/v1",
    connector_id: LEGACY_EVENTS_CONNECTOR_ID,
    source_record_id: id.id,
    kind,
    occurred_at: occurredAt,
    observed_at: observedAt,
  } as const;

  if (isDeleted(values, mapping)) {
    return {
      event: {
        ...base,
        text: "",
        subjects: [],
        deleted: true,
        attachments: [],
        metadata: {
          legacy_deleted: true,
          mapping_hash: opts.mappingHash,
          ...(id.hashed ? { __source_record_id_hashed: true } : {}),
        },
      },
    };
  }

  const text = truncate(rowText(values, mapping), MAX_TEXT_LENGTH);
  const source = rowMetadata(values, mapping);
  return {
    event: {
      ...base,
      text: text.value,
      subjects: rowSubjects(values, mapping),
      sensitivity_hint: rowHint(values, mapping),
      deleted: false,
      attachments: [],
      // The source bag first, the importer's own stamps last: what the export
      // said cannot overwrite what the importer knows.
      metadata: {
        ...source.columns,
        mapping_hash: opts.mappingHash,
        ...(source.blobs.length > 0 ? { __blobs: source.blobs } : {}),
        ...(source.truncated.length > 0
          ? { __truncated: source.truncated }
          : {}),
        ...(source.reserved.length > 0
          ? { __reserved_columns: source.reserved }
          : {}),
        ...(text.cut ? { text_truncated: true } : {}),
        ...(id.hashed ? { __source_record_id_hashed: true } : {}),
      },
    },
  };
}
