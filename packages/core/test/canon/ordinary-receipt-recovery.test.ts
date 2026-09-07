import { afterEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, linkSync, readFileSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotCanonIo, withCanonMutationSync } from "../../src/canon/io";
import { openOrdinaryRecoveryReceiptStream, validateOrdinaryReceiptCheckpoint, type OrdinaryReceiptCheckpoint, type OrdinaryRecoveryReceiptStream } from "../../src/canon/receipt-stream";
import { RECEIPTS_PATH, type CanonReceipt } from "../../src/canon/receipts";
import { openLedger } from "../../src/ledger/db";
import { hashBytes } from "../../src/vault/write";
import { tempVault } from "../helpers/vault";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });
function fixture() {
  const vault = tempVault("ordinary-receipt-recovery-");
  const db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  cleanup.push(() => { db.close(); vault.dispose(); });
  return { vault: vault.path, log: join(vault.path, RECEIPTS_PATH), io: snapshotCanonIo({ db, vault_path: vault.path }) };
}
function line(id = "synthetic-receipt"): Buffer<ArrayBuffer> {
  const row: CanonReceipt = { receipt_id: id, kind: "write", claim_ids: [], page_path: "people/item.md", page_action: "create",
    before_hash: null, after_hash: hashBytes(Buffer.from("synthetic")), archive_path: null, writer: "import", producer: "deterministic",
    model_ref: null, authority: "connector_evidence", confidence: 0.8, sensitivity: "private", taint: "quoted", provenance: [],
    superseded: [], candidates: [], retrieval_ops: [], reverts: null, reverted_by: null, at: "2026-09-07T00:00:00.000Z" };
  return Buffer.from(JSON.stringify(row) + "\n");
}
function checkpoint(f: ReturnType<typeof fixture>): OrdinaryReceiptCheckpoint {
  return withCanonMutationSync(f.io, (scope, io) => {
    const stream = openOrdinaryRecoveryReceiptStream(scope, io);
    try { return JSON.parse(JSON.stringify(stream.checkpoint())); } finally { stream.close(); }
  });
}
function reconcile(f: ReturnType<typeof fixture>, before: OrdinaryReceiptCheckpoint, exact = line()): void {
  withCanonMutationSync(f.io, (scope, io) => {
    const stream = openOrdinaryRecoveryReceiptStream(scope, io);
    try { stream.reconcile(before, exact); stream.verifyBinding(); } finally { stream.close(); }
  });
}

test("admission creates and syncs private storage and an immutable closed checkpoint", () => {
  const f = fixture(); rmdirSync(join(f.vault, ".kizuki/receipts"));
  withCanonMutationSync(f.io, (scope, io) => {
    const stream = openOrdinaryRecoveryReceiptStream(scope, io);
    try {
      expect(Object.keys(stream).sort()).toEqual(["checkpoint", "close", "reconcile", "sync", "verifyBinding", "withdrawExact"]);
      const before = stream.checkpoint();
      expect(Object.isFrozen(before)).toBe(true); expect(Object.isFrozen(before.file)).toBe(true);
      expect(before.byte_length).toBe(0); expect(before.prefix_sha256).toBe(hashBytes(Buffer.alloc(0)));
      expect(statSync(f.log).mode & 0o777).toBe(0o600);
      stream.reconcile(before, line()); stream.reconcile(before, line());
      expect(readFileSync(f.log)).toEqual(line());
    } finally { stream.close(); }
  });
});

test("reopened descriptor completes only the exact admitted torn suffix, including a split UTF-8 codepoint", () => {
  const f = fixture(), prior = line("prior"), exact = line("synthetic-雪");
  writeFileSync(f.log, prior, { mode: 0o600 });
  const before = checkpoint(f), ino = statSync(f.log).ino;
  const split = exact.indexOf(Buffer.from("雪")) + 1;
  appendFileSync(f.log, exact.subarray(0, split));
  reconcile(f, before, exact); reconcile(f, before, exact);
  expect(readFileSync(f.log)).toEqual(Buffer.concat([prior, exact]));
  expect(statSync(f.log).ino).toBe(ino);
});

for (const seam of [0, 1, 12, line().length - 1, line().length]) {
  test(`recovery at receipt byte ${seam} appends the original line exactly once`, () => {
    const f = fixture(), before = checkpoint(f);
    appendFileSync(f.log, line().subarray(0, seam));
    reconcile(f, before); reconcile(f, before);
    expect(readFileSync(f.log)).toEqual(line());
  });
}

test("strict preflight refuses malformed, torn, duplicate and invalid UTF-8 streams without normalization", () => {
  const f = fixture();
  for (const bytes of [Buffer.from("invalid\n"), line().subarray(0, -1), Buffer.concat([line(), line()]),
    Buffer.from("\n"), Buffer.from('{"receipt_id":"x"}\n'), Buffer.concat([Buffer.from([0xff]), line()])]) {
    writeFileSync(f.log, bytes, { mode: 0o600 });
    expect(() => checkpoint(f)).toThrow("canon_receipt_stream_");
    expect(readFileSync(f.log)).toEqual(bytes);
  }
});

test("strict preflight refuses unreadable or nonprivate logs without repairing permissions", () => {
  const f = fixture(); writeFileSync(f.log, line(), { mode: 0o600 });
  for (const mode of [0o200, 0o400, 0o644, 0o660]) {
    chmodSync(f.log, mode);
    expect(() => checkpoint(f)).toThrow("canon_receipt_stream_");
    expect(statSync(f.log).mode & 0o777).toBe(mode);
  }
  chmodSync(f.log, 0o600); expect(readFileSync(f.log)).toEqual(line());
});

test("recovery refuses changed prefixes, foreign tails and duplicate lines without truncation", () => {
  const f = fixture(), prior = line("prior");
  writeFileSync(f.log, prior, { mode: 0o600 }); const before = checkpoint(f);
  const changed = Buffer.from(prior); changed[10] = 120;
  for (const bytes of [changed, prior.subarray(0, -1), Buffer.concat([prior, line("foreign")]),
    Buffer.concat([prior, line(), line()]), Buffer.concat([prior, line(), Buffer.from("x")])]) {
    writeFileSync(f.log, bytes);
    expect(() => reconcile(f, before)).toThrow("canon_receipt_stream_");
    expect(readFileSync(f.log)).toEqual(bytes);
  }
});

test("an ID already present in the checkpoint is a conflict even with exact line bytes", () => {
  const f = fixture(); writeFileSync(f.log, line(), { mode: 0o600 }); const before = checkpoint(f);
  expect(() => reconcile(f, before)).toThrow("canon_receipt_stream_conflict");
  expect(readFileSync(f.log)).toEqual(line());
});

test("restart does not accept a replaced inode, symlink, hardlink or renamed receipt directory", () => {
  for (const mode of ["inode", "symlink", "hardlink", "directory"] as const) {
    const f = fixture(), before = checkpoint(f), displaced = f.log + ".displaced";
    if (mode === "directory") {
      renameSync(join(f.vault, ".kizuki/receipts"), join(f.vault, ".kizuki/receipts-displaced"));
      // The primitive may create an empty private replacement; its identity still refuses continuation.
    } else {
      renameSync(f.log, displaced);
      if (mode === "inode") writeFileSync(f.log, "", { mode: 0o600 });
      if (mode === "symlink") symlinkSync(displaced, f.log);
      if (mode === "hardlink") linkSync(displaced, f.log);
    }
    expect(() => reconcile(f, before)).toThrow("canon_receipt_stream_");
    expect(readFileSync(mode === "directory" ? join(f.vault, ".kizuki/receipts-displaced/promotions.jsonl") : displaced).length).toBe(0);
  }
});

test("same-descriptor custody detects external append and poisons the held stream", () => {
  const f = fixture();
  withCanonMutationSync(f.io, (scope, io) => {
    const stream = openOrdinaryRecoveryReceiptStream(scope, io);
    try {
      const before = stream.checkpoint(); appendFileSync(f.log, line().subarray(0, 12));
      expect(() => stream.reconcile(before, line())).toThrow("canon_receipt_stream_changed");
      expect(() => stream.verifyBinding()).toThrow("canon_receipt_stream_failed");
      expect(readFileSync(f.log)).toEqual(line().subarray(0, 12));
    } finally { stream.close(); }
  });
});

test("closed validator refuses extra fields, accessors, invalid identities and aliased records", () => {
  const f = fixture(), before = checkpoint(f); let called = false;
  for (const invalid of [{ ...before, extra: true }, { ...before, byte_length: -1 }, { ...before, prefix_sha256: "x" },
    { ...before, version: 2 }, { ...before, file: { ...before.file, ino: "01" } },
    { ...before, get byte_length() { called = true; return 0; } }]) {
    expect(() => validateOrdinaryReceiptCheckpoint(invalid)).toThrow("canon_receipt_stream_checkpoint_invalid");
  }
  expect(called).toBe(false);
  const saved = validateOrdinaryReceiptCheckpoint(before); Reflect.set(before.file, "ino", "0");
  expect(saved.file.ino).not.toBe("0");
});

test("retained recovery stream loses owner authority at scope end", () => {
  const f = fixture(); let held!: OrdinaryRecoveryReceiptStream, before!: OrdinaryReceiptCheckpoint;
  withCanonMutationSync(f.io, (scope, io) => { held = openOrdinaryRecoveryReceiptStream(scope, io); before = held.checkpoint(); });
  try { expect(() => held.reconcile(before, line())).toThrow("canon_receipt_stream_"); }
  finally { held.close(); held.close(); }
  expect(readFileSync(f.log).length).toBe(0);
});

for (const seam of [0, 1, 12, line().length - 1, line().length]) {
  test(`authorized withdrawal at byte ${seam} preserves the exact original prefix and retries without a receipt`, () => {
    const f = fixture(), prior = line("prior");
    writeFileSync(f.log, prior, { mode: 0o600 }); const before = checkpoint(f), ino = statSync(f.log).ino;
    appendFileSync(f.log, line().subarray(0, seam));
    for (let retry = 0; retry < 2; retry++) {
      withCanonMutationSync(f.io, (scope, io) => {
        const stream = openOrdinaryRecoveryReceiptStream(scope, io);
        try { stream.withdrawExact(before, line()); stream.verifyBinding(); } finally { stream.close(); }
      });
    }
    expect(readFileSync(f.log)).toEqual(prior); expect(statSync(f.log).ino).toBe(ino);
  });
}

test("withdrawal refuses foreign, duplicate, extra, corrupted-prefix and changed-inode data unchanged", () => {
  const f = fixture(), prior = line("prior");
  writeFileSync(f.log, prior, { mode: 0o600 }); const before = checkpoint(f);
  for (const bytes of [line("different-prior"), Buffer.concat([prior, line("foreign")]),
    Buffer.concat([prior, line(), line()]), Buffer.concat([prior, line(), Buffer.from("x")])]) {
    writeFileSync(f.log, bytes);
    withCanonMutationSync(f.io, (scope, io) => {
      const stream = openOrdinaryRecoveryReceiptStream(scope, io);
      try { expect(() => stream.withdrawExact(before, line())).toThrow("canon_receipt_stream_"); }
      finally { stream.close(); }
    });
    expect(readFileSync(f.log)).toEqual(bytes);
  }
  renameSync(f.log, f.log + ".old"); writeFileSync(f.log, Buffer.concat([prior, line()]), { mode: 0o600 });
  withCanonMutationSync(f.io, (scope, io) => {
    const stream = openOrdinaryRecoveryReceiptStream(scope, io);
    try { expect(() => stream.withdrawExact(before, line())).toThrow("canon_receipt_stream_changed"); }
    finally { stream.close(); }
  });
  expect(readFileSync(f.log)).toEqual(Buffer.concat([prior, line()]));
});
