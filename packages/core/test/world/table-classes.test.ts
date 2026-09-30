import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportVault,
  restoreVault,
  verifyBackup,
  type ExportManifest,
} from "../../src/export";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import { WORLD_MIGRATION_BASE } from "../../src/world/tables/versions";
import { accept } from "../../src/ledger/ledger";
import { runPurge } from "../../src/ledger/purge";
import { initVault } from "../../src/vault/init";
import {
  WORLD_TABLE_SPECS,
  assertErasureDeclared,
  registerWorldTableSpecs,
  type WorldTableSpec,
} from "../../src/world/tables/registry";
import { rebuildWorldLayer } from "../../src/derived";
import { validEvent } from "../fixtures";

// Export and restore each open a real vault; bound them for a loaded host.
setDefaultTimeout(60_000);

const disposers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-world-table-classes-"));
  disposers.push(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  mkdirSync(vault, { mode: 0o700 });
  initVault(vault);
  const db = openLedger(":memory:");
  disposers.push(() => db.close());
  const event = (name: string) => {
    const result = accept(db, { ...validEvent(), source_record_id: name });
    if (result.status !== "stored")
      throw new Error("fixture event was not stored");
    return result.event;
  };
  const backup = join(root, "backup");
  const restored = join(root, "restored");
  const openRestored = () => {
    const copy = openLedger(join(restored, ".kizuki", "kizuki.db"));
    disposers.push(() => copy.close());
    return copy;
  };
  return { db, vault, backup, restored, event, openRestored };
}

function register(...specs: WorldTableSpec[]): void {
  disposers.push(registerWorldTableSpecs(specs));
}

// These synthetic specs exercise class mechanics, not a claimed schema migration.
/** Rows keyed by an event, erased with the event by FK cascade. */
const cascadeTable = (
  overrides: Partial<WorldTableSpec> = {},
): WorldTableSpec => ({
  name: "world_synth_notes",
  class: "authority",
  since: WORLD_MIGRATION_BASE,
  columns: ["event_id", "note"],
  erasure: { via: "cascade", parent: "events" },
  create: (db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS world_synth_notes(
    event_id TEXT PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
    note TEXT NOT NULL) STRICT`),
  ...overrides,
});

/** Rows that name an event without a foreign key, erased by a trigger. */
const triggerTable = (): WorldTableSpec => ({
  name: "world_synth_marks",
  class: "bookkeeping",
  since: WORLD_MIGRATION_BASE,
  columns: ["mark_id", "event_ref"],
  erasure: { via: "trigger", triggers: ["world_synth_marks_erased"] },
  create: (db) =>
    db.exec(`
    CREATE TABLE IF NOT EXISTS world_synth_marks(mark_id TEXT PRIMARY KEY, event_ref TEXT NOT NULL) STRICT;
    CREATE TRIGGER IF NOT EXISTS world_synth_marks_erased AFTER DELETE ON events
    BEGIN DELETE FROM world_synth_marks WHERE event_ref=OLD.event_id; END;`),
});

const derivedTable = (): WorldTableSpec => ({
  name: "world_synth_summary",
  class: "derived",
  since: WORLD_MIGRATION_BASE,
  columns: ["subject", "summary"],
  erasure: { via: "none", reason: "rebuilt from authority" },
  create: (db) =>
    db.exec(
      "CREATE TABLE IF NOT EXISTS world_synth_summary(subject TEXT PRIMARY KEY, summary TEXT NOT NULL) STRICT",
    ),
});

const cacheTable = (): WorldTableSpec => ({
  name: "world_synth_slots",
  class: "cache",
  since: WORLD_MIGRATION_BASE,
  columns: ["slot", "token"],
  erasure: { via: "none", reason: "runtime cache" },
  create: (db) =>
    db.exec(
      "CREATE TABLE IF NOT EXISTS world_synth_slots(slot INTEGER PRIMARY KEY, token TEXT) STRICT",
    ),
  reset: (db) => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS world_synth_slots(slot INTEGER PRIMARY KEY, token TEXT) STRICT",
    );
    db.exec("DELETE FROM world_synth_slots");
    db.exec(
      "INSERT INTO world_synth_slots(slot,token) VALUES (0,NULL),(1,NULL)",
    );
  },
});

function count(db: Database, table: string): number {
  return db
    .query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`)
    .get()!.n;
}

function tableExists(db: Database, table: string): boolean {
  return (
    db
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) !== null
  );
}

function resign(
  backup: string,
  change: (manifest: ExportManifest) => void,
): void {
  const manifest = JSON.parse(
    readFileSync(join(backup, "manifest.json"), "utf8"),
  ) as ExportManifest;
  change(manifest);
  const unsigned = {
    schema: manifest.schema,
    vault_id: manifest.vault_id,
    created_at: manifest.created_at,
    schema_versions: manifest.schema_versions,
    snapshot: manifest.snapshot,
    complete: manifest.complete,
    files: Object.fromEntries(
      Object.entries(manifest.files).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    ),
  };
  const digest = new Bun.CryptoHasher("sha256")
    .update(`${JSON.stringify(unsigned, null, 2)}\n`)
    .digest("hex");
  writeFileSync(
    join(backup, "manifest.json"),
    `${JSON.stringify({ ...unsigned, manifest_sha256: digest }, null, 2)}\n`,
  );
  chmodSync(join(backup, "manifest.json"), 0o600);
}

describe("backup ledger range", () => {
  test("the accepted ledger versions come from the migration list, not a hand-written chain", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/export.ts"),
      "utf8",
    );
    const start = source.indexOf("function assertBackupFormat(");
    const body = source.slice(start, source.indexOf("\nfunction ", start + 1));
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("LEDGER_SCHEMA_VERSION");
    const literals = [...body.matchAll(/ledger\s*(?:===|==)\s*(\d+)/g)].map(
      (match) => Number(match[1]),
    );
    expect(literals.filter((version) => version >= 21)).toEqual([]);
    expect(body).not.toMatch(/\.includes\(\s*versions\.ledger\s*\)/);
    expect(body).not.toMatch(/switch\s*\(\s*versions\.ledger\s*\)/);
  });

  test("a manifest newer than the current ledger is refused before any file is read", () => {
    const f = fixture();
    exportVault(f.db, f.vault, f.backup);
    resign(f.backup, (manifest) => {
      manifest.schema_versions.ledger = LEDGER_SCHEMA_VERSION + 1;
    });
    expect(() => verifyBackup(f.backup)).toThrow(
      `backup ledger schema ${LEDGER_SCHEMA_VERSION + 1} is newer than ${LEDGER_SCHEMA_VERSION}`,
    );
    expect(() => restoreVault(f.backup, f.restored)).toThrow("is newer than");
  });

  test("the current ledger version still round trips", () => {
    const f = fixture();
    f.event("one");
    const manifest = exportVault(f.db, f.vault, f.backup);
    expect(manifest.schema_versions.ledger).toBe(LEDGER_SCHEMA_VERSION);
    restoreVault(f.backup, f.restored);
    expect(count(f.openRestored(), "events")).toBe(1);
  });
});

describe("authority and bookkeeping tables", () => {
  test("are streamed when since is at or below the ledger version and restored", () => {
    const f = fixture();
    register(cascadeTable(), triggerTable());
    for (const spec of [cascadeTable(), triggerTable()]) spec.create!(f.db);
    const one = f.event("one");
    f.db
      .query("INSERT INTO world_synth_notes(event_id,note) VALUES (?,?)")
      .run(one.event_id, "kettle");
    f.db
      .query("INSERT INTO world_synth_marks(mark_id,event_ref) VALUES ('m1',?)")
      .run(one.event_id);
    const manifest = exportVault(f.db, f.vault, f.backup);
    expect(manifest.files["world/world_synth_notes.jsonl"]?.count).toBe(1);
    expect(manifest.files["world/world_synth_marks.jsonl"]?.count).toBe(1);
    restoreVault(f.backup, f.restored);
    const copy = f.openRestored();
    expect(
      copy.query("SELECT event_id, note FROM world_synth_notes").all(),
    ).toEqual([{ event_id: one.event_id, note: "kettle" }]);
    expect(
      copy.query("SELECT mark_id, event_ref FROM world_synth_marks").all(),
    ).toEqual([{ mark_id: "m1", event_ref: one.event_id }]);
  });

  test("an older archive is not required to carry a stream for a spec whose since is above its ledger", () => {
    const f = fixture();
    f.event("one");
    exportVault(f.db, f.vault, f.backup);
    register(cascadeTable({ since: LEDGER_SCHEMA_VERSION + 1 }));
    expect(() => restoreVault(f.backup, f.restored)).not.toThrow();
    expect(count(f.openRestored(), "events")).toBe(1);
  });

  test("an archive missing the stream of a spec its ledger includes is refused", () => {
    const f = fixture();
    f.event("one");
    exportVault(f.db, f.vault, f.backup);
    register(cascadeTable());
    expect(() => restoreVault(f.backup, f.restored)).toThrow(
      "backup manifest is missing world/world_synth_notes.jsonl",
    );
  });

  test("an archive stream that no registered table names is refused", () => {
    const f = fixture();
    register(cascadeTable());
    cascadeTable().create!(f.db);
    const one = f.event("one");
    f.db
      .query("INSERT INTO world_synth_notes(event_id,note) VALUES (?,?)")
      .run(one.event_id, "kettle");
    exportVault(f.db, f.vault, f.backup);
    disposers.pop()!();
    expect(() =>
      restoreVault(f.backup, join(f.restored, "unregistered")),
    ).toThrow("world/world_synth_notes.jsonl");
  });

  test("purging an event erases their rows through the foreign key and the trigger", async () => {
    const f = fixture();
    register(cascadeTable(), triggerTable());
    for (const spec of [cascadeTable(), triggerTable()]) spec.create!(f.db);
    const one = f.event("one");
    const two = f.event("two");
    for (const event of [one, two]) {
      f.db
        .query("INSERT INTO world_synth_notes(event_id,note) VALUES (?,?)")
        .run(event.event_id, "note");
      f.db
        .query("INSERT INTO world_synth_marks(mark_id,event_ref) VALUES (?,?)")
        .run(`m-${event.event_id}`, event.event_id);
    }
    await runPurge(f.db, f.vault, { event_id: one.event_id }, "retire fixture");
    expect(f.db.query("SELECT event_id FROM world_synth_notes").all()).toEqual([
      { event_id: two.event_id },
    ]);
    expect(f.db.query("SELECT event_ref FROM world_synth_marks").all()).toEqual(
      [{ event_ref: two.event_id }],
    );
  });
});

describe("derived and cache tables", () => {
  test("are absent from the export, created empty by restore and reset to their initial state", () => {
    const f = fixture();
    register(derivedTable(), cacheTable());
    derivedTable().create!(f.db);
    cacheTable().create!(f.db);
    f.db
      .query(
        "INSERT INTO world_synth_summary(subject,summary) VALUES ('kettle','on')",
      )
      .run();
    f.db
      .query(
        "INSERT INTO world_synth_slots(slot,token) VALUES (7,'secret-view-token')",
      )
      .run();
    const one = f.event("one");
    const manifest = exportVault(f.db, f.vault, f.backup);
    expect(
      Object.keys(manifest.files).filter((path) =>
        path.startsWith("world/world_synth_"),
      ),
    ).toEqual([]);
    expect(readFileSync(join(f.backup, "manifest.json"), "utf8")).not.toContain(
      "secret-view-token",
    );
    restoreVault(f.backup, f.restored);
    const copy = f.openRestored();
    expect(tableExists(copy, "world_synth_summary")).toBe(true);
    expect(count(copy, "world_synth_summary")).toBe(0);
    expect(
      copy
        .query("SELECT slot, token FROM world_synth_slots ORDER BY slot")
        .all(),
    ).toEqual([
      { slot: 0, token: null },
      { slot: 1, token: null },
    ]);
    expect(copy.query("SELECT event_id FROM events").all()).toEqual([
      { event_id: one.event_id },
    ]);
  });
});

describe("erasure declarations", () => {
  test("every registered spec declares a purge path its class allows", () => {
    for (const spec of WORLD_TABLE_SPECS) expect(() => assertErasureDeclared(spec)).not.toThrow();
  });

  test.each(["authority", "bookkeeping"] as const)(
    "a %s table cannot opt out of purge",
    (tableClass) => {
      const spec = cascadeTable({
        class: tableClass,
        erasure: { via: "none", reason: "forgot" },
      });
      expect(() => registerWorldTableSpecs([spec])).toThrow("must declare a cascade or trigger erasure");
    },
  );

  test("purge leaves a derived or cache table declared none alone, and only rebuild clears it", async () => {
    const f = fixture();
    register(derivedTable(), cacheTable());
    derivedTable().create!(f.db);
    cacheTable().create!(f.db);
    const one = f.event("one");
    f.db.query("INSERT INTO world_synth_summary(subject,summary) VALUES ('kettle','on')").run();
    f.db.query("INSERT INTO world_synth_slots(slot,token) VALUES (7,'view-token')").run();
    await runPurge(f.db, f.vault, { event_id: one.event_id }, "retire fixture");
    expect(count(f.db, "world_synth_summary")).toBe(1);
    expect(count(f.db, "world_synth_slots")).toBe(1);
    rebuildWorldLayer(f.db);
    expect(count(f.db, "world_synth_summary")).toBe(0);
    expect(f.db.query("SELECT slot, token FROM world_synth_slots ORDER BY slot").all()).toEqual([
      { slot: 0, token: null },
      { slot: 1, token: null },
    ]);
  });
});

describe("derived tables linked by a foreign key", () => {
  const parent = (): WorldTableSpec => ({
    name: "world_synth_parent",
    class: "derived",
    since: WORLD_MIGRATION_BASE,
    columns: ["id"],
    erasure: { via: "none", reason: "rebuilt from authority" },
    create: (db) => db.exec("CREATE TABLE IF NOT EXISTS world_synth_parent(id TEXT PRIMARY KEY) STRICT"),
  });
  const child = (): WorldTableSpec => ({
    name: "world_synth_child",
    class: "derived",
    since: WORLD_MIGRATION_BASE,
    columns: ["id", "parent_id"],
    erasure: { via: "none", reason: "rebuilt from authority" },
    create: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS world_synth_child(
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES world_synth_parent(id)) STRICT`),
  });

  test("rebuild --layer world clears the child before its parent", () => {
    const f = fixture();
    register(parent(), child());
    parent().create!(f.db);
    child().create!(f.db);
    f.db.query("INSERT INTO world_synth_parent(id) VALUES ('p')").run();
    f.db.query("INSERT INTO world_synth_child(id,parent_id) VALUES ('c','p')").run();
    expect(rebuildWorldLayer(f.db).tables).toEqual(["world_synth_parent", "world_synth_child"]);
    expect(count(f.db, "world_synth_parent")).toBe(0);
    expect(count(f.db, "world_synth_child")).toBe(0);
  });

  test("restore creates both tables empty", () => {
    const f = fixture();
    register(parent(), child());
    f.event("one");
    exportVault(f.db, f.vault, f.backup);
    restoreVault(f.backup, f.restored);
    const copy = f.openRestored();
    expect(count(copy, "world_synth_parent")).toBe(0);
    expect(count(copy, "world_synth_child")).toBe(0);
  });
});
