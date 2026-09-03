import {
  PAGE_SENSITIVITIES,
  PAGE_TYPES,
  SUBJECT_ROLES,
  isPlainObject,
} from "@kizuki/core";
import type { PageSensitivity, PageType, SubjectRole } from "@kizuki/core";
import { TIMESTAMP_FORMATS, vocabularyMap } from "../legacy/coerce";
import type { TimestampFormat } from "../legacy/coerce";
import { mappingRules } from "../legacy/mapping-parse";
import type { MappingRules } from "../legacy/mapping-parse";

export const LEGACY_WIKI_CONNECTOR_ID = "kizuki.import-legacy-wiki" as const;
export const LEGACY_WIKI_MAPPING_SCHEMA =
  "kizuki.legacy-wiki-mapping/v1" as const;

const EXTENSION_NAME = /^x-[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/;
const DIRECTORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_DIRECTORY_SEGMENTS = 7;
const MAX_FIELD_NAME = 200;

export interface LegacyWikiConfig {
  /** The wiki root directory. */
  path: string;
  /** A mapping file path, or the mapping itself; default: beside the source. */
  mapping?: string | LegacyWikiMapping;
  /** Absolute path; `.json` writes JSON, anything else writes Markdown. */
  report?: string;
}

export interface LegacyWikiMapping {
  schema: typeof LEGACY_WIKI_MAPPING_SCHEMA;
  title: { field: string };
  type: {
    field: string;
    /** Legacy value to page type; null excludes the page from the import. */
    values: Record<string, PageType | null>;
    default: PageType;
  };
  sensitivity: {
    field: string;
    values: Record<string, PageSensitivity>;
    /**
     * The connector default. RFC 0002 section 8.1 resolves an absent or
     * unreadable label to the bottom of the lattice rather than leaving the
     * page outside it, because an unlabeled page is served to nobody at all.
     * The report still says the label was defaulted, so the owner can widen
     * `values` and re-import rather than live with a blanket `private`.
     */
    default: PageSensitivity;
  };
  occurred_at: { field: string; format: TimestampFormat } | null;
  /** Legacy key to an `x-*` name, or null to drop it. */
  fields: Record<string, string | null>;
  subjects: { field: string; role: SubjectRole; namespace: string } | null;
  target: { mode: "flat" | "mirror"; directories: Record<PageType, string> };
  ignore: string[];
}

export const DEFAULT_DIRECTORIES: Record<PageType, string> = {
  person: "entities",
  org: "entities",
  project: "entities",
  place: "entities",
  topic: "entities",
  fact: "facts",
  event: "events",
  source: "sources",
  rollup: "dashboards",
};

/**
 * Extension names nothing in a legacy estate may claim. The first four are
 * stamped by the planner, the last three by the floor when it turns the
 * candidate into a proposal; either way the stamp wins, so a mapping or a page
 * that aims a field at one of them would lose the value while the report said
 * it had been carried over.
 */
export const RESERVED_EXTENSIONS: readonly string[] = [
  "x-legacy-path",
  "x-legacy-sensitivity",
  "x-legacy-title-source",
  "x-legacy-type",
  "x-connector",
  "x-capture-kind",
  "x-source-record-id",
];

const rules = mappingRules(LEGACY_WIKI_CONNECTOR_ID);
const fail: MappingRules["fail"] = rules.fail;
const objectAt: MappingRules["objectAt"] = rules.objectAt;
const enumValue: MappingRules["enumValue"] = rules.enumValue;

function fieldName(raw: unknown, path: string): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_FIELD_NAME
  ) {
    fail(path, `must be a field name of 1..${MAX_FIELD_NAME} characters`);
  }
  return raw;
}

function stringMap(raw: unknown, path: string): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) fail(path, "must be an object");
  return raw;
}

function parseTitle(raw: unknown): LegacyWikiMapping["title"] {
  if (raw === undefined) return { field: "title" };
  const source = objectAt(raw, "mapping.title", ["field"]);
  return {
    field: fieldName(source["field"] ?? "title", "mapping.title.field"),
  };
}

function parseType(raw: unknown): LegacyWikiMapping["type"] {
  const source = objectAt(raw ?? {}, "mapping.type", [
    "field",
    "values",
    "default",
  ]);
  const values = vocabularyMap<PageType | null>();
  for (const [legacy, mapped] of Object.entries(
    stringMap(source["values"], "mapping.type.values"),
  )) {
    values[legacy] =
      mapped === null
        ? null
        : enumValue(mapped, `mapping.type.values.${legacy}`, PAGE_TYPES);
  }
  return {
    field: fieldName(source["field"] ?? "type", "mapping.type.field"),
    values,
    default: enumValue(source["default"], "mapping.type.default", PAGE_TYPES),
  };
}

function parseSensitivity(raw: unknown): LegacyWikiMapping["sensitivity"] {
  const source = objectAt(raw ?? {}, "mapping.sensitivity", [
    "field",
    "values",
    "default",
  ]);
  const values = vocabularyMap<PageSensitivity>();
  for (const [legacy, mapped] of Object.entries(
    stringMap(source["values"], "mapping.sensitivity.values"),
  )) {
    values[legacy] = enumValue(
      mapped,
      `mapping.sensitivity.values.${legacy}`,
      PAGE_SENSITIVITIES,
    );
  }
  return {
    field: fieldName(
      source["field"] ?? "sensitivity",
      "mapping.sensitivity.field",
    ),
    values,
    default: enumValue(
      source["default"] ?? "private",
      "mapping.sensitivity.default",
      PAGE_SENSITIVITIES,
    ),
  };
}

function parseOccurredAt(raw: unknown): LegacyWikiMapping["occurred_at"] {
  if (raw === undefined || raw === null) return null;
  const source = objectAt(raw, "mapping.occurred_at", ["field", "format"]);
  return {
    field: fieldName(source["field"], "mapping.occurred_at.field"),
    format: enumValue(
      source["format"],
      "mapping.occurred_at.format",
      TIMESTAMP_FORMATS,
    ),
  };
}

function parseSubjects(raw: unknown): LegacyWikiMapping["subjects"] {
  if (raw === undefined || raw === null) return null;
  const source = objectAt(raw, "mapping.subjects", [
    "field",
    "role",
    "namespace",
  ]);
  const namespace = source["namespace"];
  if (typeof namespace !== "string" || !NAMESPACE.test(namespace)) {
    fail("mapping.subjects.namespace", `must match ${NAMESPACE.toString()}`);
  }
  return {
    field: fieldName(source["field"], "mapping.subjects.field"),
    role: enumValue(source["role"], "mapping.subjects.role", SUBJECT_ROLES),
    namespace,
  };
}

function parseFields(
  raw: unknown,
  consumed: Map<string, string>,
): Record<string, string | null> {
  const fields = vocabularyMap<string | null>();
  const taken = new Set<string>();
  for (const [legacy, mapped] of Object.entries(
    stringMap(raw, "mapping.fields"),
  )) {
    const owner = consumed.get(legacy);
    if (owner !== undefined) {
      fail(`mapping.fields.${legacy}`, `already consumed by ${owner}`);
    }
    if (mapped === null) {
      fields[legacy] = null;
      continue;
    }
    if (typeof mapped !== "string" || !EXTENSION_NAME.test(mapped)) {
      fail(`mapping.fields.${legacy}`, "must be an x-* name or null");
    }
    if (RESERVED_EXTENSIONS.includes(mapped)) {
      fail(
        `mapping.fields.${legacy}`,
        `already consumed by the importer, which sets ${mapped} itself`,
      );
    }
    if (taken.has(mapped)) {
      fail(`mapping.fields.${legacy}`, `must be distinct; ${mapped} is taken`);
    }
    taken.add(mapped);
    fields[legacy] = mapped;
  }
  return fields;
}

function parseTarget(raw: unknown): LegacyWikiMapping["target"] {
  const source = objectAt(raw ?? {}, "mapping.target", ["mode", "directories"]);
  const directories: Record<PageType, string> = { ...DEFAULT_DIRECTORIES };
  for (const [type, directory] of Object.entries(
    stringMap(source["directories"], "mapping.target.directories"),
  )) {
    const path = `mapping.target.directories.${type}`;
    if (!(PAGE_TYPES as readonly string[]).includes(type)) {
      fail("mapping.target.directories", `unknown key ${type}`);
    }
    if (typeof directory !== "string") fail(path, "must be a string");
    const segments = directory.split("/");
    if (
      segments.length < 1 ||
      segments.length > MAX_DIRECTORY_SEGMENTS ||
      !segments.every(
        (segment) => segment.length <= 64 && DIRECTORY_SEGMENT.test(segment),
      )
    ) {
      fail(path, `must be 1..${MAX_DIRECTORY_SEGMENTS} usable path segments`);
    }
    directories[type as PageType] = directory;
  }
  return {
    mode: enumValue(source["mode"] ?? "flat", "mapping.target.mode", [
      "flat",
      "mirror",
    ] as const),
    directories,
  };
}

function parseIgnore(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    fail("mapping.ignore", "must be an array of glob strings");
  }
  return [...(raw as string[])];
}

export function parseLegacyWikiMapping(raw: unknown): LegacyWikiMapping {
  const source = objectAt(raw, "mapping", [
    "schema",
    "title",
    "type",
    "sensitivity",
    "occurred_at",
    "fields",
    "subjects",
    "target",
    "ignore",
  ]);
  if (source["schema"] !== LEGACY_WIKI_MAPPING_SCHEMA) {
    fail("mapping.schema", `must be "${LEGACY_WIKI_MAPPING_SCHEMA}"`);
  }

  const title = parseTitle(source["title"]);
  const type = parseType(source["type"]);
  const sensitivity = parseSensitivity(source["sensitivity"]);
  const occurredAt = parseOccurredAt(source["occurred_at"]);
  const subjects = parseSubjects(source["subjects"]);

  const consumed = new Map<string, string>([
    [title.field, "mapping.title.field"],
    [type.field, "mapping.type.field"],
    [sensitivity.field, "mapping.sensitivity.field"],
  ]);
  if (occurredAt !== null)
    consumed.set(occurredAt.field, "mapping.occurred_at.field");
  if (subjects !== null) consumed.set(subjects.field, "mapping.subjects.field");

  return {
    schema: LEGACY_WIKI_MAPPING_SCHEMA,
    title,
    type,
    sensitivity,
    occurred_at: occurredAt,
    fields: parseFields(source["fields"], consumed),
    subjects,
    target: parseTarget(source["target"]),
    ignore: parseIgnore(source["ignore"]),
  };
}
