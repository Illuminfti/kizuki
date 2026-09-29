import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import { assertLedgerSchema } from "../../src/ledger/integrity";
import {
  WORLD_TABLE_SPECS,
  assertWorldTableSchema,
  registerWorldTableSpecs,
  worldTableSpecs,
  type WorldTableSpec,
} from "../../src/world/tables/registry";
import {
  WORLD_MIGRATION_BASE,
  WORLD_MIGRATION_VERSIONS,
  WORLD_SLOT_KEYS,
} from "../../src/world/tables/versions";

const ROOT = join(import.meta.dir, "../../../..");
const TABLES_DIR = join(ROOT, "packages/core/src/world/tables");
const disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
});

function slotMarkers(path: string): string[] {
  return [
    ...readFileSync(path, "utf8").matchAll(/^\s*\/\/ slot: (\w+)\s*$/gm),
  ].map((match) => match[1]!);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("migration numbers", () => {
  test("are unique and contiguous from the base, and the ledger ends where they end", () => {
    const numbers = Object.values<number>(WORLD_MIGRATION_VERSIONS).sort(
      (a, b) => a - b,
    );
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual(
      numbers.map((_, index) => WORLD_MIGRATION_BASE + 1 + index),
    );
    expect(LEDGER_SCHEMA_VERSION).toBe(WORLD_MIGRATION_BASE + numbers.length);
  });

  test("belong to a known slot key", () => {
    for (const key of Object.keys(WORLD_MIGRATION_VERSIONS))
      expect(WORLD_SLOT_KEYS).toContain(key as never);
  });

  test("every table past the base names a claimed migration", () => {
    const claimed = new Set<number>(Object.values(WORLD_MIGRATION_VERSIONS));
    for (const spec of WORLD_TABLE_SPECS) {
      if (spec.since > WORLD_MIGRATION_BASE)
        expect(claimed.has(spec.since)).toBe(true);
    }
  });

  test("appear as numeric literals only in versions.ts", () => {
    const literal = /(?:\bledger|\bmigration|\bsince|\bversion|SCHEMA_VERSION)\b\W{1,12}(?:3[4-9]|[4-9]\d)\b/i;
    const offenders: string[] = [];
    for (const directory of ["packages", "scripts"]) {
      for (const path of sourceFiles(join(ROOT, directory))) {
        const relPath = relative(ROOT, path);
        if (
          relPath.includes("/test/") ||
          relPath.endsWith("world/tables/versions.ts")
        )
          continue;
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (literal.test(line)) offenders.push(`${relPath}:${index + 1}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("slot markers", () => {
  const keys = [...WORLD_SLOT_KEYS].sort();

  test("versions.ts carries every slot key exactly once", () => {
    expect(slotMarkers(join(TABLES_DIR, "versions.ts")).sort()).toEqual(keys);
  });

  test("registry.ts carries every slot key exactly once", () => {
    expect(slotMarkers(join(TABLES_DIR, "registry.ts")).sort()).toEqual(keys);
  });
});

describe("registry", () => {
  test("names are unique and every table declares a class", () => {
    const names = worldTableSpecs().map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of worldTableSpecs())
      expect(["authority", "bookkeeping", "derived", "cache"]).toContain(
        spec.class,
      );
  });

  test("a duplicate registration is refused", () => {
    const spec: WorldTableSpec = { ...worldTableSpecs()[0]! };
    expect(() => registerWorldTableSpecs([spec])).toThrow("already registered");
  });
});

describe("world table integrity", () => {
  const next = WORLD_MIGRATION_BASE + 1;
  const spec = (overrides: Partial<WorldTableSpec> = {}): WorldTableSpec => ({
    name: "world_synth_rows",
    class: "derived",
    since: next,
    columns: ["event_id", "note"],
    erasure: { via: "cascade", parent: "events" },
    create: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS world_synth_rows(
      event_id TEXT PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE, note TEXT NOT NULL) STRICT`),
    ...overrides,
  });

  test("the current ledger passes and a spec past its version is not required yet", () => {
    const db = openLedger(":memory:");
    disposers.push(() => db.close());
    disposers.push(registerWorldTableSpecs([spec()]));
    expect(() => assertLedgerSchema(db, LEDGER_SCHEMA_VERSION)).not.toThrow();
  });

  test("a missing table, a missing column, a missing foreign key and a missing trigger are corrupt", () => {
    const db = openLedger(":memory:");
    disposers.push(() => db.close());
    disposers.push(registerWorldTableSpecs([spec()]));
    expect(() => assertWorldTableSchema(db, next)).toThrow(
      "world storage missing world_synth_rows",
    );
    db.exec("CREATE TABLE world_synth_rows(event_id TEXT PRIMARY KEY) STRICT");
    expect(() => assertWorldTableSchema(db, next)).toThrow(
      "world storage missing world_synth_rows",
    );
    db.exec(
      "DROP TABLE world_synth_rows; CREATE TABLE world_synth_rows(event_id TEXT PRIMARY KEY, note TEXT) STRICT",
    );
    expect(() => assertWorldTableSchema(db, next)).toThrow(
      "world storage erasure missing for world_synth_rows",
    );
    db.exec("DROP TABLE world_synth_rows");
    spec().create!(db);
    expect(() => assertWorldTableSchema(db, next)).not.toThrow();
    disposers.pop()!();
    disposers.push(
      registerWorldTableSpecs([
        spec({
          erasure: { via: "trigger", triggers: ["world_synth_rows_erased"] },
        }),
      ]),
    );
    expect(() => assertWorldTableSchema(db, next)).toThrow(
      "world storage erasure missing for world_synth_rows",
    );
    db.exec(
      "CREATE TRIGGER world_synth_rows_erased AFTER DELETE ON events BEGIN DELETE FROM world_synth_rows WHERE event_id=OLD.event_id; END",
    );
    expect(() => assertWorldTableSchema(db, next)).not.toThrow();
  });
});
