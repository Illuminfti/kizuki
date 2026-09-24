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
//
// A cached statement is shared, so no iteration may keep it: SQLite holds an
// unfinished statement's read snapshot until it is reset, which leaves this
// connection reading stale rows and unable to write. An iteration left early
// (break, return, throw, or an abandoned iterator once collected) finalizes its
// statement, and a nested query() of SQL still mid-iteration gets another
// statement instead of resetting the outer loop. A caller that reuses one
// statement across early exits holds its own db.prepare().
type LiveStatement = Statement & { readonly isFinalized: boolean };
type Iterate = (this: LiveStatement, ...params: unknown[]) => IterableIterator<unknown>;
interface Iteration { readonly statement: LiveStatement; state: "pending" | "running" | "settled" }
interface Ownership {
  readonly prepare: Database["prepare"];
  readonly query: Database["query"];
  readonly close: Database["close"];
  /** Insertion-ordered by SQL; more than one statement only under nested iteration. */
  readonly queries: Map<string, LiveStatement[]>;
  /** Cached statements whose iterate() is wrapped, with the SQL that caches them. */
  readonly shared: WeakMap<LiveStatement, string>;
  /** Iterations in flight per cached statement. */
  readonly iterating: Map<LiveStatement, number>;
  readonly abandoned: FinalizationRegistry<Iteration>;
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

function uncache(owner: Ownership, statement: LiveStatement): void {
  const sql = owner.shared.get(statement);
  const pool = sql === undefined ? undefined : owner.queries.get(sql);
  if (sql === undefined || pool === undefined) return;
  const index = pool.indexOf(statement);
  if (index !== -1) pool.splice(index, 1);
  if (pool.length === 0) owner.queries.delete(sql);
}

function settle(owner: Ownership, iteration: Iteration, exhausted: boolean): void {
  const started = iteration.state === "running";
  iteration.state = "settled";
  owner.abandoned.unregister(iteration);
  if (!started) return;
  const { statement } = iteration;
  const left = (owner.iterating.get(statement) ?? 1) - 1;
  if (left > 0) { owner.iterating.set(statement, left); return; }
  owner.iterating.delete(statement);
  if (exhausted || statement.isFinalized) return;
  // Only finalization releases a snapshot without executing the statement again.
  uncache(owner, statement);
  statement.finalize();
}

function share(owner: Ownership, sql: string, statement: LiveStatement): void {
  if (owner.shared.has(statement)) return;
  owner.shared.set(statement, sql);
  const iterate = statement.iterate as Iterate;
  function* run(this: LiveStatement, iteration: Iteration, params: unknown[]): Generator<unknown, void, undefined> {
    iteration.state = "running";
    owner.iterating.set(this, (owner.iterating.get(this) ?? 0) + 1);
    let exhausted = false;
    try {
      yield* Reflect.apply(iterate, this, params);
      exhausted = true;
    } finally { settle(owner, iteration, exhausted); }
  }
  function sharedIterate(this: LiveStatement, ...params: unknown[]): Generator<unknown, void, undefined> {
    const iteration: Iteration = { statement: this, state: "pending" };
    const generator = Reflect.apply(run, this, [iteration, params]) as Generator<unknown, void, undefined>;
    owner.abandoned.register(generator, iteration, iteration);
    return generator;
  }
  Object.defineProperties(statement, {
    iterate: { configurable: true, enumerable: true, writable: true, value: sharedIterate },
    [Symbol.iterator]: { configurable: true, writable: true, value: function(this: LiveStatement) { return this.iterate(); } },
  });
}

/** Install before the first SQL operation. Fluent methods stay with Bun; the
 * query() cache and explicit connection closure own statement finalization. */
export function manageDatabaseLifetime(db: Database): Database {
  if (ownership.has(db)) return db;
  const statements = new Set<WeakRef<LiveStatement>>();
  const state: Ownership = {
    prepare: db.prepare, query: db.query, close: db.close,
    queries: new Map(), shared: new WeakMap(), iterating: new Map(),
    // A collection callback has no caller to report to; close() finalizes anything left.
    abandoned: new FinalizationRegistry(iteration => { try { settle(state, iteration, false); } catch { /* close() retries */ } }),
    statements, seen: new WeakSet(),
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
      if (owner === undefined) return Reflect.apply(state.query, this, [sql]);
      const pool = owner.queries.get(sql);
      if (pool !== undefined) for (const cached of pool) if (!cached.isFinalized && !owner.iterating.has(cached)) return cached;
      // Bun validates, and its own query() prepares through the tracked prepare above.
      let statement = Reflect.apply(owner.query, this, [sql]) as LiveStatement;
      // Bun may return its cached statement while an outer loop still iterates it.
      if (owner.iterating.has(statement)) statement = this.prepare(sql) as LiveStatement;
      share(owner, sql, statement);
      const live = pool?.filter(cached => !cached.isFinalized) ?? [];
      live.push(statement);
      owner.queries.delete(sql);
      owner.queries.set(sql, live);
      // An evicted statement stays tracked: its holder can use it until close().
      if (owner.queries.size > QUERY_CACHE_LIMIT) owner.queries.delete(owner.queries.keys().next().value!);
      return statement;
    } },
    close: { configurable: true, writable: true, value: function close(this: Database, ...args: Parameters<Database["close"]>) {
      const owner = ownership.get(this);
      const errors: unknown[] = [];
      if (owner !== undefined) {
        owner.queries.clear();
        owner.iterating.clear();
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
