import { expect,spyOn,test } from "bun:test";
import { Database } from "bun:sqlite";
import { openLedger } from "../../src/ledger/db";
import { ulid } from "../../src/util/ulid";
import { getCanonReceipt, getCanonReceiptRecord, getWorldCanonReceipt, parseReceiptRecordLine, rowToReceipt, type CanonReceipt, type CanonReceiptRow } from "../../src/canon/receipts";
import { insertReceiptRow, insertErasedReceiptRow, eraseReceiptRow } from "../../src/canon/store";
import { eraseWorldReceipt, isWorldCanonReceipt, parseWorldCanonReceipt, type RetainedWorldCanonReceipt } from "../../src/canon/world-receipt";
import { validateCanonIntentReceipt } from "../../src/canon/write-intent";
function receipt():CanonReceipt {
 return {receipt_id:ulid(),kind:"write",claim_ids:[ulid()],page_path:"auto/world/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md",page_action:"create",before_hash:null,after_hash:"a".repeat(64),archive_path:null,writer:"loop",producer:"model",model_ref:"fixture/model",authority:"model_inference",confidence:0.5,sensitivity:"personal",taint:"quoted",provenance:[ulid()],superseded:[],candidates:[],retrieval_ops:[],reverts:null,reverted_by:null,at:"2026-09-21T00:00:00.000Z"};
}
function typed():RetainedWorldCanonReceipt {
 const common=receipt();return {...common,schema:"kizuki.canon-receipt/v2",state:"retained",own_id_origin:"core",prior_receipt_id:null,basis:{schema:"kizuki.world-canon-basis/v1",before:null,after:[{claim_id:common.claim_ids[0]!,semantic_key:"b".repeat(64),supports:[{support_key:"c".repeat(64),admission_hash:"d".repeat(64)}]}]}};
}
test("typed retained receipt round trips exact basis through existing table and stream",()=>{
 const db=openLedger(":memory:");try {
  const input=typed();insertReceiptRow(db,input,"claim");
  expect(getCanonReceipt(db,input.receipt_id)).toEqual(input);
  expect(parseReceiptRecordLine(JSON.stringify(input))).toEqual(input);
  expect(parseWorldCanonReceipt({...input,basis:{...input.basis,after:[{...input.basis.after![0],extra:true}]}})).toBeNull();
  expect(parseWorldCanonReceipt({...input,extra:true})).toBeNull();
  const semantic={...input,basis:{...input.basis,after:input.basis.after!.map(item=>({...item,rendering:"semantic/v1" as const}))}};
  expect(parseWorldCanonReceipt(semantic)).toEqual(semantic);
  for(const rendering of [null,"unknown/v1",false])expect(parseWorldCanonReceipt({...semantic,basis:{...semantic.basis,after:semantic.basis.after.map(item=>({...item,rendering}))}})).toBeNull();
 }finally{db.close();}
});
test("typed erased receipt contains no retained payload and verifies its domain-separated integrity",()=>{
 const input=typed(),erased=eraseWorldReceipt(input.receipt_id,ulid(),input.at,input.prior_receipt_id);
 expect(parseReceiptRecordLine(JSON.stringify(erased))).toEqual(erased);
 expect(Object.keys(erased)).toEqual(["schema","state","receipt_id","prior_receipt_id","purge_receipt_id","own_id_origin","erased_at","sensitivity","integrity"]);
 expect(parseWorldCanonReceipt({...erased,integrity:"0".repeat(64)})).toBeNull();
 expect(parseWorldCanonReceipt({...erased,before_hash:input.after_hash})).toBeNull();
});
test("v1 wire and strict intent validation stay unchanged; typed history permits a real revert id",()=>{
 const db=openLedger(":memory:");try {
  const old=receipt(),wire=JSON.stringify(old);validateCanonIntentReceipt(old);insertReceiptRow(db,old,"claim");
  expect(JSON.stringify(rowToReceipt(db.query<CanonReceiptRow,[string]>("SELECT * FROM canon_receipts WHERE receipt_id=?").get(old.receipt_id)!))).toBe(wire);
  expect(getCanonReceiptRecord(db,old.receipt_id)).toEqual(old);
  const reverted={...typed(),reverted_by:ulid()};expect(parseWorldCanonReceipt(reverted)).toEqual(reverted);
  expect(()=>validateCanonIntentReceipt({...old,reverted_by:ulid()})).toThrow();
 }finally{db.close();}
});

test("erased rows round trip without old paths or hashes in storage",()=>{
 const db=openLedger(":memory:");try {
  const old=typed(),erased=eraseWorldReceipt(old.receipt_id,ulid(),old.at,old.prior_receipt_id);insertReceiptRow(db,old,"claim");
  expect(()=>eraseReceiptRow(db,eraseWorldReceipt(old.receipt_id,erased.purge_receipt_id,old.at,ulid()))).toThrow("unavailable for erasure");
  expect(getCanonReceipt(db,old.receipt_id)).toEqual(old);
  eraseReceiptRow(db,erased);
  expect(getCanonReceipt(db,old.receipt_id)).toBeNull();expect(getCanonReceiptRecord(db,old.receipt_id)).toEqual(erased);
  const row=db.query<Record<string,unknown>,[string]>("SELECT * FROM canon_receipts WHERE receipt_id=?").get(old.receipt_id)!;
  for(const key of ["page_path","before_hash","after_hash","claim_ids","provenance","world_basis","archive_path"])expect(row[key]).toBeNull();
  const another=eraseWorldReceipt(ulid(),erased.purge_receipt_id,old.at,null);insertErasedReceiptRow(db,another);expect(getCanonReceiptRecord(db,another.receipt_id)).toEqual(another);
 }finally{db.close();}
});

/** Copy a synthetic stored row into a bare table so corruption tests exercise
 * the reader, independently of the writer's corruption-prevention triggers. */
function rawReceiptDb(input:CanonReceipt, erased=false, historical=false):Database {
 const source=openLedger(":memory:");
 let row:Record<string,unknown>;
 try {
  insertReceiptRow(source,input,"claim");
  if(erased)eraseReceiptRow(source,eraseWorldReceipt(input.receipt_id,ulid(),input.at,null));
  row=source.query<Record<string,unknown>,[string]>("SELECT * FROM canon_receipts WHERE receipt_id=?").get(input.receipt_id)!;
 }finally{source.close();}
 const db=new Database(":memory:"),columns=Object.keys(row).filter(name=>!historical||!["record_codec","receipt_state"].includes(name));
 db.exec(`CREATE TABLE canon_receipts (${columns.map(name=>`"${name}" ${typeof row[name]==="number"?"REAL":"TEXT"}`).join(",")})`);
 db.query(`INSERT INTO canon_receipts VALUES (${columns.map(()=>"?").join(",")})`).run(...columns.map(name=>row[name] as string|number|null));
 return db;
}
function typedObservation(db:Database,id:string,fast:boolean):unknown {
 try {
  const found=fast?getWorldCanonReceipt(db,id):getCanonReceipt(db,id);
  return {value:found!==null&&isWorldCanonReceipt(found)?found:null};
 }catch(error){
  if(!(error instanceof Error))throw error;
  return {name:error.name,message:error.message,...("code" in error?{code:error.code}:{})};
 }
}
function sameTypedRead(db:Database,id:string):void {
 expect(typedObservation(db,id,true)).toEqual(typedObservation(db,id,false));
}

test("typed-only reads avoid legacy JSON decoding without changing the ordinary receipt reader",()=>{
 const input=receipt(),db=rawReceiptDb(input);
 try {
  const parse=spyOn(JSON,"parse");
  try {
   expect(getCanonReceipt(db,input.receipt_id)).toEqual(input);
   expect(parse).toHaveBeenCalledTimes(5);
   parse.mockClear();
   expect(getWorldCanonReceipt(db,input.receipt_id)).toBeNull();
   expect(parse).not.toHaveBeenCalled();
  }finally{parse.mockRestore();}
  for(const column of ["claim_ids","provenance","candidates","superseded","retrieval_ops"]){
   db.query(`UPDATE canon_receipts SET ${column}=?`).run("invalid synthetic JSON");
   sameTypedRead(db,input.receipt_id);
  }
 }finally{db.close();}
});

test("typed-only reads preserve legacy path, codec and erased-state failures",()=>{
 const input=receipt(),db=rawReceiptDb(input);
 try {
  for(const paths of [["../escape.md",null],["facts/okay.md","../archive.md"],["", "archive/fixture.md"],["",null],["archive/fixture.md",null]] as const){
   db.query("UPDATE canon_receipts SET page_path=?,archive_path=?").run(...paths);
   sameTypedRead(db,input.receipt_id);
  }
  db.query("UPDATE canon_receipts SET page_path=?,archive_path=NULL").run(input.page_path);
  for(const codec of ["unknown/v9",null,"v1"]){
   db.query("UPDATE canon_receipts SET record_codec=?").run(codec);
   sameTypedRead(db,input.receipt_id);
  }
  db.exec("UPDATE canon_receipts SET receipt_state='erased'");
  expect(()=>getWorldCanonReceipt(db,input.receipt_id)).toThrow("canon_receipt_invalid");
  sameTypedRead(db,input.receipt_id);
 }finally{db.close();}
});

test("typed-only reads fully validate typed basis and erased integrity on every call",()=>{
 const input=typed(),db=rawReceiptDb(input);
 try {
  expect(getWorldCanonReceipt(db,input.receipt_id)).toEqual(input);
  db.exec("UPDATE canon_receipts SET record_codec='v1'");
  expect(getWorldCanonReceipt(db,input.receipt_id)).toBeNull();
  db.exec("UPDATE canon_receipts SET record_codec='kizuki.canon-receipt/v2'");
  expect(getWorldCanonReceipt(db,input.receipt_id)).toEqual(input);
  db.exec("UPDATE canon_receipts SET world_basis='{}'");
  sameTypedRead(db,input.receipt_id);
  expect(()=>getWorldCanonReceipt(db,input.receipt_id)).toThrow("canon_receipt_invalid");
 }finally{db.close();}
 const erased=rawReceiptDb(input,true);
 try {
  expect(getWorldCanonReceipt(erased,input.receipt_id)).toBeNull();
  sameTypedRead(erased,input.receipt_id);
  erased.query("UPDATE canon_receipts SET erasure_integrity=?").run("0".repeat(64));
  sameTypedRead(erased,input.receipt_id);
  expect(()=>getWorldCanonReceipt(erased,input.receipt_id)).toThrow("canon_receipt_invalid");
 }finally{erased.close();}
});

test("typed-only reads preserve absent-table, absent-row and historical-schema behavior",()=>{
 const absent=new Database(":memory:");
 try {sameTypedRead(absent,"absent");expect(getWorldCanonReceipt(absent,"absent")).toBeNull();}finally{absent.close();}
 const input=receipt(),db=rawReceiptDb(input,false,true);
 try {
  sameTypedRead(db,"absent");
  expect(getCanonReceipt(db,input.receipt_id)).toEqual(input);
  expect(getWorldCanonReceipt(db,input.receipt_id)).toBeNull();
  db.exec("UPDATE canon_receipts SET page_path='../escape.md'");
  sameTypedRead(db,input.receipt_id);
 }finally{db.close();}
});
