import type { Database } from "bun:sqlite";
import { EVENT_CLASSES, isEventClass } from "../agents/types";
import type { EventClass } from "../agents/types";
import { scrubText } from "../producer/scrub";
import { EVENT_LIMITS } from "../contracts/event";
import { placeholders } from "../util/sql";
import { tableExists } from "./schema";

/**
 * Content classes are a side table keyed by event id. They sit outside the
 * event revision hash, so stamping or restamping one never changes what an
 * event is, and they are recomputable from the event and its source policy.
 *
 * `credential` is the shared secret-pattern set (the pre-egress scrubber's).
 * `machine_exhaust`, or a credential region an owner names, comes only from
 * `class_rules` in the source policy.
 */

export interface ClassRule {
  path_glob: string;
  class: EventClass;
}

const MAX_METADATA_VALUES = 1_000;
const ID_CHUNK = 500;

/** False means the scan was truncated, never that the unscanned tail was clean. */
function metadataLines(value: unknown, key: string, out: string[], depth: number): boolean {
  if (out.length >= MAX_METADATA_VALUES || depth > EVENT_LIMITS.metadataDepth) return false;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") out.push(`${key}=${value}`);
  else {
    // Container keys are captured text too, including keys with no scalar leaf.
    out.push(key);
    if (Array.isArray(value)) {
      for (const item of value) if (!metadataLines(item, key, out, depth + 1)) return false;
    } else if (typeof value === "object") {
      for (const [name, item] of Object.entries(value)) if (!metadataLines(item, name, out, depth + 1)) return false;
    }
  }
  return true;
}

/** Text and metadata scalars as `name=value`; an incomplete scan is credential. */
export function credentialShaped(text: string, metadata: unknown): boolean {
  if (scrubText(text).redactions.length > 0) return true;
  const lines: string[] = [];
  if (!metadataLines(metadata, "metadata", lines, 0)) return true;
  return lines.length > 0 && scrubText(lines.join("\n")).redactions.length > 0;
}

/** Stored metadata that will not parse cannot be shown clean: it reads as credential. */
function parsedMetadata(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The logical paths an event answers to: its source record id and any recorded relative path. */
function eventPaths(sourceRecordId: string, metadata: unknown): string[] {
  const paths = [sourceRecordId];
  if (metadata !== null && typeof metadata === "object") {
    const relpath = (metadata as Record<string, unknown>)["relpath"];
    if (typeof relpath === "string" && relpath !== sourceRecordId) paths.push(relpath);
  }
  return paths;
}

function ruleClasses(matchers: readonly { glob: Bun.Glob; class: EventClass }[], paths: readonly string[]): EventClass[] {
  const found = new Set<EventClass>();
  for (const matcher of matchers) {
    if (paths.some((path) => matcher.glob.match(path))) found.add(matcher.class);
  }
  return [...found];
}

function compile(rules: readonly ClassRule[]): { glob: Bun.Glob; class: EventClass }[] {
  return rules.map((rule) => ({ glob: new Bun.Glob(rule.path_glob), class: rule.class }));
}

function insertClass(db: Database, eventId: string, name: EventClass): void {
  db.query("INSERT OR IGNORE INTO event_classes(event_id, class) VALUES (?, ?)").run(eventId, name);
}

/** Capture-time stamp of the content-derived class. The event row must already exist. */
export function stampCredentialClass(
  db: Database,
  eventId: string,
  event: { text: string; metadata: unknown },
): void {
  if (credentialShaped(event.text, event.metadata)) insertClass(db, eventId, "credential");
}

/** Capture-time stamp of the owner-declared classes for a newly bound event. */
export function stampRuleClasses(
  db: Database,
  eventId: string,
  rules: readonly ClassRule[],
): void {
  if (rules.length === 0) return;
  const row = db
    .query<{ source_record_id: string; metadata: string }, [string]>(
      "SELECT source_record_id, metadata FROM events WHERE event_id = ?",
    )
    .get(eventId);
  if (row === null) return;
  const metadata = parsedMetadata(row.metadata);
  const paths = eventPaths(row.source_record_id, metadata.ok ? metadata.value : null);
  for (const name of ruleClasses(compile(rules), paths)) insertClass(db, eventId, name);
}

/**
 * Recompute every class of a source's events after its rules changed. The
 * caller owns the transaction, so a failed regrant leaves the old stamps.
 */
export function restampSourceClasses(
  db: Database,
  sourceKey: string,
  rules: readonly ClassRule[],
): void {
  const matchers = compile(rules);
  db.query(
    "DELETE FROM event_classes WHERE event_id IN (SELECT event_id FROM source_event_bindings WHERE source_key = ?)",
  ).run(sourceKey);
  for (const row of db
    .query<{ event_id: string; source_record_id: string; text: string; metadata: string }, [string]>(
      `SELECT e.event_id, e.source_record_id, e.text, e.metadata
         FROM events e JOIN source_event_bindings b ON b.event_id = e.event_id
        WHERE b.source_key = ? ORDER BY e.event_id`,
    )
    .iterate(sourceKey)) {
    const metadata = parsedMetadata(row.metadata);
    const value = metadata.ok ? metadata.value : null;
    if (!metadata.ok || credentialShaped(row.text, value)) insertClass(db, row.event_id, "credential");
    for (const name of ruleClasses(matchers, eventPaths(row.source_record_id, value))) {
      insertClass(db, row.event_id, name);
    }
  }
}

/** Migration backfill: every stored event gets its content class before any agent can read it. */
export function backfillCredentialClasses(db: Database): void {
  for (const row of db
    .query<{ event_id: string; text: string; metadata: string }, []>(
      "SELECT event_id, text, metadata FROM events ORDER BY event_id",
    )
    .iterate()) {
    const metadata = parsedMetadata(row.metadata);
    if (!metadata.ok) insertClass(db, row.event_id, "credential");
    else stampCredentialClass(db, row.event_id, { text: row.text, metadata: metadata.value });
  }
}

/** Classes held by any of the events: what a claim or page inherits from its sources. */
export function classesOfEvents(db: Database, ids: readonly string[]): EventClass[] {
  if (ids.length === 0 || !tableExists(db, "event_classes")) return [];
  const found = new Set<EventClass>();
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    const group = ids.slice(index, index + ID_CHUNK);
    for (const row of db
      .query<{ class: string }, string[]>(
        `SELECT DISTINCT class FROM event_classes WHERE event_id IN (${placeholders(group.length)})`,
      )
      .all(...group)) {
      if (isEventClass(row.class)) found.add(row.class);
    }
  }
  return EVENT_CLASSES.filter((name) => found.has(name));
}

/** Per-event classes, for callers that decide event by event. */
export function classesByEvent(db: Database, ids: readonly string[]): Map<string, EventClass[]> {
  const byEvent = new Map<string, EventClass[]>();
  if (ids.length === 0 || !tableExists(db, "event_classes")) return byEvent;
  for (let index = 0; index < ids.length; index += ID_CHUNK) {
    const group = ids.slice(index, index + ID_CHUNK);
    for (const row of db
      .query<{ event_id: string; class: string }, string[]>(
        `SELECT event_id, class FROM event_classes WHERE event_id IN (${placeholders(group.length)}) ORDER BY class`,
      )
      .all(...group)) {
      if (!isEventClass(row.class)) continue;
      byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row.class]);
    }
  }
  return byEvent;
}

/**
 * Serving predicate over `events`: no denied class. It sits in the same SQL as
 * the source policy so a LIMIT counts only rows the reader may see. A ledger
 * without the table is not a served ledger, so there is nothing to filter.
 */
export function classDenialSql(
  db: Database,
  denied: readonly EventClass[],
): { sql: string; bindings: string[] } | null {
  if (denied.length === 0 || !tableExists(db, "event_classes")) return null;
  return {
    sql: `NOT EXISTS (SELECT 1 FROM event_classes AS ec WHERE ec.event_id = events.event_id AND ec.class IN (${placeholders(denied.length)}))`,
    bindings: [...denied],
  };
}

export function applyEventClassesTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_classes (
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      class TEXT NOT NULL CHECK (class IN (${EVENT_CLASSES.map((name) => `'${name}'`).join(", ")})),
      PRIMARY KEY (event_id, class)
    ) STRICT, WITHOUT ROWID;
  `);
}
