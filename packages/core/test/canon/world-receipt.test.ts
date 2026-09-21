import { expect,test } from "bun:test";
import { openLedger } from "../../src/ledger/db";
import { ulid } from "../../src/util/ulid";
import { getCanonReceipt, getCanonReceiptRecord, parseReceiptRecordLine, rowToReceipt, type CanonReceipt, type CanonReceiptRow } from "../../src/canon/receipts";
import { insertReceiptRow, insertErasedReceiptRow, eraseReceiptRow } from "../../src/canon/store";
import { eraseWorldReceipt, parseWorldCanonReceipt, type RetainedWorldCanonReceipt } from "../../src/canon/world-receipt";
import { validateCanonIntentReceipt } from "../../src/canon/write-intent";
function receipt():CanonReceipt {
 return {receipt_id:ulid(),kind:"write",claim_ids:[ulid()],page_path:"auto/world/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md",page_action:"create",before_hash:null,after_hash:"a".repeat(64),archive_path:null,writer:"loop",producer:"model",model_ref:"fixture/model",authority:"model_inference",confidence:0.5,sensitivity:"personal",taint:"quoted",provenance:[ulid()],superseded:[],candidates:[],retrieval_ops:[],reverts:null,reverted_by:null,at:"2026-09-21T00:00:00.000Z"};
}
function typed():RetainedWorldCanonReceipt {
 const common=receipt();return {...common,schema:"kizuki.canon-receipt/v2",state:"retained",own_id_origin:"core",basis:{schema:"kizuki.world-canon-basis/v1",before:null,after:[{claim_id:common.claim_ids[0]!,semantic_key:"b".repeat(64),supports:[{support_key:"c".repeat(64),admission_hash:"d".repeat(64)}]}]}};
}
test("typed retained receipt round trips exact basis through existing table and stream",()=>{
 const db=openLedger(":memory:");try {
  const input=typed();insertReceiptRow(db,input,"claim");
  expect(getCanonReceipt(db,input.receipt_id)).toEqual(input);
  expect(parseReceiptRecordLine(JSON.stringify(input))).toEqual(input);
  expect(parseWorldCanonReceipt({...input,basis:{...input.basis,after:[{...input.basis.after![0],extra:true}]}})).toBeNull();
  expect(parseWorldCanonReceipt({...input,extra:true})).toBeNull();
 }finally{db.close();}
});
test("typed erased receipt contains no retained payload and verifies its domain-separated integrity",()=>{
 const input=typed(),erased=eraseWorldReceipt(input.receipt_id,ulid(),input.at);
 expect(parseReceiptRecordLine(JSON.stringify(erased))).toEqual(erased);
 expect(Object.keys(erased)).toEqual(["schema","state","receipt_id","purge_receipt_id","own_id_origin","erased_at","sensitivity","integrity"]);
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
  const old=typed(),erased=eraseWorldReceipt(old.receipt_id,ulid(),old.at);insertReceiptRow(db,old,"claim");eraseReceiptRow(db,erased);
  expect(getCanonReceipt(db,old.receipt_id)).toBeNull();expect(getCanonReceiptRecord(db,old.receipt_id)).toEqual(erased);
  const row=db.query<Record<string,unknown>,[string]>("SELECT * FROM canon_receipts WHERE receipt_id=?").get(old.receipt_id)!;
  for(const key of ["page_path","before_hash","after_hash","claim_ids","provenance","world_basis","archive_path"])expect(row[key]).toBeNull();
  const another=eraseWorldReceipt(ulid(),erased.purge_receipt_id,old.at);insertErasedReceiptRow(db,another);expect(getCanonReceiptRecord(db,another.receipt_id)).toEqual(another);
 }finally{db.close();}
});
