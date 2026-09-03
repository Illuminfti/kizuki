import { mappingHash } from "../legacy/mapping-file";
import { LEGACY_EVENTS_MAPPING_SCHEMA } from "./mapping";
import type { LegacyEventsMapping } from "./mapping";
import type { LegacyRow } from "./source";

/**
 * A synthetic event export that exercises every branch the row reader has: a
 * mapped and an unmapped kind, an unreadable timestamp, a missing key, a
 * tombstone, both subject shapes, a blob, an over-long cell, and a null.
 */

export const LEGACY_EVENTS_FIXTURE_OBSERVED_AT = "2026-03-01T00:00:00.000Z";

const MAPPING: LegacyEventsMapping = {
  schema: LEGACY_EVENTS_MAPPING_SCHEMA,
  table: "events",
  source_record_id: { column: "id" },
  kind: {
    column: "type",
    values: { msg: "message", note: "note" },
    default: null,
  },
  occurred_at: { column: "ts", format: "unix_seconds" },
  observed_at: null,
  text: { columns: ["subject", "body"], join: "\n\n" },
  subjects: [
    { column: "sender", role: "from", namespace: "legacy", split: null },
    { column: "recipients", role: "to", namespace: "legacy", split: "," },
  ],
  sensitivity_hint: {
    column: "visibility",
    values: { pub: "public", priv: "private" },
  },
  deleted: { column: "is_deleted", true_values: [1, true, "1"] },
  metadata: { columns: "rest" },
};

const COLUMNS = [
  "id",
  "type",
  "ts",
  "subject",
  "body",
  "sender",
  "recipients",
  "visibility",
  "is_deleted",
  "extra",
  "payload",
] as const;

type Cell = string | number | null | Uint8Array;

const ROWS: Record<(typeof COLUMNS)[number], Cell>[] = [
  {
    id: "r1",
    type: "msg",
    ts: 1_767_225_600,
    subject: "The kettle",
    body: "It is on.",
    sender: "Ada",
    recipients: "Grace",
    visibility: null,
    is_deleted: 0,
    extra: null,
    payload: null,
  },
  {
    id: "r2",
    type: "msg",
    ts: 1_767_225_660,
    subject: "The library",
    body: "Closed today.",
    sender: "Grace",
    recipients: "Ada,Linus",
    visibility: "priv",
    is_deleted: 0,
    extra: null,
    payload: null,
  },
  {
    id: "r3",
    type: "note",
    ts: 1_767_225_720,
    subject: "Shopping",
    body: "Tea.",
    sender: "Ada",
    recipients: null,
    visibility: "pub",
    is_deleted: 0,
    extra: null,
    payload: null,
  },
  {
    id: "r4",
    type: "chat",
    ts: 1_767_225_780,
    subject: "Unmapped",
    body: "No kind for this.",
    sender: "Ada",
    recipients: null,
    visibility: null,
    is_deleted: 0,
    extra: null,
    payload: null,
  },
  {
    id: "r5",
    type: "msg",
    ts: "soon",
    subject: "Unreadable time",
    body: "When?",
    sender: "Ada",
    recipients: null,
    visibility: null,
    is_deleted: 0,
    extra: null,
    payload: null,
  },
  {
    id: "",
    type: "msg",
    ts: 1_767_225_900,
    subject: "No key",
    body: "Nowhere to file this.",
    sender: "Ada",
    recipients: null,
    visibility: null,
    is_deleted: 0,
    extra: null,
    payload: null,
  },
  {
    id: "r7",
    type: "msg",
    ts: 1_767_225_960,
    subject: "Retracted",
    body: "Deleted at the source.",
    sender: "Ada",
    recipients: "Grace",
    visibility: null,
    is_deleted: 1,
    extra: null,
    payload: null,
  },
  {
    id: "r8",
    type: "msg",
    ts: 1_767_226_020,
    subject: "Group",
    body: "A list of recipients.",
    sender: "Grace",
    recipients: '["Ada", "Linus"]',
    visibility: null,
    is_deleted: 0,
    extra: null,
    payload: null,
  },
  {
    id: "r9",
    type: "msg",
    ts: 1_767_226_080,
    subject: "Long tail",
    body: "A short body.",
    sender: "Ada",
    recipients: null,
    visibility: null,
    is_deleted: 0,
    extra: "x".repeat(20_000),
    payload: null,
  },
  {
    id: "r10",
    type: "note",
    ts: 1_767_226_140,
    subject: "Attachments",
    body: "Carries a blob.",
    sender: "Ada",
    recipients: null,
    visibility: null,
    is_deleted: 0,
    extra: "kept",
    payload: new Uint8Array([1, 2, 3]),
  },
  {
    id: "r11",
    type: "msg",
    ts: 1_767_226_200,
    subject: "Subject only",
    body: null,
    sender: "Ada",
    recipients: null,
    visibility: null,
    is_deleted: 0,
    extra: null,
    payload: null,
  },
  {
    id: 90_071_992_547_409_91,
    type: "msg",
    ts: 1_767_226_260,
    subject: "Numeric key",
    body: "An id that is a number.",
    sender: "Ada",
    recipients: null,
    visibility: null,
    is_deleted: 0,
    extra: null,
    payload: null,
  },
];

function literal(value: Cell): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (value instanceof Uint8Array) {
    return `X'${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}'`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function sql(): string {
  const inserts = ROWS.map(
    (row) =>
      `INSERT INTO events (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((column) => literal(row[column])).join(", ")});`,
  );
  return [
    "CREATE TABLE events (id TEXT, type TEXT, ts INTEGER, subject TEXT, body TEXT, sender TEXT, recipients TEXT, visibility TEXT, is_deleted INTEGER, extra TEXT, payload BLOB);",
    ...inserts,
  ].join("\n");
}

export const LEGACY_EVENTS_FIXTURE: {
  mapping: LegacyEventsMapping;
  rows: Record<string, unknown>[];
  columns: string[];
  sql: string;
} = {
  mapping: MAPPING,
  rows: ROWS,
  columns: [...COLUMNS],
  sql: sql(),
};

export function fixtureMappingHash(): string {
  return mappingHash(LEGACY_EVENTS_FIXTURE.mapping);
}

/** The fixture rows as the readers would hand them over, positions 1..n. */
export function fixtureRows(): LegacyRow[] {
  return LEGACY_EVENTS_FIXTURE.rows.map((values, index) => ({
    position: BigInt(index + 1),
    values,
  }));
}

/** The fixture as JSONL, for the reader that has no table. */
export function fixtureJsonl(): string {
  return `${LEGACY_EVENTS_FIXTURE.rows
    .map((row) => {
      const line: Record<string, unknown> = {};
      for (const column of COLUMNS) {
        const value = row[column];
        // JSONL cannot carry bytes; a blob column is simply absent there.
        if (value instanceof Uint8Array) continue;
        line[column] = value;
      }
      return JSON.stringify(line);
    })
    .join("\n")}\n`;
}
