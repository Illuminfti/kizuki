import type { Database } from "bun:sqlite";

type SqlValue = string | number | boolean | bigint | null;

/**
 * Each committed schema has its own `schema_version`, so an answer read at one
 * version holds for as long as the connection still reads that version. Inside
 * an explicit transaction a rolled-back change can reuse a version number, so
 * there the catalog is read every time.
 */
const knownTables = new WeakMap<Database, { version: number; tables: Map<string, boolean> }>();
const MAX_KNOWN_TABLES = 4096;

/** Cached: one SQL string, used on the hot path. */
export function tableExists(db: Database, name: string): boolean {
  if (db.inTransaction) return catalogRead(db, name).present === 1;
  const version = db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()!.schema_version;
  let known = knownTables.get(db);
  if (known?.version !== version) {
    known = { version, tables: new Map() };
    knownTables.set(db, known);
  }
  const remembered = known.tables.get(name);
  if (remembered !== undefined) return remembered;
  // The answer and its version come from one statement, so one snapshot.
  const read = catalogRead(db, name);
  if (read.version === version && known.tables.size < MAX_KNOWN_TABLES) known.tables.set(name, read.present === 1);
  return read.present === 1;
}

function catalogRead(db: Database, name: string): { version: number; present: number } {
  return db
    .query<{ version: number; present: number }, [string]>(
      "SELECT (SELECT schema_version FROM pragma_schema_version) AS version, EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?) AS present",
    )
    .get(name)!;
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
