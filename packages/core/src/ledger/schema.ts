import type { Database } from "bun:sqlite";

type SqlValue = string | number | boolean | bigint | null;

/**
 * Cached: one SQL string, used on the hot path. The table-valued pragma looks
 * the name up directly where a filter on sqlite_master reads every schema row;
 * the filters keep the answer that query gave: main schema only, exact name,
 * virtual and shadow tables included, views and the schema table excluded.
 */
export function tableExists(db: Database, name: string): boolean {
  return db
    .query<{ name: string }, [string]>(
      "SELECT name FROM pragma_table_list(?1) WHERE schema = 'main' AND name = ?1 AND type <> 'view' AND name <> 'sqlite_schema'",
    )
    .get(name) !== null;
}

/** Prepare, read one row, finalize. Migrate/assert SQL must not fill Bun's query cache. */
export function oneShotGet<Row>(
  db: Database,
  sql: string,
  ...params: SqlValue[]
): Row | null {
  const statement = db.prepare(sql);
  try {
    return (statement.get(...params) as Row | null | undefined) ?? null;
  } finally {
    statement.finalize();
  }
}

/** Prepare, read every row, finalize. Same cache rule as `oneShotGet`. */
export function oneShotAll<Row>(
  db: Database,
  sql: string,
  ...params: SqlValue[]
): Row[] {
  const statement = db.prepare(sql);
  try {
    return statement.all(...params) as Row[];
  } finally {
    statement.finalize();
  }
}

/** Prepare, write, finalize. Same cache rule as `oneShotGet`. */
export function oneShotRun(
  db: Database,
  sql: string,
  ...params: SqlValue[]
): void {
  const statement = db.prepare(sql);
  try {
    statement.run(...params);
  } finally {
    statement.finalize();
  }
}

export function tableColumns(db: Database, table: string): string[] {
  return oneShotAll<{ name: string }>(
    db,
    "SELECT name FROM pragma_table_info(?) ORDER BY cid",
    table,
  ).map(({ name }) => name);
}
