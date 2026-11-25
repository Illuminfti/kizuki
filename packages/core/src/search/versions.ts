import type { Database } from "bun:sqlite";
import { laterVersionSql } from "../ledger/ledger";
import { tableExists } from "../ledger/schema";
import { sourceServingSql, type SourceServingScope } from "../ledger/source-grants";
import { ceilingSql, instantBoundPair, instantPairSql } from "../query/sql";
import { placeholders } from "../util/sql";

export interface VersionScope {
  ceiling: number | null;
  types?: readonly string[];
  subjects?: readonly string[];
  since?: string;
  until?: string;
  source?: SourceServingScope;
}

interface CachedVersionEntry {
  stmt: ReturnType<Database["query"]>;
  bindings: (string | number)[];
}

interface CachedVersionQuery {
  schemaVersion: number;
  hasReceipts: boolean;
  epochActive: boolean;
  entries: Map<string, CachedVersionEntry>;
}

const versionQueryCache = new WeakMap<Database, CachedVersionQuery>();

function versionScopeKey(scope: VersionScope): string {
  if (
    scope.types === undefined &&
    scope.subjects === undefined &&
    scope.since === undefined &&
    scope.until === undefined
  ) {
    const src = scope.source;
    if (src === undefined) return `s:${scope.ceiling}`;
    const deny = src.deny_classes;
    return `s:${scope.ceiling}|${src.owner ? 1 : 0}|${src.purpose ?? "recall"}|${deny === undefined || deny.length === 0 ? "" : deny.join(",")}`;
  }
  return JSON.stringify([
    scope.ceiling,
    scope.types ?? null,
    scope.subjects ?? null,
    scope.since ?? null,
    scope.until ?? null,
    scope.source === undefined
      ? null
      : [scope.source.owner, scope.source.purpose ?? "recall", scope.source.deny_classes ?? []],
  ]);
}

function readSchemaAndEpoch(db: Database, hasReceipts: boolean): { schemaVersion: number; epochActive: boolean } {
  if (hasReceipts) {
    const row = db
      .query<{ sv: number; ep: number }, []>(
        "SELECT (SELECT schema_version FROM pragma_schema_version) AS sv, (coalesce((SELECT max(sequence) FROM source_grant_receipts), 0) > 0) AS ep",
      )
      .get()!;
    return { schemaVersion: row.sv, epochActive: row.ep === 1 };
  }
  const sv = db.query<{ schema_version: number }, []>("SELECT schema_version FROM pragma_schema_version").get()!.schema_version;
  return { schemaVersion: sv, epochActive: false };
}

/**
 * A hidden revision must not withdraw a visible answer. Only later versions
 * inside the reader's scope supersede this one. `events` is the anchor alias;
 * the same predicate serves the floor and rechecks port nominations.
 */
export function currentVersionSql(db: Database, scope: VersionScope) {
  // Short-circuit `later.event_id <> events.event_id` first so non-edited
  // records skip the correlated source-binding, timestamp, and policy checks
  // when SQLite visits the anchor row itself via `(connector_id, source_record_id)`.
  const clauses = ["later.event_id <> events.event_id", laterVersionSql("later", "events")];
  const bindings: (string | number)[] = [];
  if (scope.ceiling !== null) {
    clauses.push(ceilingSql("later.sensitivity_hint"));
    bindings.push(scope.ceiling);
  }
  if (scope.types !== undefined) {
    clauses.push(scope.types.length === 0 ? "0" : `later.kind IN (${placeholders(scope.types.length)})`);
    bindings.push(...scope.types);
  }
  if (scope.subjects !== undefined) {
    clauses.push(scope.subjects.length === 0 ? "0" : `EXISTS (
      SELECT 1 FROM json_each(later.subjects)
      WHERE json_extract(value, '$.subject_id') IN (${placeholders(scope.subjects.length)})
    )`);
    bindings.push(...scope.subjects);
  }
  if (scope.since !== undefined) {
    clauses.push(`${instantPairSql("later.occurred_at")} >= (?, ?)`);
    bindings.push(...instantBoundPair(scope.since, "search since"));
  }
  if (scope.until !== undefined) {
    clauses.push(`${instantPairSql("later.occurred_at")} < (?, ?)`);
    bindings.push(...instantBoundPair(scope.until, "search until"));
  }
  if (scope.source !== undefined) {
    const policy = sourceServingSql(db, scope.source, scope.ceiling);
    if (policy !== null) {
      clauses.push(policy.sql.replace(/\bevents\./g, "later."));
      bindings.push(...policy.bindings);
    }
  }
  return {
    sql: `NOT EXISTS (SELECT 1 FROM events AS later WHERE ${clauses.join(" AND ")})`,
    bindings,
  };
}

export function isCurrentVersion(db: Database, eventId: string, scope: VersionScope): boolean {
  let cached = versionQueryCache.get(db);
  if (cached !== undefined) {
    const state = readSchemaAndEpoch(db, cached.hasReceipts);
    if (state.schemaVersion !== cached.schemaVersion || state.epochActive !== cached.epochActive) {
      cached = undefined;
    }
  }
  const key = versionScopeKey(scope);
  let entry = cached?.entries.get(key);
  if (entry === undefined) {
    const hasReceipts = tableExists(db, "source_grant_receipts");
    const state = readSchemaAndEpoch(db, hasReceipts);
    const current = currentVersionSql(db, scope);
    entry = {
      stmt: db.query(`SELECT 1 FROM events WHERE event_id = ? AND ${current.sql}`),
      bindings: current.bindings,
    };
    if (cached === undefined) {
      cached = { schemaVersion: state.schemaVersion, hasReceipts, epochActive: state.epochActive, entries: new Map() };
      versionQueryCache.set(db, cached);
    }
    if (cached.entries.size >= 64) cached.entries.clear();
    cached.entries.set(key, entry);
  }
  return entry.stmt.get(eventId, ...entry.bindings) !== null;
}
