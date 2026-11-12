import type { Database } from "bun:sqlite";
import { oneShotAll } from "../ledger/schema";

/**
 * A counter that every write to a page proof's inputs advances, in the same
 * transaction as the write. SQLite triggers carry it, so it holds for every
 * writer of the file: this build, an older build, a migration, a repair
 * script. Any INSERT, UPDATE or DELETE on one of these tables fires at least
 * one of its three triggers, including rows that a foreign key action or
 * REPLACE removes, an UPSERT, and a whole-table DELETE (SQLite skips its
 * truncate shortcut on a table with triggers). A rolled back write rolls the
 * counter back with it. Creating, dropping or altering any schema object
 * moves `schema_version`, and the counter's random token changes if its table
 * is ever dropped and created again, so neither can repeat an earlier key.
 *
 * Two readings with the same token, schema version and epoch therefore see
 * the same rows in every table listed here. A proof whose every statement
 * reads only these tables (see `proofStatementSafe`) has the same result at
 * both readings.
 */
export const READ_PROOF_TABLES = [
  "canon_holds", "canon_projection_obligations", "canon_read_generation", "canon_receipts",
  "canon_source_survivor_lineage", "canon_write_intents", "claim_v2_semantics", "claim_v2_support",
  "claim_v2_support_events", "claims", "event_classes", "event_purges", "events", "native_owner_evidence",
  "purge_batches", "semantic_allocations", "semantic_bindings", "source_event_bindings",
  "source_grant_receipts", "source_grants", "source_retrieval_stores", "source_store_inventory",
] as const;

const OPERATIONS = ["insert", "update", "delete"] as const;
type Operation = (typeof OPERATIONS)[number];

function triggerName(table: string, operation: Operation): string {
  return `read_proof_epoch_${table}_${operation}`;
}

function triggerSql(table: string, operation: Operation): string {
  return `CREATE TRIGGER ${triggerName(table, operation)} AFTER ${operation.toUpperCase()} ON ${table} BEGIN UPDATE read_proof_epoch SET epoch = epoch + 1 WHERE id = 1; END`;
}

function objectExists(db: Database, type: "table" | "trigger", name: string): boolean {
  return oneShotAll(db, "SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?", type, name).length > 0;
}

/**
 * Derived and idempotent, like the search tables: a writable open creates the
 * counter and the triggers of the listed tables that exist. Only read-proof
 * reuse reads the counter, and it treats a missing or altered trigger as
 * "cannot prove freshness" and proves every page again.
 */
export function ensureReadProofEpoch(db: Database): void {
  db.transaction(() => {
    if (!objectExists(db, "table", "read_proof_epoch")) {
      db.exec(`CREATE TABLE read_proof_epoch (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token TEXT NOT NULL,
        epoch INTEGER NOT NULL
      ) STRICT`);
      db.exec("INSERT INTO read_proof_epoch (id, token, epoch) VALUES (1, lower(hex(randomblob(16))), 0)");
    }
    for (const table of READ_PROOF_TABLES) {
      if (!objectExists(db, "table", table)) continue;
      for (const operation of OPERATIONS) {
        const name = triggerName(table, operation), sql = triggerSql(table, operation);
        const found = oneShotAll<{ tbl_name: string; sql: string | null }>(db, "SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?", name)[0];
        if (found !== undefined && found.tbl_name === table && found.sql === sql) continue;
        // A renamed table carries its triggers along; put each back on the table it names.
        if (found !== undefined) db.exec(`DROP TRIGGER ${name}`);
        db.exec(sql);
      }
    }
  }).immediate();
}

export interface ReadProofEpoch {
  readonly token: string;
  readonly schema: number;
  readonly epoch: number;
}

interface SchemaFacts {
  schema: number;
  /** Listed tables whose three triggers exist exactly as written above. */
  guarded: Set<string>;
  /** Root page to table name, for reading EXPLAIN. */
  roots: Map<number, string>;
  /** Views and virtual tables: a statement that names one is not judged. */
  opaque: string[];
  verdicts: Map<string, boolean>;
}
const facts = new WeakMap<Database, SchemaFacts>();
const MAX_VERDICTS = 4096;

function schemaVersion(db: Database): number {
  return oneShotAll<{ schema_version: number }>(db, "PRAGMA schema_version")[0]!.schema_version;
}

/** Every statement here is prepared and finalized: a cached EXPLAIN keeps its read snapshot open. */
function schemaFacts(db: Database, schema: number): SchemaFacts {
  const known = facts.get(db);
  if (known?.schema === schema) return known;
  const objects = oneShotAll<{ type: string; name: string; tbl_name: string; rootpage: number | null; sql: string | null }>(
    db, "SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema",
  );
  // The catalog describes `schema` only if the version did not move around the read.
  const stable = schemaVersion(db) === schema;
  const triggers = new Map(objects.filter(row => row.type === "trigger").map(row => [row.name, row]));
  const guarded = new Set<string>();
  for (const table of stable ? READ_PROOF_TABLES : []) {
    if (OPERATIONS.every(operation => {
      const trigger = triggers.get(triggerName(table, operation));
      return trigger !== undefined && trigger.tbl_name === table && trigger.sql === triggerSql(table, operation);
    })) guarded.add(table);
  }
  const roots = new Map<number, string>([[1, "sqlite_schema"]]);
  for (const row of objects) if (row.rootpage !== null && row.rootpage > 0) roots.set(row.rootpage, row.tbl_name);
  const opaque = objects
    .filter(row => row.type === "view" || (row.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? "")))
    .map(row => row.name.toLowerCase());
  const created: SchemaFacts = { schema, guarded, roots, opaque, verdicts: new Map() };
  facts.set(db, created);
  return created;
}

/** The counter, or null when it cannot vouch for anything. */
export function readProofEpoch(db: Database): ReadProofEpoch | null {
  if (db.inTransaction) return null;
  const schema = schemaVersion(db);
  if (schemaFacts(db, schema).guarded.size === 0 || !objectExists(db, "table", "read_proof_epoch")) return null;
  const row = oneShotAll<{ token: unknown; epoch: unknown }>(db, "SELECT token, epoch FROM read_proof_epoch WHERE id = 1")[0];
  if (row === undefined || typeof row.token !== "string" || typeof row.epoch !== "number" || !Number.isSafeInteger(row.epoch)) return null;
  return { token: row.token, schema, epoch: row.epoch };
}

/**
 * Statements whose value is a cache guard, never a proof input: the event
 * row memo compares them to decide whether to validate a row again, and a
 * validation it skips returns what validation would (event-record.ts).
 */
const GUARD_STATEMENTS = new Set([
  "SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version",
]);

/** Values that change without a row changing. */
const VOLATILE = /\b(random|randomblob|changes|total_changes|last_insert_rowid|data_version|sqlite_offset|julianday|datetime|date|time|strftime|unixepoch|current_date|current_time|current_timestamp)\b|'now'/i;
const WRITES = new Set(["OpenWrite", "Destroy", "Clear", "VUpdate", "ParseSchema", "CreateBtree", "DropTable", "DropIndex", "DropTrigger"]);

/**
 * True only when the statement reads nothing but guarded tables and the
 * schema, writes nothing, and computes nothing volatile. Judged from SQLite's
 * own program (EXPLAIN), so a join, subquery, CTE or index the text hides is
 * still seen. A statement naming a view or virtual table is refused, because
 * its program opens those by handle rather than by root page. Table-valued
 * functions such as json_each and pragma_* read only their arguments and the
 * schema, and the schema version is part of every key.
 */
export function proofStatementSafe(db: Database, sql: string, schema: number): boolean {
  const known = facts.get(db)?.schema === schema ? facts.get(db)! : schemaFacts(db, schemaVersion(db));
  // A schema that moved since the epoch was read vouches for nothing read under it.
  if (known.schema !== schema) return false;
  const cached = known.verdicts.get(sql);
  if (cached !== undefined) return cached;
  let safe = GUARD_STATEMENTS.has(sql);
  if (!safe && !VOLATILE.test(sql)) {
    const words = new Set(sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []);
    safe = !known.opaque.some(name => words.has(name));
    if (safe) {
      try {
        for (const op of oneShotAll<{ opcode: string; p2: number; p3: number }>(db, `EXPLAIN ${sql}`)) {
          if (WRITES.has(op.opcode)) { safe = false; break; }
          if (op.opcode === "OpenRead" || op.opcode === "ReopenIdx") {
            const table = op.p3 === 0 ? known.roots.get(op.p2) : undefined;
            if (table === undefined || (table !== "sqlite_schema" && !known.guarded.has(table))) { safe = false; break; }
          }
        }
      } catch {
        safe = false;
      }
      // Root pages name tables only under the schema the facts were read from.
      if (schemaVersion(db) !== known.schema) return false;
    }
  }
  if (known.verdicts.size < MAX_VERDICTS) known.verdicts.set(sql, safe);
  return safe;
}
