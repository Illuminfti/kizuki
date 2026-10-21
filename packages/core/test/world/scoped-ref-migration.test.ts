import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { ensureLedgerSchema, openLedger } from "../../src/ledger/db";
import { assertLedgerSchema } from "../../src/ledger/integrity";
import { serveWorldView } from "../../src/serving/world-view";
import { TYPED_REF_TABLE_SPECS, applyTypedRefs } from "../../src/world/tables/refs";
import { WORLD_MIGRATION_VERSIONS } from "../../src/world/tables/versions";
import { worldSeed } from "../helpers/world-seed";
import { tempVault } from "../helpers/vault";

/** Retain the actual FCST predecessor and its authority tables, removing only
 * this migration's children and reverting its parent's closed kind CHECK. */
function predecessor(db: Database): void {
  const names = TYPED_REF_TABLE_SPECS.map(spec => spec.name);
  db.exec("PRAGMA foreign_keys=OFF");
  try { db.transaction(() => {
    for (const { name, sql } of db.query<{ name: string; sql: string }, []>("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all()) {
      if (names.some(table => sql.includes(table))) db.exec(`DROP TRIGGER ${name}`);
    }
    for (const name of [...names].reverse()) db.exec(`DROP TABLE ${name}`);
    const triggers = db.query<{ name: string; sql: string }, []>("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND instr(sql,'world_wire_refs')>0").all();
    for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
    const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='world_wire_refs'").get()!.sql;
    const prior = sql.replace("world_wire_refs", "world_wire_refs_prior").replace(/ref_kind IN \([^)]*\)/, "ref_kind IN ('object','claim','admission','event_version','principal')");
    db.exec(prior);
    db.exec("INSERT INTO world_wire_refs_prior SELECT * FROM world_wire_refs WHERE ref_kind IN ('object','claim','admission','event_version','principal'); DROP TABLE world_wire_refs; ALTER TABLE world_wire_refs_prior RENAME TO world_wire_refs");
    for (const { sql } of triggers) db.exec(sql);
    db.query("UPDATE schema_version SET version=?").run(WORLD_MIGRATION_VERSIONS.fcst);
  }).immediate(); } finally { db.exec("PRAGMA foreign_keys=ON"); }
  assertLedgerSchema(db, WORLD_MIGRATION_VERSIONS.fcst);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}
async function fixture() {
  const vault = tempVault("kizuki-refs-migration-"), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const seed = await worldSeed(db);
  const ctx = { ...seed.ctx, vaultPath: vault.path };
  const request = { operation: "concept", concept: seed.ref!, valid: { kind: "all" }, knownAt: { kind: "current" } };
  serveWorldView(ctx, request);
  const retained = db.query("SELECT * FROM world_wire_refs ORDER BY namespace_id,wire_ref").all();
  predecessor(db);
  return { db, vault, ctx, request, retained, dispose() { db.close(); vault.dispose(); } };
}

test("actual predecessor upgrade preserves issued references and backfills only recorded support admissions", async () => {
  const f = await fixture(); try {
    const history = f.db.query<{ claim_id: string; support_key: string; sequence: number; recorded_at: string }, []>("SELECT claim_id,support_key,sequence,recorded_at FROM claim_lifecycle_history WHERE support_key IS NOT NULL").all();
    const missing = history[0]!;
    // Simulate the legitimate retained baseline of a pre-history admission:
    // advance coverage first, retaining only the present state, never inventing
    // a recorded position for the old support.
    f.db.transaction(() => {
      f.db.exec("UPDATE claim_history_clock SET last_sequence=last_sequence+1");
      const clock = f.db.query<{ last_sequence: number; last_recorded_at: string }, []>("SELECT * FROM claim_history_clock").get()!;
      f.db.query("UPDATE claim_history_coverage SET coverage='baseline_only',complete_from_sequence=? WHERE claim_id=?").run(clock.last_sequence, missing.claim_id);
      f.db.query("INSERT INTO claim_lifecycle_history(claim_id,sequence,recorded_at,after_status) SELECT claim_id,?,?,status FROM claims WHERE claim_id=?").run(clock.last_sequence, clock.last_recorded_at, missing.claim_id);
      f.db.query("DELETE FROM claim_lifecycle_history WHERE claim_id=? AND sequence<?").run(missing.claim_id, clock.last_sequence);
    }).immediate();
    ensureLedgerSchema(f.db);
    expect(f.db.query("SELECT * FROM world_wire_refs ORDER BY namespace_id,wire_ref").all()).toEqual(f.retained);
    const observations = f.db.query<{ support_key: string; record: string }, []>("SELECT support_key,record FROM world_observations").all();
    expect(observations.length).toBe(history.length - 1);
    expect(observations.some(row => row.support_key === missing.support_key)).toBe(false);
    for (const row of observations) {
      const at = history.find(item => item.support_key === row.support_key)!;
      expect(JSON.parse(row.record).recorded).toEqual({ admittedAt: at.recorded_at, admissionSeq: at.sequence });
    }
    expect(serveWorldView(f.ctx, f.request).data).not.toEqual({ status: "not_found" });
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  } finally { f.dispose(); }
}, 120_000);

test("typed parent rebuild and observation backfill roll back together", async () => {
  const f = await fixture(); try {
    const schema = f.db.query("SELECT name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name").all();
    f.db.exec("PRAGMA foreign_keys=OFF");
    try {
      expect(() => f.db.transaction(() => { applyTypedRefs(f.db); throw Error("fixture migration boundary"); }).immediate()).toThrow("fixture migration boundary");
    } finally { f.db.exec("PRAGMA foreign_keys=ON"); }
    expect(f.db.query("SELECT name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name").all()).toEqual(schema);
    expect(f.db.query("SELECT * FROM world_wire_refs ORDER BY namespace_id,wire_ref").all()).toEqual(f.retained);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    ensureLedgerSchema(f.db);
    expect(f.db.query("SELECT count(*) n FROM world_observations").get()).not.toEqual({ n: 0 });
  } finally { f.dispose(); }
}, 120_000);
