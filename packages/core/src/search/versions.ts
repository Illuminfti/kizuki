import type { Database } from "bun:sqlite";
import { laterVersionSql } from "../ledger/ledger";
import { sourceServingSql, type SourcePurpose } from "../ledger/source-grants";
import { ceilingSql, instantBoundPair, instantPairSql } from "../query/sql";
import { placeholders } from "../util/sql";

export interface VersionScope {
  ceiling: number | null;
  types?: readonly string[];
  subjects?: readonly string[];
  since?: string;
  until?: string;
  source?: { owner: boolean; purpose?: SourcePurpose };
}

/**
 * A hidden revision must not withdraw a visible answer. Only later versions
 * inside the reader's scope supersede this one. `events` is the anchor alias;
 * the same predicate serves the floor and rechecks port nominations.
 */
export function currentVersionSql(db: Database, scope: VersionScope) {
  const clauses = [laterVersionSql("later", "events")];
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
  const current = currentVersionSql(db, scope);
  return db.query(`SELECT 1 FROM events WHERE event_id = ? AND ${current.sql}`)
    .get(eventId, ...current.bindings) !== null;
}
