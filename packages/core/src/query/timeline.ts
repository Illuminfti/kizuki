import type { Database } from "bun:sqlite";
import { MAX_GRANT_SCOPE_ITEMS, type Sensitivity } from "../agents/types";
import { LIVE_PREDICATE } from "../ledger/ledger";
import { sourceServingSql, type SourcePurpose } from "../ledger/source-grants";
import { placeholders } from "../util/sql";
import { ceilingSql, instantBoundPair, instantPairSql, instantSecondSql, instantNanoSql, requireCeiling } from "./sql";

export interface TimelineOptions {
  day?: string;
  since?: string;
  until?: string;
  subject?: string;
  /** Any-of subject match. Combined with `subject` when both are set. */
  subjects?: string[];
  connector_id?: string;
  kind?: string;
  /** Any-of kind match. Combined with `kind` when both are set. */
  kinds?: string[];
  ceiling: Sensitivity;
  limit?: number;
  /** Exclusive lower bound on `(occurred_at, event_id)` for bounded pages. */
  after?: { occurred_at: string; event_id: string };
  /** Push compatible source-policy into SQL before LIMIT. */
  source?: { owner: boolean; purpose?: SourcePurpose };
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
const OCCURRED_AT_PAIR = instantPairSql("events.occurred_at");
const OCCURRED_AT_ORDER = `${instantSecondSql("events.occurred_at")}, ${instantNanoSql("events.occurred_at")}`;
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

function scopeValues(
  single: string | undefined,
  many: string[] | undefined,
): string[] | undefined {
  if (single === undefined && many === undefined) return undefined;
  if (many !== undefined && many.length > MAX_GRANT_SCOPE_ITEMS) {
    throw new RangeError(
      `timeline scope must have at most ${MAX_GRANT_SCOPE_ITEMS} entries`,
    );
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const value of single === undefined ? many ?? [] : [single, ...(many ?? [])]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new RangeError("timeline scope entries are invalid");
    }
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  if (values.length > MAX_GRANT_SCOPE_ITEMS) {
    throw new RangeError(
      `timeline scope must have at most ${MAX_GRANT_SCOPE_ITEMS} entries`,
    );
  }
  return values;
}

/** Shared bounded selection; audit reads identities, never event previews. */
function timelinePlan(
  db: Database,
  opts: Omit<TimelineOptions, "ceiling">,
  ceiling: number | null,
): { tail: string | null; bindings: (string | number)[] } {
  const limit = validLimit(opts.limit ?? 200);
  if (limit === 0) return { tail: null, bindings: [] };

  const subjects = scopeValues(opts.subject, opts.subjects);
  const kinds = scopeValues(opts.kind, opts.kinds);
  if (subjects !== undefined && subjects.length === 0) return { tail: null, bindings: [] };
  if (kinds !== undefined && kinds.length === 0) return { tail: null, bindings: [] };

  const clauses = [LIVE_PREDICATE];
  const bindings: (string | number)[] = [];
  if (opts.day !== undefined) {
    const window = dayWindow(opts.day);
    clauses.push(
      `${OCCURRED_AT_PAIR} >= (?, ?)`,
      `${OCCURRED_AT_PAIR} < (?, ?)`,
    );
    bindings.push(...instantBoundPair(window.since, "timeline day start"), ...instantBoundPair(window.until, "timeline day end"));
  }
  if (opts.since !== undefined) {
    clauses.push(`${OCCURRED_AT_PAIR} >= (?, ?)`);
    bindings.push(...instantBoundPair(opts.since, "timeline since"));
  }
  if (opts.until !== undefined) {
    clauses.push(`${OCCURRED_AT_PAIR} < (?, ?)`);
    bindings.push(...instantBoundPair(opts.until, "timeline until"));
  }
  if (opts.after !== undefined) {
    if (typeof opts.after.event_id !== "string" || opts.after.event_id.length === 0) {
      throw new RangeError("timeline cursor event_id is invalid");
    }
    clauses.push(`(${OCCURRED_AT_ORDER}, events.event_id) > (?, ?, ?)`);
    bindings.push(
      ...instantBoundPair(opts.after.occurred_at, "timeline cursor"),
      opts.after.event_id,
    );
  }
  if (subjects !== undefined) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM json_each(events.subjects) AS subject
      WHERE json_extract(subject.value, '$.subject_id') IN (${placeholders(subjects.length)})
    )`);
    bindings.push(...subjects);
  }
  if (opts.connector_id !== undefined) {
    clauses.push("events.connector_id = ?");
    bindings.push(opts.connector_id);
  }
  if (kinds !== undefined) {
    clauses.push(`events.kind IN (${placeholders(kinds.length)})`);
    bindings.push(...kinds);
  }
  if (ceiling !== null) {
    clauses.push(ceilingSql("events.sensitivity_hint"));
    bindings.push(ceiling);
  }
  if (opts.source !== undefined) {
    const source = sourceServingSql(db, opts.source, ceiling);
    if (source !== null) {
      clauses.push(source.sql);
      bindings.push(...source.bindings);
    }
  }
  bindings.push(limit);

  return {
    tail: `FROM events WHERE ${clauses.join(" AND ")} ORDER BY ${OCCURRED_AT_ORDER}, events.event_id LIMIT ?`,
    bindings,
  };
}

export function timeline(db: Database, opts: TimelineOptions): TimelineEntry[] {
  const ceiling = requireCeiling(opts?.ceiling);
  const plan = timelinePlan(db, opts, ceiling);
  if (plan.tail === null) return [];

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
       ${plan.tail}`,
    )
    .all(...plan.bindings);

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

/** Internal audit identities only. Deliberately excluded from public exports. */
export function timelineAuditCandidates(db: Database, opts: Omit<TimelineOptions, "ceiling">): string[] {
  const plan = timelinePlan(db, opts, null);
  return plan.tail === null ? [] : db
    .query<{ event_id: string }, (string | number)[]>(`SELECT event_id ${plan.tail}`)
    .all(...plan.bindings).map(row => row.event_id);
}
