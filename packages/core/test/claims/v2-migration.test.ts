import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedger } from "../../src/ledger/db";
import { historicalLedger, legacyClaim } from "./v2-fixtures";

function fixture(run: (path: string) => void): void {
  const dir=mkdtempSync(join(tmpdir(),"kizuki-rich-migration-"));
  try { run(join(dir,"ledger.sqlite")); } finally { rmSync(dir,{recursive:true,force:true}); }
}
const tables=["claim_v2_semantics","claim_v2_support","claim_v2_support_events",
  "claim_v2_support_anchors","claim_occurrences","claim_history"];
describe("rich claims migration through openLedger",()=>{
  test("fresh database installs one claims store and bounded children",()=>{
    const db=openLedger(":memory:");
    try {
      expect(db.query("SELECT version FROM schema_version").get()).toEqual({version:17});
      for(const name of tables) expect(db.query("SELECT name FROM sqlite_master WHERE name=?").get(name)).not.toBeNull();
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({foreign_keys:1});
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });
  for(let version=2;version<=16;version++) test(`upgrades real historical schema ${version}`,()=>fixture(path=>{
    const old=historicalLedger(path,version); old.close();
    const db=openLedger(path);
    try { expect(db.query("SELECT version FROM schema_version").get()).toEqual({version:17});
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  }));
  test("preserves every v1 value and relationship with an honest upgrade baseline",()=>fixture(path=>{
    const old=historicalLedger(path); legacyClaim(old);
    old.exec(`CREATE TABLE fixture_claim_ref(id TEXT PRIMARY KEY, claim_id TEXT REFERENCES claims(claim_id));
      INSERT INTO fixture_claim_ref VALUES('ref','legacy-claim');
      INSERT INTO claim_supersessions VALUES('winner','legacy-claim','R5',NULL,'legacy-receipt','2026-01-03T00:00:00Z');
      INSERT INTO claim_bindings VALUES('${"b".repeat(64)}','fact:test','2026-01-03T00:00:00Z');`);
    const snapshot=old.query("SELECT * FROM claims").get() as Record<string,unknown>;
    const relationships=old.query("SELECT * FROM claim_supersessions").all(); old.close();
    const db=openLedger(path);
    try {
      expect(db.query("SELECT * FROM claims").get()).toMatchObject(snapshot);
      expect(db.query("SELECT * FROM claim_supersessions").all()).toEqual(relationships);
      expect(db.query("SELECT * FROM fixture_claim_ref").all()).toEqual([{id:"ref",claim_id:"legacy-claim"}]);
      expect(db.query("SELECT operation FROM claim_history").all()).toEqual([{operation:"upgrade_baseline"}]);
      expect(db.query("SELECT count(*) AS n FROM claim_v2_support").get()).toEqual({n:0});
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  }));
  test("preserves null, bare legacy and exact atomic extraction bytes",()=>{
    for(const integrity of [null,"a".repeat(64),`atomic-v1:${"a".repeat(64)}`]) fixture(path=>{
      const old=historicalLedger(path);
      old.query(`INSERT INTO extract_batches(previous_cursor,cursor,drafts,created_at,integrity)
        VALUES('previous','cursor',' [ ] ','2026-01-01T00:00:00Z',?)`).run(integrity); old.close();
      const db=openLedger(path);
      try { expect(db.query("SELECT drafts,integrity,producer_contract,draft_schema,integrity_version FROM extract_batches").get()).toEqual({drafts:" [ ] ",integrity,
        producer_contract:"kizuki.producer/v1",draft_schema:"kizuki.claim-draft/v1",
        integrity_version:integrity?.startsWith("atomic-v1:")?"atomic-v1":"legacy-v1"});
      } finally { db.close(); }
    });
  });
  for(const malformed of ["not json",'"wrong shape"',"["+" ".repeat(262145)+"]"]) test(`refuses malformed/oversized v1 JSON (${malformed.length}) before committing`,()=>fixture(path=>{
    const old=historicalLedger(path); legacyClaim(old);
    old.query("UPDATE claims SET provenance=?").run(malformed);
    const snapshot=old.query("SELECT * FROM claims").get(); old.close();
    expect(()=>openLedger(path)).toThrow("stored claim is invalid");
    const unchanged=new Database(path);
    try {
      expect(unchanged.query("SELECT version FROM schema_version").get()).toEqual({version:16});
      expect(unchanged.query("SELECT * FROM claims").get()).toEqual(snapshot);
      expect(unchanged.query("SELECT name FROM sqlite_master WHERE name='claim_history'").get()).toBeNull();
    } finally { unchanged.close(); }
  }));
  test("copy/index failure rolls back schema, rows and versions",()=>fixture(path=>{
    const old=historicalLedger(path); legacyClaim(old);
    old.exec("CREATE TABLE claim_history(collision TEXT)"); old.close();
    expect(()=>openLedger(path)).toThrow();
    const unchanged=new Database(path);
    try {
      expect(unchanged.query("SELECT version FROM schema_version").get()).toEqual({version:16});
      expect(unchanged.query("SELECT claim_id FROM claims").all()).toEqual([{claim_id:"legacy-claim"}]);
      expect(unchanged.query("SELECT name FROM pragma_table_info('claims') WHERE name='claim_schema'").get()).toBeNull();
    } finally { unchanged.close(); }
  }));
});
