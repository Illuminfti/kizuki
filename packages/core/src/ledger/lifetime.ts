import type { Database, Statement } from "bun:sqlite";

// Bun 1.3.14 closes its query cache and transaction statements, but uncached
// prepares can otherwise keep sqlite3_close_v2's connection alive until GC.
//
// Bun's own query() cache holds only the first 20 distinct SQL strings; every
// later query() prepares a new statement. Tracked here through a WeakRef, each
// one survived the collections that ran inside its synchronous job, and its
// native memory is invisible to the JS heap, so a long synchronous pass (a canon
// write loop) grew by one statement per query. query() therefore keeps a bounded
// cache of strongly held statements in front of Bun's. Every prepared statement
// stays weakly tracked for close(), and finalized ones are swept out of tracking.
type LiveStatement = Statement & { readonly isFinalized: boolean };
interface Ownership {
  readonly prepare: Database["prepare"];
  readonly query: Database["query"];
  readonly close: Database["close"];
  readonly queries: Map<string, LiveStatement>;
  readonly statements: Set<WeakRef<LiveStatement>>;
  readonly seen: WeakSet<LiveStatement>;
  readonly collected: FinalizationRegistry<WeakRef<LiveStatement>>;
  sweepAt: number;
}
const ownership = new WeakMap<Database, Ownership>();

/** Distinct SQL strings one connection keeps prepared for query(). Eviction is
 * insertion-ordered: a hit stays allocation-free on the hot path. */
export const QUERY_CACHE_LIMIT = 512;

const SWEEP_FLOOR = 1024;

function track(owner: Ownership, statement: LiveStatement): void {
  if (owner.seen.has(statement)) return;
  owner.seen.add(statement);
  // Finalized statements need no closing; dropping their references lets a
  // long synchronous pass of prepare/finalize pairs release them.
  if (owner.statements.size >= owner.sweepAt) {
    for (const reference of owner.statements) {
      const tracked = reference.deref();
      if (tracked !== undefined && !tracked.isFinalized) continue;
      owner.statements.delete(reference);
      if (tracked !== undefined) owner.collected.unregister(tracked);
    }
    owner.sweepAt = Math.max(SWEEP_FLOOR, owner.statements.size * 2);
  }
  const reference = new WeakRef(statement);
  owner.statements.add(reference);
  owner.collected.register(statement, reference, statement);
}

/** Install before the first SQL operation. Fluent methods stay with Bun; the
 * query() cache and explicit connection closure own statement finalization. */
export function manageDatabaseLifetime(db: Database): Database {
  if (ownership.has(db)) return db;
  const statements = new Set<WeakRef<LiveStatement>>();
  const state: Ownership = {
    prepare: db.prepare, query: db.query, close: db.close,
    queries: new Map(), statements, seen: new WeakSet(),
    collected: new FinalizationRegistry(reference => { statements.delete(reference); }),
    sweepAt: SWEEP_FLOOR,
  };
  ownership.set(db, state);
  Object.defineProperties(db, {
    prepare: { configurable: true, writable: true, value: function prepare(this: Database, ...args: Parameters<Database["prepare"]>) {
      const owner = ownership.get(this);
      const statement = Reflect.apply(owner?.prepare ?? state.prepare, this, args) as LiveStatement;
      if (owner !== undefined) track(owner, statement);
      return statement;
    } },
    query: { configurable: true, writable: true, value: function query(this: Database, sql: string) {
      const owner = ownership.get(this);
      const cached = owner?.queries.get(sql);
      if (cached !== undefined && !cached.isFinalized) return cached;
      // Bun validates, and its own query() prepares through the tracked prepare above.
      const statement = Reflect.apply(owner?.query ?? state.query, this, [sql]) as LiveStatement;
      if (owner !== undefined) {
        owner.queries.delete(sql);
        owner.queries.set(sql, statement);
        // An evicted statement stays tracked: its holder can use it until close().
        if (owner.queries.size > QUERY_CACHE_LIMIT) owner.queries.delete(owner.queries.keys().next().value!);
      }
      return statement;
    } },
    close: { configurable: true, writable: true, value: function close(this: Database, ...args: Parameters<Database["close"]>) {
      const owner = ownership.get(this);
      const errors: unknown[] = [];
      if (owner !== undefined) {
        owner.queries.clear();
        for (const reference of owner.statements) {
          const statement = reference.deref();
          if (statement === undefined) { owner.statements.delete(reference); continue; }
          try {
            if (!statement.isFinalized) statement.finalize();
            if (!statement.isFinalized) throw new Error("database statement did not finalize");
            owner.statements.delete(reference);
            owner.collected.unregister(statement);
          } catch (error) { errors.push(error); }
        }
      }
      let result: ReturnType<Database["close"]>;
      try { result = Reflect.apply(owner?.close ?? state.close, this, args); }
      catch (error) { errors.push(error); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "database close failed");
      return result;
    } },
  });
  return db;
}
