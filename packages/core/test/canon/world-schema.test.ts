import { expect,test } from "bun:test";
import { openLedger } from "../../src/ledger/db";

test("ledger33 represents retained and erased typed canon receipts in the existing receipt table",()=>{
 const db=openLedger(":memory:");try {
  const columns=db.query<{name:string},[]>("PRAGMA table_info(canon_receipts)").all().map(row=>row.name);
  expect(columns).toContain("record_codec");
  expect(columns).toContain("world_basis");
  expect(columns).toContain("erasure_integrity");
  expect(db.query("SELECT version FROM schema_version").get()).toEqual({version:33});
 }finally{db.close();}
});

import { Database } from "bun:sqlite";
import { applyCanonV4 } from "../../src/canon/schema";
import { applyWorldCanonV33, LEGACY_CANON_COLUMNS } from "../../src/canon/world-schema";
import { rowToReceipt,type CanonReceiptRow } from "../../src/canon/receipts";
test("canon5 migration preserves legacy rows, wire bytes, indexes and referencing child rows",()=>{
 const db=new Database(":memory:");try {
  db.exec("PRAGMA foreign_keys=ON");applyCanonV4(db);
  db.query("INSERT INTO canon_receipts(receipt_id,provenance,sensitivity,page_path,after_hash,at) VALUES (?,?,?,?,?,?)").run("01M32TESTAAAAAAAAAAAAAAAAAA","[]","personal","topic/test.md","a".repeat(64),"2026-01-01T00:00:00.000Z");
  db.exec("CREATE TABLE child(receipt_id TEXT REFERENCES canon_receipts(receipt_id) ON DELETE RESTRICT)");
  db.exec("INSERT INTO child SELECT receipt_id FROM canon_receipts");
  const before=db.query<CanonReceiptRow,[]>("SELECT * FROM canon_receipts").get()!;
  const wire=JSON.stringify(rowToReceipt(before));
  db.exec("PRAGMA foreign_keys=OFF");
  try {db.transaction(()=>applyWorldCanonV33(db)).immediate();} finally {db.exec("PRAGMA foreign_keys=ON");}
  const after=db.query<CanonReceiptRow,[]>(`SELECT ${LEGACY_CANON_COLUMNS.join(",")} FROM canon_receipts`).get()!;
  expect(after).toEqual(before);expect(JSON.stringify(rowToReceipt(after))).toBe(wire);
  expect(db.query("PRAGMA foreign_key_check").get()).toBeNull();expect(db.query("SELECT * FROM child").all()).toHaveLength(1);
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name='canon_receipts_by_page'").get()).not.toBeNull();
 }finally{db.close();}
});
