import { afterEach, expect, test } from "bun:test";
import { Database, constants } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { historicalRecoveryInput, HISTORICAL_RECOVERY_INPUTS, inspectRecoveryFixture, NATIVE_RECOVERY_PHASE_IDS } from "./native-recovery-fixtures";
import { openLedger } from "../packages/core/src/ledger/db";
import { manageDatabaseLifetime } from "../packages/core/src/ledger/lifetime";
import { configureLedgerWalLifecycle } from "../packages/core/src/ledger/wal-lifecycle";

const roots:string[]=[];
afterEach(()=>{ for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function fixture(id="ledger15"): {vault:string;path:string} {
  const vault=mkdtempSync(join(realpathSync(tmpdir()),"kizuki-recovery-input-")); roots.push(vault); chmodSync(vault,0o700);
  mkdirSync(join(vault,".kizuki"),{mode:0o700}); const path=join(vault,".kizuki/kizuki.db"); writeFileSync(path,"",{mode:0o600});
  const db=manageDatabaseLifetime(new Database(path,constants.SQLITE_OPEN_READWRITE|constants.SQLITE_OPEN_NOFOLLOW));
  try { configureLedgerWalLifecycle(db,path); db.exec(historicalRecoveryInput(id).bytes.toString()); } finally {db.close();}
  return {vault,path};
}
function change(path:string,sql:string):void {const db=manageDatabaseLifetime(new Database(path,constants.SQLITE_OPEN_READWRITE|constants.SQLITE_OPEN_NOFOLLOW));try{configureLedgerWalLifecycle(db,path);db.exec(sql);}finally{db.close();}}

test("historical registry binds four genuine writer inputs and six distinct native phases",()=>{
 expect(HISTORICAL_RECOVERY_INPUTS).toHaveLength(4); expect(new Set(NATIVE_RECOVERY_PHASE_IDS).size).toBe(6);
 for(const row of HISTORICAL_RECOVERY_INPUTS){expect(historicalRecoveryInput(row.id).identity).toEqual(row);expect(row.writer_bun).toBe("1.3.10");expect(row.writer_commit).toMatch(/^[a-f0-9]{40}$/);}
 expect(()=>historicalRecoveryInput("constructed-ledger1")).toThrow("unknown-historical-input");
});
for(const id of ["ledger15","ledger16"]) test(`managed ${id} observation is nonmutating and migration preserves all original event and claim columns`,()=>{
 const {vault,path}=fixture(id),before=inspectRecoveryFixture(vault);expect(inspectRecoveryFixture(vault)).toEqual(before);
 const db=openLedger(path);db.close();const after=inspectRecoveryFixture(vault);expect(after.summary.schema_version).toBe(21);
 for(const table of ["events","claims"]){const prior=before.tables[table]??[];expect(after.tables[table]).toHaveLength(prior.length);for(const row of prior){const key=table==="events"?"event_id":"claim_id";const next=after.tables[table]!.find(value=>value[key]===row[key]);for(const field of Object.keys(row))expect(next?.[field]).toEqual(row[field]);}}
});
test("invalid historical text is rejected before completion and leaves every original row and schema object unchanged",()=>{
 const {vault,path}=fixture();change(path,"UPDATE events SET text='Synthetic invalid old event text.'");const before=inspectRecoveryFixture(vault);
 expect(()=>openLedger(path)).toThrow();expect(inspectRecoveryFixture(vault)).toEqual(before);expect(before.summary.schema_version).toBe(15);
});
test("collision reaches the actual final v21 CREATE after intermediate migrations then atomically restores all old rows and schema",()=>{
 const {vault,path}=fixture();change(path,"CREATE TABLE canon_projection_sources (synthetic_collision TEXT NOT NULL); INSERT INTO canon_projection_sources VALUES ('fixture')");const before=inspectRecoveryFixture(vault);
 const original=Database.prototype.exec;let observed:{version:number;earlier:boolean;new_columns:boolean}|null=null;
 Database.prototype.exec=function(sql:string){if(/^\s*CREATE TABLE canon_projection_sources\b/.test(sql)){observed={version:(this.query("SELECT version FROM schema_version").get() as {version:number}).version,earlier:this.query("SELECT name FROM sqlite_master WHERE name='canon_write_intents'").get()!==null,new_columns:this.query<{name:string},[]>("PRAGMA table_info(events)").all().some(row=>row.name==="text_hash")};}return original.call(this,sql);};
 try{expect(()=>openLedger(path)).toThrow("canon_projection_sources");}finally{Database.prototype.exec=original;}
 expect(observed).toEqual({version:20,earlier:true,new_columns:true});expect(inspectRecoveryFixture(vault)).toEqual(before);
});
test("unsafe ledger alias is refused without changing the outside fixture",async()=>{
 const {vault,path}=fixture(),outside=fixture();const {unlinkSync,symlinkSync}=await import("node:fs");const before=inspectRecoveryFixture(outside.vault);unlinkSync(path);symlinkSync(outside.path,path);expect(()=>inspectRecoveryFixture(vault)).toThrow();expect(inspectRecoveryFixture(outside.vault)).toEqual(before);
});
