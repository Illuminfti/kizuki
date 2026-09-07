import type { Database, Statement } from "bun:sqlite";

// Bun 1.3.14 closes its query cache and transaction statements, but uncached
// prepares can otherwise keep sqlite3_close_v2's connection alive until GC.
type LiveStatement = Statement & { readonly isFinalized: boolean };
interface Ownership {
  readonly prepare: Database["prepare"];
  readonly close: Database["close"];
  readonly statements: Set<WeakRef<LiveStatement>>;
  readonly seen: WeakSet<LiveStatement>;
  readonly collected: FinalizationRegistry<WeakRef<LiveStatement>>;
}
const ownership = new WeakMap<Database, Ownership>();

/** Install before the first SQL operation. Statement/cache identity and fluent
 * methods stay with Bun; only explicit connection closure owns finalization. */
export function manageDatabaseLifetime(db: Database): Database {
  if (ownership.has(db)) return db;
  const statements = new Set<WeakRef<LiveStatement>>();
  const state: Ownership = {
    prepare: db.prepare, close: db.close, statements, seen: new WeakSet(),
    collected: new FinalizationRegistry(reference => { statements.delete(reference); }),
  };
  ownership.set(db, state);
  Object.defineProperties(db, {
    prepare: { configurable: true, writable: true, value: function prepare(this: Database, ...args: Parameters<Database["prepare"]>) {
      const owner = ownership.get(this);
      const statement = Reflect.apply(owner?.prepare ?? state.prepare, this, args) as LiveStatement;
      if (owner !== undefined && !owner.seen.has(statement)) {
        owner.seen.add(statement);
        const reference = new WeakRef(statement);
        owner.statements.add(reference);
        owner.collected.register(statement, reference, statement);
      }
      return statement;
    } },
    close: { configurable: true, writable: true, value: function close(this: Database, ...args: Parameters<Database["close"]>) {
      const owner = ownership.get(this);
      const errors: unknown[] = [];
      if (owner !== undefined) for (const reference of owner.statements) {
        const statement = reference.deref();
        if (statement === undefined) { owner.statements.delete(reference); continue; }
        try {
          if (!statement.isFinalized) statement.finalize();
          if (!statement.isFinalized) throw new Error("database statement did not finalize");
          owner.statements.delete(reference);
          owner.collected.unregister(statement);
        } catch (error) { errors.push(error); }
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
