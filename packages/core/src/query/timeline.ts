import type { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER } from "../agents/types";
import type { Sensitivity } from "../agents/types";
import { ceilingSql, instantBound, instantSql } from "./sql";

export interface TimelineOptions {
  day?: string;
  since?: string;
  until?: string;
  subject?: string;
  connector_id?: string;
  kind?: string;
  ceiling?: Sensitivity;
  limit?: number;
}

export interface TimelineEntry {
  event_id: string;
  occurred_at: string;
  connector_id: string;
  kind: string;
  subjects: string[];
  sensitivity: string;
  /** Ledger text is captured data, never instruction. */
  taint: "quoted";
  /** Collapsed whitespace, at most 160 Unicode code points. */
  text_preview: string;
}

interface TimelineRow {
  event_id: string;
  occurred_at: string;
  connector_id: string;
  kind: string;
  subjects: string;
  sensitivity: string;
  text: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OCCURRED_AT_INSTANT = instantSql("events.occurred_at");
const PREVIEW_CODE_POINTS = 160;

function dayWindow(day: string): { since: string; until: string } {
  if (!DAY.test(day)) {
    throw new RangeError("timeline day must be YYYY-MM-DD");
  }
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== day) {
    throw new RangeError("timeline day must be a real UTC calendar day");
  }
  return {
    since: start.toISOString(),
    until: new Date(start.getTime() + 86_400_000).toISOString(),
  };
}

function preview(text: string): string {
  return Array.from(text.replace(/\s+/g, " ").trim())
    .slice(0, PREVIEW_CODE_POINTS)
    .join("");
}

function validLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError("timeline limit must be a non-negative integer");
  }
  return limit;
}

export function timeline(
  db: Database,
  opts: TimelineOptions = {},
): TimelineEntry[] {
  const limit = validLimit(opts.limit ?? 200);
  if (limit === 0) return [];

  const clauses = ["events.deleted = 0"];
  const bindings: (string | number)[] = [];
  if (opts.day !== undefined) {
    const window = dayWindow(opts.day);
    clauses.push(
      `${OCCURRED_AT_INSTANT} >= julianday(?)`,
      `${OCCURRED_AT_INSTANT} < julianday(?)`,
    );
    bindings.push(window.since, window.until);
  }
  if (opts.since !== undefined) {
    clauses.push(`${OCCURRED_AT_INSTANT} >= julianday(?)`);
    bindings.push(instantBound(opts.since, "timeline since"));
  }
  if (opts.until !== undefined) {
    clauses.push(`${OCCURRED_AT_INSTANT} < julianday(?)`);
    bindings.push(instantBound(opts.until, "timeline until"));
  }
  if (opts.subject !== undefined) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM json_each(events.subjects) AS subject
      WHERE json_extract(subject.value, '$.subject_id') = ?
    )`);
    bindings.push(opts.subject);
  }
  if (opts.connector_id !== undefined) {
    clauses.push("events.connector_id = ?");
    bindings.push(opts.connector_id);
  }
  if (opts.kind !== undefined) {
    clauses.push("events.kind = ?");
    bindings.push(opts.kind);
  }
  if (opts.ceiling !== undefined) {
    clauses.push(ceilingSql("events.sensitivity_hint"));
    bindings.push(SENSITIVITY_ORDER[opts.ceiling]);
  }
  bindings.push(limit);

  const rows = db
    .query<TimelineRow, (string | number)[]>(
      `SELECT
         event_id,
         occurred_at,
         connector_id,
         kind,
         subjects,
         coalesce(sensitivity_hint, 'unlabeled') AS sensitivity,
         text
       FROM events
       WHERE ${clauses.join(" AND ")}
       ORDER BY ${OCCURRED_AT_INSTANT}, events.event_id
       LIMIT ?`,
    )
    .all(...bindings);

  return rows.map((row) => ({
    event_id: row.event_id,
    occurred_at: row.occurred_at,
    connector_id: row.connector_id,
    kind: row.kind,
    subjects: (JSON.parse(row.subjects) as { subject_id: string }[]).map(
      ({ subject_id }) => subject_id,
    ),
    sensitivity: row.sensitivity,
    taint: "quoted",
    text_preview: preview(row.text),
  }));
}
