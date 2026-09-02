import type { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER } from "../agents/types";
import type { Sensitivity } from "../agents/types";
import {
  ceilingSql,
  instantBound,
  instantParam,
  instantSql,
  validLimit,
} from "./sql";

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
// SQLite orders NULL first, so a row whose instant the expression cannot
// evaluate would head the page it can never belong to. The order is made
// total instead: such a row sorts last, behind every instant that resolved.
const OCCURRED_AT_INSTANT = instantSql("events.occurred_at");
const PREVIEW_CODE_POINTS = 160;
const WHITESPACE = /\s/;

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

/**
 * Collapsed whitespace, trimmed, cut to `PREVIEW_CODE_POINTS` code points.
 * Built by walking the string and stopping at the cap rather than collapsing
 * and expanding the whole of it: `text` is connector-supplied and has no
 * length bound, so materializing every code point of a captured document
 * would let one row size the heap (AGENTS.md, bound user-controlled
 * allocation). The result is identical to collapsing first and slicing after.
 */
function preview(text: string): string {
  let result = "";
  let taken = 0;
  let gap = false;
  for (const character of text) {
    if (WHITESPACE.test(character)) {
      if (taken > 0) gap = true;
      continue;
    }
    if (taken === PREVIEW_CODE_POINTS) break;
    if (gap) {
      result += " ";
      taken += 1;
      gap = false;
      if (taken === PREVIEW_CODE_POINTS) break;
    }
    result += character;
    taken += 1;
  }
  return result;
}

export function timeline(
  db: Database,
  opts: TimelineOptions = {},
): TimelineEntry[] {
  // Arguments are checked before any short-circuit: an empty answer is a
  // result, and it must not hide a bound the caller mistyped.
  const limit = validLimit(opts.limit ?? 200, "timeline");
  const day = opts.day === undefined ? undefined : dayWindow(opts.day);
  const since =
    opts.since === undefined
      ? undefined
      : instantBound(opts.since, "timeline since");
  const until =
    opts.until === undefined
      ? undefined
      : instantBound(opts.until, "timeline until");
  if (limit === 0) return [];

  const clauses = ["events.deleted = 0"];
  const bindings: (string | number)[] = [];
  if (day !== undefined) {
    clauses.push(
      `${OCCURRED_AT_INSTANT} >= ${instantParam}`,
      `${OCCURRED_AT_INSTANT} < ${instantParam}`,
    );
    bindings.push(day.since, day.until);
  }
  if (since !== undefined) {
    clauses.push(`${OCCURRED_AT_INSTANT} >= ${instantParam}`);
    bindings.push(since);
  }
  if (until !== undefined) {
    clauses.push(`${OCCURRED_AT_INSTANT} < ${instantParam}`);
    bindings.push(until);
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
       ORDER BY ${OCCURRED_AT_INSTANT} IS NULL, ${OCCURRED_AT_INSTANT}, events.event_id
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
    text_preview: preview(row.text),
  }));
}
