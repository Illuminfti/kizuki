import type { Database } from "bun:sqlite";
import { authorize } from "../agents";
import type { DenyReason, Grant, Sensitivity, Servable } from "../agents";
import type { TimelineEntry } from "../query/timeline";
import { bareRetrievalId } from "../retrieval/ids";
import type { SearchHit } from "../search/query";
import { placeholders } from "../util/sql";
import { asSensitivity } from "./canon";
import type { QuotedChunk } from "./types";

/** Bound on one `IN (...)` list, matching the graph layer's frontier chunk. */
const ID_CHUNK = 500;

export interface ServableEvent {
  event_id: string;
  kind: string;
  occurred_at: string;
  sensitivity: string;
  subjects: string[];
}

export interface QuotedSource extends ServableEvent {
  connector_id: string;
  text: string;
}

interface ServableEventRow {
  event_id: string;
  kind: string;
  occurred_at: string;
  sensitivity: string;
  subjects: string;
}

function chunks(ids: string[]): string[][] {
  const result: string[][] = [];
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    result.push(ids.slice(index, index + ID_CHUNK));
  }
  return result;
}

function subjectIds(raw: string): string[] {
  return (JSON.parse(raw) as { subject_id: string }[]).map(
    ({ subject_id }) => subject_id,
  );
}

/**
 * An event is live when it exists, is not itself a tombstone, and its source
 * record carries no tombstone row. `timeline()` only filters the row itself,
 * so the record-level check has to happen here.
 */
export function liveEventIds(db: Database, ids: string[]): Set<string> {
  const live = new Set<string>();
  for (const group of chunks(ids)) {
    const rows = db
      .query<{ event_id: string }, string[]>(
        `SELECT e.event_id FROM events e
          WHERE e.event_id IN (${placeholders(group.length)}) AND e.deleted = 0
            AND NOT EXISTS (SELECT 1 FROM events t
                             WHERE t.deleted = 1
                               AND t.connector_id = e.connector_id
                               AND t.source_record_id = e.source_record_id)`,
      )
      .all(...group);
    for (const row of rows) live.add(row.event_id);
  }
  return live;
}

/** Metadata only: the captured text stays out of authorization decisions. */
export function readServableEvents(
  db: Database,
  ids: string[],
): Map<string, ServableEvent> {
  const live = liveEventIds(db, ids);
  const facts = new Map<string, ServableEvent>();
  for (const group of chunks([...live])) {
    const rows = db
      .query<ServableEventRow, string[]>(
        `SELECT event_id, kind, occurred_at,
                coalesce(sensitivity_hint, 'unlabeled') AS sensitivity, subjects
           FROM events
          WHERE event_id IN (${placeholders(group.length)})`,
      )
      .all(...group);
    for (const row of rows) {
      facts.set(row.event_id, {
        event_id: row.event_id,
        kind: row.kind,
        occurred_at: row.occurred_at,
        sensitivity: row.sensitivity,
        subjects: subjectIds(row.subjects),
      });
    }
  }
  return facts;
}

/**
 * `type` carries the event kind, so a `types`-scoped grant restricts ledger
 * events by kind the same way it restricts canon pages by page type.
 */
export function eventServable(facts: ServableEvent): Servable {
  return {
    id: facts.event_id,
    sensitivity: facts.sensitivity,
    type: facts.kind,
    subjects: facts.subjects,
    occurred_at: facts.occurred_at,
  };
}

export function eventDecision(
  grant: Grant,
  facts: ServableEvent,
):
  | { allow: true; sensitivity: Sensitivity }
  | { allow: false; reason: DenyReason } {
  const label = asSensitivity(facts.sensitivity);
  if (label === null) return { allow: false, reason: "missing_sensitivity" };
  const decision = authorize(grant, eventServable(facts));
  return decision.allow
    ? { allow: true, sensitivity: label }
    : { allow: false, reason: decision.reason };
}

export function quotedChunk(
  source: QuotedSource,
  sensitivity: Sensitivity,
): QuotedChunk {
  return {
    event_id: source.event_id,
    connector_id: source.connector_id,
    kind: source.kind,
    occurred_at: source.occurred_at,
    sensitivity,
    subjects: source.subjects,
    text: source.text,
    tainted: true,
  };
}

export function timelineSource(entry: TimelineEntry): QuotedSource {
  return {
    event_id: entry.event_id,
    connector_id: entry.connector_id,
    kind: entry.kind,
    occurred_at: entry.occurred_at,
    sensitivity: entry.sensitivity,
    subjects: entry.subjects,
    text: entry.text_preview,
  };
}

export function ledgerHitSource(hit: SearchHit): QuotedSource {
  return {
    event_id: bareRetrievalId(hit.doc_id),
    connector_id: hit.connector_id,
    kind: hit.page_type,
    occurred_at: hit.occurred_at,
    sensitivity: hit.sensitivity,
    subjects: hit.subjects,
    text: hit.snippet,
  };
}
