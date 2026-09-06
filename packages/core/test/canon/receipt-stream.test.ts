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
  mkdirSync(join(f.vault, "people"));
  const content = serializePage({ data: { title: "Synthetic page", type: "person" }, body: "Owner text.\n" });
  writeFileSync(path, content, { mode: 0o600 });
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
    const before = readdirSync("/proc/self/fd").length;
    for (let count = 0; count < 16; count++) {
      const a = openOrdinaryReceiptStream(scope, io), b = openSourceErasureReceiptStream(scope, io);
      expect(Reflect.ownKeys(a)).toEqual([]);
      b.close(); b.close(); a.close(); a.close();
      expect(() => a.append(Buffer.from("closed"))).toThrow("canon_receipt_stream_closed");
    }
    expect(readdirSync("/proc/self/fd").length).toBe(before);
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
      const mode = ${JSON.stringify(mode)}, root = ${JSON.stringify(f.vault)}, log = ${JSON.stringify(f.log)};
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
      const before = fs.readdirSync('/proc/self/fd').length;
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
      assert.equal(fs.readdirSync('/proc/self/fd').length, before);
      db.close();
    `;
    const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe("");
  });
}
