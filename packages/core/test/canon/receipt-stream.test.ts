import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotCanonIo, withCanonMutationSync } from "../../src/canon/io";
import { openOrdinaryReceiptStream, openSourceErasureReceiptStream, ReceiptStreamError, type ReceiptAppendStream } from "../../src/canon/receipt-stream";
import { RECEIPTS_PATH, type CanonReceipt } from "../../src/canon/receipts";
import { appendSourceErasureReceipt } from "../../src/canon/source-erasure-intent";
import { appendReceiptLine, CanonPageUnreadable, insertReceiptRow, readPage } from "../../src/canon/store";
import { openLedger } from "../../src/ledger/db";
import { serializePage } from "../../src/vault/frontmatter";
import { hashBytes } from "../../src/vault/write";
import { tempVault } from "../helpers/vault";

const cleanup: (() => void)[] = [];
const descriptorDirectory = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
function fixture() {
  const vault = tempVault("canon-receipt-stream-");
  const db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  cleanup.push(() => { db.close(); vault.dispose(); });
  return { vault: vault.path, log: join(vault.path, RECEIPTS_PATH), io: snapshotCanonIo({ db, vault_path: vault.path }) };
}
function receipt(): CanonReceipt {
  return { receipt_id: "receipt-stream-fixture", kind: "purge_rewrite", claim_ids: [], page_path: "people/item.md",
    page_action: "edit", before_hash: null, after_hash: hashBytes(Buffer.from("Synthetic postimage")), archive_path: null,
    writer: "loop", producer: "deterministic", model_ref: null, authority: "connector_evidence", confidence: 0.8,
    sensitivity: "private", taint: "quoted", provenance: [], superseded: [], candidates: [], retrieval_ops: [],
    reverts: null, reverted_by: null, at: "2026-09-06T00:00:00.000Z" };
}

test("standalone readPage returns matching bytes, hash and parse and retains its directory error", () => {
  const f = fixture(), path = join(f.vault, "people/item.md");
  mkdirSync(join(f.vault, "people"), { mode: 0o700 });
  chmodSync(join(f.vault, "people"), 0o700);
  const content = serializePage({ data: { title: "Synthetic page", type: "person" }, body: "Owner text.\n" });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  const found = readPage(f.io, "people/item.md")!;
  expect(found.path).toBe(path); expect(found.content).toBe(content);
  expect(found.hash).toBe(hashBytes(Buffer.from(content))); expect(found.page.data.title).toBe("Synthetic page");
  expect(readPage(f.io, "people/missing.md")).toBeNull();
  mkdirSync(join(f.vault, "people/directory.md"));
  expect(() => readPage(f.io, "people/directory.md")).toThrow(new CanonPageUnreadable("people/directory.md", "EISDIR"));
  writeFileSync(path, Buffer.alloc(1_048_577), { mode: 0o600 });
  expect(() => readPage(f.io, "people/item.md")).toThrow(new CanonPageUnreadable("people/item.md", "EIO"));
});

test("ordinary append creates private receipt storage and supports an existing write-only log", () => {
  const f = fixture(), row = receipt(), line = JSON.stringify(row) + "\n";
  rmdirSync(join(f.vault, ".kizuki/receipts"));
  withCanonMutationSync(f.io, (scope, io) => appendReceiptLine(scope, io, row));
  expect(statSync(join(f.vault, ".kizuki/receipts")).mode & 0o777).toBe(0o700);
  expect(statSync(f.log).mode & 0o777).toBe(0o600);
  const identity = statSync(f.log).ino;
  chmodSync(f.log, 0o200);
  withCanonMutationSync(f.io, (scope, io) => appendReceiptLine(scope, io, row));
  expect(statSync(f.log).ino).toBe(identity); expect(statSync(f.log).mode & 0o777).toBe(0o200);
  chmodSync(f.log, 0o600);
  expect(readFileSync(f.log, "utf8")).toBe(line + line);
});

test("ordinary append has no source-stream total-size cap", () => {
  const f = fixture(), row = receipt();
  writeFileSync(f.log, "", { mode: 0o600 }); truncateSync(f.log, 32 * 1024 * 1024 + 1);
  const before = statSync(f.log).size;
  withCanonMutationSync(f.io, (scope, io) => appendReceiptLine(scope, io, row));
  expect(statSync(f.log).size).toBe(before + Buffer.byteLength(JSON.stringify(row) + "\n"));
});

test("source receipt retry preserves one identical line and a held binding across the row transaction", () => {
  const f = fixture(), row = receipt();
  writeFileSync(f.log, "", { mode: 0o600 }); chmodSync(f.log, 0o664);
  const identity = statSync(f.log).ino;
  withCanonMutationSync(f.io, (scope, io) => {
    const stream = appendSourceErasureReceipt(scope, io, row);
    try {
      expect(Reflect.ownKeys(stream).sort()).toEqual(["close", "verifyBinding"]);
      expect(Object.isFrozen(stream)).toBe(true);
      expect(() => io.db.transaction(() => {
        stream.verifyBinding(); insertReceiptRow(io.db, row, "claim");
        throw Error("synthetic row rollback");
      }).immediate()).toThrow("synthetic row rollback");
      expect(io.db.query("SELECT receipt_id FROM canon_receipts").all()).toEqual([]);
      io.db.transaction(() => { stream.verifyBinding(); insertReceiptRow(io.db, row, "claim"); stream.verifyBinding(); }).immediate();
      stream.verifyBinding();
    } finally { stream.close(); stream.close(); }
    const retry = appendSourceErasureReceipt(scope, io, row);
    try { retry.verifyBinding(); } finally { retry.close(); }
  });
  expect(readFileSync(f.log, "utf8")).toBe(JSON.stringify(row) + "\n");
  expect(statSync(f.log).ino).toBe(identity); expect(statSync(f.log).mode & 0o777).toBe(0o600);
  expect(f.io.db.query("SELECT receipt_id FROM canon_receipts").all()).toEqual([{ receipt_id: row.receipt_id }]);
});

test("source receipt conflict, duplicate ID and malformed JSON preserve the existing log", () => {
  const f = fixture(), row = receipt(), line = JSON.stringify(row) + "\n";
  for (const content of [JSON.stringify({ ...row, after_hash: "different" }) + "\n", line + line, "invalid JSON\n"]) {
    writeFileSync(f.log, content, { mode: 0o600 });
    withCanonMutationSync(f.io, (scope, io) => {
      expect(() => appendSourceErasureReceipt(scope, io, row)).toThrow();
      expect(readFileSync(f.log, "utf8")).toBe(content);
    });
  }
});

test("source receipt reading keeps its 32 MiB bound separate from the 1 MiB canon page bound", () => {
  const f = fixture(), row = receipt();
  const prefix = JSON.stringify({ receipt_id: "earlier-fixture", body: "x".repeat(1_048_577) }) + "\n";
  writeFileSync(f.log, prefix, { mode: 0o600 });
  withCanonMutationSync(f.io, (scope, io) => appendSourceErasureReceipt(scope, io, row).close());
  expect(readFileSync(f.log, "utf8")).toBe(prefix + JSON.stringify(row) + "\n");
  truncateSync(f.log, 32 * 1024 * 1024);
  withCanonMutationSync(f.io, (scope, io) => {
    const stream = openSourceErasureReceiptStream(scope, io);
    try {
      expect(stream.readUtf8().length).toBe(32 * 1024 * 1024);
      expect(() => stream.append(Buffer.from("x"))).toThrow("canon_receipt_stream_bounds");
      expect(() => stream.verifyBinding()).toThrow("canon_receipt_stream_failed");
    } finally { stream.close(); }
  });
  expect(statSync(f.log).size).toBe(32 * 1024 * 1024);
  truncateSync(f.log, 32 * 1024 * 1024 + 1);
  withCanonMutationSync(f.io, (scope, io) => expect(() => openSourceErasureReceiptStream(scope, io)).toThrow("canon_receipt_stream_bounds"));
  expect(statSync(f.log).size).toBe(32 * 1024 * 1024 + 1);
});

test("stationary receipt permission failures preserve bytes and do not repair read-only source logs", () => {
  const f = fixture();
  writeFileSync(f.log, "synthetic bytes", { mode: 0o600 });
  for (const [mode, source] of [[0o400, true], [0o666, false]] as const) {
    chmodSync(f.log, mode);
    withCanonMutationSync(f.io, (scope, io) => expect(() => source ? openSourceErasureReceiptStream(scope, io) : openOrdinaryReceiptStream(scope, io)).toThrow(ReceiptStreamError));
    expect(statSync(f.log).mode & 0o777).toBe(mode); expect(readFileSync(f.log, "utf8")).toBe("synthetic bytes");
  }
  chmodSync(f.log, 0o600);
});

test("source stream needs an existing receipt parent and both stream types release their descriptors", () => {
  const f = fixture();
  rmdirSync(join(f.vault, ".kizuki/receipts"));
  withCanonMutationSync(f.io, (scope, io) => expect(() => openSourceErasureReceiptStream(scope, io)).toThrow("canon_receipt_stream_missing"));
  expect(existsSync(f.log)).toBe(false);
  withCanonMutationSync(f.io, (scope, io) => {
    openOrdinaryReceiptStream(scope, io).close();
    openSourceErasureReceiptStream(scope, io).close();
    const before = readdirSync(descriptorDirectory).length;
    for (let count = 0; count < 16; count++) {
      const a = openOrdinaryReceiptStream(scope, io), b = openSourceErasureReceiptStream(scope, io);
      expect(Reflect.ownKeys(a)).toEqual([]);
      b.close(); b.close(); a.close(); a.close();
      expect(() => a.append(Buffer.from("closed"))).toThrow("canon_receipt_stream_closed");
    }
    expect(readdirSync(descriptorDirectory).length).toBe(before);
  });
});

test("retained receipt streams lose mutation ownership when the operation ends", () => {
  const f = fixture();
  let retained!: ReceiptAppendStream;
  withCanonMutationSync(f.io, (scope, io) => { retained = openOrdinaryReceiptStream(scope, io); });
  try {
    expect(() => retained.append(Buffer.from("stale"))).toThrow(ReceiptStreamError);
    expect(() => retained.verifyBinding()).toThrow("canon_receipt_stream_failed");
    expect(readFileSync(f.log).length).toBe(0);
  } finally { retained.close(); }
});

for (const mode of ["short-write", "no-progress", "fsync-failure"] as const) {
  test(`receipt stream handles stationary ${mode} without hiding uncertainty or leaking descriptors`, () => {
    const f = fixture();
    const script = `
      import { mock } from 'bun:test';
      import * as fs from 'node:fs';
      import { strict as assert } from 'node:assert';
      const mode = ${JSON.stringify(mode)}, root = ${JSON.stringify(f.vault)}, log = ${JSON.stringify(f.log)}, descriptors = ${JSON.stringify(descriptorDirectory)};
      const realWrite = fs.writeSync, realSync = fs.fsyncSync;
      let calls = 0, armed = false;
      mock.module('node:fs', () => ({ ...fs,
        writeSync(fd, bytes, offset, length) {
          if (!armed) return realWrite(fd, bytes, offset, length);
          calls++;
          if (mode === 'no-progress' && calls > 1) return 0;
          return realWrite(fd, bytes, offset, Math.min(length, 2));
        },
        fsyncSync(fd) { if (armed && mode === 'fsync-failure') throw Error('synthetic fsync failure'); return realSync(fd); }
      }));
      const { openLedger } = await import(${JSON.stringify(join(import.meta.dir, "../../src/ledger/db.ts"))});
      const { snapshotCanonIo, withCanonMutationSync } = await import(${JSON.stringify(join(import.meta.dir, "../../src/canon/io.ts"))});
      const { openOrdinaryReceiptStream } = await import(${JSON.stringify(join(import.meta.dir, "../../src/canon/receipt-stream.ts"))});
      const db = openLedger(root + '/.kizuki/kizuki.db'), io = snapshotCanonIo({ db, vault_path: root });
      withCanonMutationSync(io, (scope, io) => openOrdinaryReceiptStream(scope, io).close());
      const before = fs.readdirSync(descriptors).length;
      withCanonMutationSync(io, (scope, io) => {
        const stream = openOrdinaryReceiptStream(scope, io);
        try {
          armed = true;
          if (mode === 'no-progress') assert.throws(() => stream.append(Buffer.from('abcdef')), { message: 'canon_receipt_stream_io' });
          else {
            stream.append(Buffer.from('abcdef')); assert.ok(calls > 1);
            if (mode === 'fsync-failure') assert.throws(() => stream.sync(), { message: 'canon_receipt_stream_durability' });
            else { stream.sync(); stream.verifyBinding(); }
          }
          if (mode !== 'short-write') assert.throws(() => stream.verifyBinding(), { message: 'canon_receipt_stream_failed' });
        } finally { armed = false; stream.close(); stream.close(); }
      });
      assert.equal(fs.readFileSync(log, 'utf8'), mode === 'no-progress' ? 'ab' : 'abcdef');
      assert.equal(fs.readdirSync(descriptors).length, before);
      db.close();
    `;
    const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe("");
  });
}

test.skipIf(process.platform !== "linux" || process.arch !== "x64")("receipt streams retain exact vault broker custody through writes and revalidation", () => {
  const source = (path: string) => JSON.stringify(join(import.meta.dir, "../../src", path));
  const script = `
    import {mock,expect} from 'bun:test';
    import * as fs from 'node:fs';
    import {join} from 'node:path';
    import {tmpdir} from 'node:os';
    const realStat=fs.fstatSync;let mapped=false,broker=true,boundVault='',owner=0n,attestations=0;
    mock.module('node:fs',()=>({...fs,fstatSync(fd,...args){const s=realStat(fd,...args);return mapped&&s.uid===0n?Object.assign(Object.create(Object.getPrototypeOf(s)),s,{uid:65534n,gid:65534n}):s;}}));
    const custody=await import(${source("serve/custody.ts")});
    mock.module(${source("serve/custody.ts")},()=>({...custody,serviceAncestorOwner(vault,_fd,s){if(broker&&vault===boundVault&&s.uid===65534n){attestations++;return owner;}return undefined;}}));
    const {initVault}=await import(${source("vault/init.ts")});
    const {openLedger}=await import(${source("ledger/db.ts")});
    const {putEvent}=await import(${JSON.stringify(join(import.meta.dir,"../claims/helpers.ts"))});
    const {fileProposal}=await import(${source("staging/proposals.ts")});
    const {runRail}=await import(${source("serve/rails.ts")});
    const {snapshotCanonIo,withCanonMutationSync}=await import(${source("canon/io.ts")});
    const {openOrdinaryReceiptStream}=await import(${source("canon/receipt-stream.ts")});
    const {RECEIPTS_PATH}=await import(${source("canon/receipts.ts")});
    const root=fs.mkdtempSync(join(tmpdir(),'receipt-broker-'));initVault(root);boundVault=root;
    const db=openLedger(join(root,'.kizuki/kizuki.db')),io=snapshotCanonIo({db,vault_path:root});
    try {
      const id=putEvent(db);expect(fileProposal(db,{kind:'claim',target:'people/synthetic',body:'Synthetic role fact.',frontmatter:{type:'person',title:'Synthetic'},provenance:[id],subjects:['person:synthetic'],producer:'deterministic',confidence:0.8}).outcome).toBe('stored');
      mapped=true;
      const receipt=await runRail(db,root,'sync',{hooks:{model_ref:'kizuki.llm.openai-compatible:synthetic@local',claims:{db},producer:{descriptor:{id:'kizuki.producer.fixture',kind:'producer',contract:'kizuki.producer/v1',contract_minor:4,supports:['model'],requires_lease:false,optional_package:null},health:async()=>({status:'ready',detail:{}}),close:async()=>{},produce:async()=>({status:'ok',claims:[],usage:{calls:0,input_tokens:0,output_tokens:0},dropped:[]})}}});
      expect(receipt.status).toBe('ok');expect(receipt.canon_writes).toBe(1);expect(receipt.errors).toEqual([]);
      expect(db.query('SELECT count(*) AS n FROM canon_receipts').get().n).toBe(1);expect(attestations).toBeGreaterThan(0);
      const log=join(root,RECEIPTS_PATH),before=fs.readFileSync(log);
      for(const failure of ['absent-broker','wrong-owner','foreign-vault','changed-root','unsafe-leaf']) {
        withCanonMutationSync(io,(scope,owned)=>{
          const stream=openOrdinaryReceiptStream(scope,owned);stream.verifyBinding();
          try {
            if(failure==='absent-broker')broker=false;
            if(failure==='wrong-owner')owner=12345n;
            if(failure==='foreign-vault')boundVault=root+'-foreign';
            if(failure==='changed-root')fs.renameSync(root,root+'-moved');
            if(failure==='unsafe-leaf')fs.chmodSync(log,0o666);
            expect(()=>stream.verifyBinding()).toThrow();
          }finally{
            broker=true;owner=0n;boundVault=root;
            if(failure==='changed-root')fs.renameSync(root+'-moved',root);
            if(failure==='unsafe-leaf')fs.chmodSync(log,0o600);
            stream.close();
          }
        });
        expect(fs.readFileSync(log).equals(before)).toBe(true);
      }
      withCanonMutationSync(io,(scope,owned)=>{const stream=openOrdinaryReceiptStream(scope,owned);stream.verifyBinding();stream.close();});
    }finally{mapped=false;db.close();fs.rmSync(root,{recursive:true,force:true});}
  `;
  const result=spawnSync(process.execPath,["-e",script],{encoding:"utf8",timeout:20_000});
  expect({code:result.status,stderr:result.stderr}).toEqual({code:0,stderr:""});
});
