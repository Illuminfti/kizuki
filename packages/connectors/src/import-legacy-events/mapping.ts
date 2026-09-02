import { PAGE_SENSITIVITIES, SUBJECT_ROLES, isPlainObject } from "@kizuki/core";
import type { PageSensitivity, SubjectRole } from "@kizuki/core";
import { KizukiError } from "../errors";
import { TIMESTAMP_FORMATS, vocabularyMap } from "../legacy/coerce";
import type { TimestampFormat } from "../legacy/coerce";

export const LEGACY_EVENTS_CONNECTOR_ID =
  "kizuki.import-legacy-events" as const;
export const LEGACY_EVENTS_MAPPING_SCHEMA =
  "kizuki.legacy-events-mapping/v1" as const;

/** Table and column names; only ever interpolated as a quoted identifier. */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const KIND = /^[a-z][a-z0-9_]{0,31}$/;
/** The alias the reader gives sqlite's rowid; a source column may not claim it. */
export const ROWID_ALIAS = "__rowid";
const MAX_JOIN = 8;
const MAX_NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/;

export type SourceFormat = "sqlite" | "jsonl";

export interface LegacyEventsConfig {
  path: string;
  format?: SourceFormat;
  mapping?: string | LegacyEventsMapping;
  report?: string;
}

export interface ColumnRef {
  column: string;
}

export type KindRule =
  | { const: string }
  | { column: string; values: Record<string, string>; default: string | null };

export type TextRule = { column: string } | { columns: string[]; join: string };

export type SensitivityRule =
  | { const: PageSensitivity }
  | { column: string; values: Record<string, PageSensitivity> };

export interface SubjectRule {
  column: string;
  role: SubjectRole;
  namespace: string;
  split: string | null;
}

export interface LegacyEventsMapping {
  schema: typeof LEGACY_EVENTS_MAPPING_SCHEMA;
  /** Required for sqlite, absent for jsonl. */
  table: string | null;
  source_record_id: ColumnRef;
  kind: KindRule;
  occurred_at: ColumnRef & { format: TimestampFormat };
  observed_at: (ColumnRef & { format: TimestampFormat }) | null;
  text: TextRule;
  subjects: SubjectRule[];
  sensitivity_hint: SensitivityRule | null;
  deleted: {
    column: string;
    true_values: (string | number | boolean)[];
  } | null;
  metadata: { columns: "rest" | string[] };
}

function fail(path: string, rule: string): never {
  throw new KizukiError(
    "misconfigured",
    `${LEGACY_EVENTS_CONNECTOR_ID}: ${path}: ${rule}`,
  );
}

function objectAt(
  raw: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(raw)) fail(path, "must be an object");
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) fail(path, `unknown key ${key}`);
  }
  return raw;
}

function column(raw: unknown, path: string): string {
  if (typeof raw !== "string" || !IDENTIFIER.test(raw)) {
    fail(path, `must match ${IDENTIFIER.toString()}`);
  }
  if (raw === ROWID_ALIAS) fail(path, `must not be ${ROWID_ALIAS}`);
  return raw;
}

function enumValue<T extends string>(
  raw: unknown,
  path: string,
  values: readonly T[],
): T {
  if (typeof raw !== "string" || !(values as readonly string[]).includes(raw)) {
    fail(path, `must be one of ${values.join(" | ")}`);
  }
  return raw as T;
}

function kindName(raw: unknown, path: string): string {
  if (typeof raw !== "string" || !KIND.test(raw)) {
    fail(path, `must match ${KIND.toString()}`);
  }
  return raw;
}

function parseKind(raw: unknown): KindRule {
  if (!isPlainObject(raw)) fail("mapping.kind", "must be an object");
  if (Object.prototype.hasOwnProperty.call(raw, "const")) {
    objectAt(raw, "mapping.kind", ["const"]);
    return { const: kindName(raw["const"], "mapping.kind.const") };
  }
  objectAt(raw, "mapping.kind", ["column", "values", "default"]);
  const values = vocabularyMap<string>();
  const rawValues = raw["values"];
  if (rawValues !== undefined) {
    if (!isPlainObject(rawValues))
      fail("mapping.kind.values", "must be an object");
    for (const [legacy, mapped] of Object.entries(rawValues)) {
      values[legacy] = kindName(mapped, `mapping.kind.values.${legacy}`);
    }
  }
  const fallback = raw["default"];
  return {
    column: column(raw["column"], "mapping.kind.column"),
    values,
    default:
      fallback === undefined || fallback === null
        ? null
        : kindName(fallback, "mapping.kind.default"),
  };
}

function parseTimestamp(
  raw: unknown,
  path: string,
): ColumnRef & { format: TimestampFormat } {
  const source = objectAt(raw, path, ["column", "format"]);
  return {
    column: column(source["column"], `${path}.column`),
    format: enumValue(source["format"], `${path}.format`, TIMESTAMP_FORMATS),
  };
}

function parseText(raw: unknown): TextRule {
  if (!isPlainObject(raw)) fail("mapping.text", "must be an object");
  if (Object.prototype.hasOwnProperty.call(raw, "columns")) {
    objectAt(raw, "mapping.text", ["columns", "join"]);
    const columns = raw["columns"];
    if (!Array.isArray(columns) || columns.length === 0) {
      fail("mapping.text.columns", "must be a non-empty array of column names");
    }
    const join = raw["join"];
    if (typeof join !== "string" || join.length > MAX_JOIN) {
      fail(
        "mapping.text.join",
        `must be a string of at most ${MAX_JOIN} characters`,
      );
    }
    return {
      columns: columns.map((name, index) =>
        column(name, `mapping.text.columns[${index}]`),
      ),
      join,
    };
  }
  objectAt(raw, "mapping.text", ["column"]);
  return { column: column(raw["column"], "mapping.text.column") };
}

function parseSubjects(raw: unknown): SubjectRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("mapping.subjects", "must be an array");
  return raw.map((entry, index) => {
    const path = `mapping.subjects[${index}]`;
    const source = objectAt(entry, path, [
      "column",
      "role",
      "namespace",
      "split",
    ]);
    const namespace = source["namespace"];
    if (typeof namespace !== "string" || !MAX_NAMESPACE.test(namespace)) {
      fail(`${path}.namespace`, `must match ${MAX_NAMESPACE.toString()}`);
    }
    const split = source["split"];
    if (split !== undefined && split !== null && typeof split !== "string") {
      fail(`${path}.split`, "must be a string or null");
    }
    return {
      column: column(source["column"], `${path}.column`),
      role: enumValue(source["role"], `${path}.role`, SUBJECT_ROLES),
      namespace,
      split: typeof split === "string" && split.length > 0 ? split : null,
    };
  });
}

function parseSensitivity(raw: unknown): SensitivityRule | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw))
    fail("mapping.sensitivity_hint", "must be an object");
  if (Object.prototype.hasOwnProperty.call(raw, "const")) {
    objectAt(raw, "mapping.sensitivity_hint", ["const"]);
    return {
      const: enumValue(
        raw["const"],
        "mapping.sensitivity_hint.const",
        PAGE_SENSITIVITIES,
      ),
    };
  }
  objectAt(raw, "mapping.sensitivity_hint", ["column", "values"]);
  const values = vocabularyMap<PageSensitivity>();
  const rawValues = raw["values"];
  if (rawValues !== undefined) {
    if (!isPlainObject(rawValues)) {
      fail("mapping.sensitivity_hint.values", "must be an object");
    }
    for (const [legacy, mapped] of Object.entries(rawValues)) {
      values[legacy] = enumValue(
        mapped,
        `mapping.sensitivity_hint.values.${legacy}`,
        PAGE_SENSITIVITIES,
      );
    }
  }
  return {
    column: column(raw["column"], "mapping.sensitivity_hint.column"),
    values,
  };
}

function parseDeleted(raw: unknown): LegacyEventsMapping["deleted"] {
  if (raw === undefined || raw === null) return null;
  const source = objectAt(raw, "mapping.deleted", ["column", "true_values"]);
  const trueValues = source["true_values"];
  if (
    !Array.isArray(trueValues) ||
    trueValues.length === 0 ||
    !trueValues.every(
      (value) =>
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean",
    )
  ) {
    fail("mapping.deleted.true_values", "must be a non-empty array of scalars");
  }
  return {
    column: column(source["column"], "mapping.deleted.column"),
    true_values: trueValues as (string | number | boolean)[],
  };
}

function parseMetadata(raw: unknown): LegacyEventsMapping["metadata"] {
  if (raw === undefined) return { columns: "rest" };
  const source = objectAt(raw, "mapping.metadata", ["columns"]);
  const columns = source["columns"];
  if (columns === "rest" || columns === undefined) return { columns: "rest" };
  if (!Array.isArray(columns)) {
    fail(
      "mapping.metadata.columns",
      'must be "rest" or an array of column names',
    );
  }
  return {
    columns: columns.map((name, index) =>
      column(name, `mapping.metadata.columns[${index}]`),
    ),
  };
}

/** One column may fill one role, so a mapping cannot quietly double-count it. */
function assertDistinct(mapping: LegacyEventsMapping): void {
  const owners = new Map<string, string>();
  const claim = (name: string, owner: string): void => {
    if (owners.has(name)) fail("mapping", `column ${name} is consumed twice`);
    owners.set(name, owner);
  };
  claim(mapping.source_record_id.column, "source_record_id");
  if ("column" in mapping.kind) claim(mapping.kind.column, "kind");
  claim(mapping.occurred_at.column, "occurred_at");
  if (mapping.observed_at !== null)
    claim(mapping.observed_at.column, "observed_at");
  if ("column" in mapping.text) claim(mapping.text.column, "text");
  else for (const name of mapping.text.columns) claim(name, "text");
  if (mapping.deleted !== null) claim(mapping.deleted.column, "deleted");
  if (
    mapping.sensitivity_hint !== null &&
    "column" in mapping.sensitivity_hint
  ) {
    claim(mapping.sensitivity_hint.column, "sensitivity_hint");
  }
  // Subjects may share a column with each other — one column of names can be
  // read as several roles — but never with a core role, whose value means
  // something else entirely.
  for (const [index, subject] of mapping.subjects.entries()) {
    const owner = owners.get(subject.column);
    if (owner !== undefined) {
      fail(
        `mapping.subjects[${index}].column`,
        `column ${subject.column} is already consumed by ${owner}`,
      );
    }
  }
}

export function parseLegacyEventsMapping(
  raw: unknown,
  format: SourceFormat,
): LegacyEventsMapping {
  const source = objectAt(raw, "mapping", [
    "schema",
    "table",
    "source_record_id",
    "kind",
    "occurred_at",
    "observed_at",
    "text",
    "subjects",
    "sensitivity_hint",
    "deleted",
    "metadata",
  ]);
  if (source["schema"] !== LEGACY_EVENTS_MAPPING_SCHEMA) {
    fail("mapping.schema", `must be "${LEGACY_EVENTS_MAPPING_SCHEMA}"`);
  }

  const rawTable = source["table"];
  let table: string | null = null;
  if (format === "sqlite") {
    if (typeof rawTable !== "string")
      fail("mapping.table", "is required for sqlite");
    if (!IDENTIFIER.test(rawTable)) {
      fail("mapping.table", `must match ${IDENTIFIER.toString()}`);
    }
    table = rawTable;
  } else if (rawTable !== undefined && rawTable !== null) {
    fail("mapping.table", "must be absent for jsonl");
  }

  const mapping: LegacyEventsMapping = {
    schema: LEGACY_EVENTS_MAPPING_SCHEMA,
    table,
    source_record_id: {
      column: column(
        objectAt(source["source_record_id"], "mapping.source_record_id", [
          "column",
        ])["column"],
        "mapping.source_record_id.column",
      ),
    },
    kind: parseKind(source["kind"]),
    occurred_at: parseTimestamp(source["occurred_at"], "mapping.occurred_at"),
    observed_at:
      source["observed_at"] === undefined || source["observed_at"] === null
        ? null
        : parseTimestamp(source["observed_at"], "mapping.observed_at"),
    text: parseText(source["text"]),
    subjects: parseSubjects(source["subjects"]),
    sensitivity_hint: parseSensitivity(source["sensitivity_hint"]),
    deleted: parseDeleted(source["deleted"]),
    metadata: parseMetadata(source["metadata"]),
  };
  assertDistinct(mapping);
  return mapping;
}

/** Every kind this mapping can produce, so the manifest can be honest. */
export function kindsOf(mapping: LegacyEventsMapping): string[] {
  if ("const" in mapping.kind) return [mapping.kind.const];
  const kinds = new Set(Object.values(mapping.kind.values));
  if (mapping.kind.default !== null) kinds.add(mapping.kind.default);
  return [...kinds].sort();
}

/** Columns the mapping itself reads, so `metadata: rest` knows what is left. */
export function consumedColumns(mapping: LegacyEventsMapping): Set<string> {
  const consumed = new Set<string>([mapping.source_record_id.column]);
  if ("column" in mapping.kind) consumed.add(mapping.kind.column);
  consumed.add(mapping.occurred_at.column);
  if (mapping.observed_at !== null) consumed.add(mapping.observed_at.column);
  if ("column" in mapping.text) consumed.add(mapping.text.column);
  else for (const name of mapping.text.columns) consumed.add(name);
  if (mapping.deleted !== null) consumed.add(mapping.deleted.column);
  if (
    mapping.sensitivity_hint !== null &&
    "column" in mapping.sensitivity_hint
  ) {
    consumed.add(mapping.sensitivity_hint.column);
  }
  for (const subject of mapping.subjects) consumed.add(subject.column);
  return consumed;
}
