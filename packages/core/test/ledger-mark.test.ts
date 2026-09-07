import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/ledger/db";
import { ledgerAccepted, readLedgerMark, sealLedger, writeLedgerMark } from "../src/ledger/mark";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "kizuki-mark-"));
  roots.push(root);
  return root;
}

test("a fresh ledger seals zero into an owner-only sibling of vault-id", () => {
  const root = vault();
  const db = openLedger(join(root, "kizuki.db"));
  try {
    expect(ledgerAccepted(db)).toBe(0);
    expect(sealLedger(root, db)).toBe(0);
  } finally { db.close(); }
  const path = join(root, ".kizuki", "ledger-mark");
  expect(readFileSync(path, "utf8")).toBe("0\n");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readLedgerMark(root)).toBe(0);
});

test("only a non-negative integer line is a mark", () => {
  const root = vault();
  expect(readLedgerMark(root)).toBeNull();
  writeLedgerMark(root, 42);
  expect(readLedgerMark(root)).toBe(42);
  for (const bad of ["", "  \n", "007\n", "-1\n", "1.5\n", "three\n", "1e3\n"]) {
    writeFileSync(join(root, ".kizuki", "ledger-mark"), bad);
    expect(readLedgerMark(root)).toBeNull();
  }
  expect(() => writeLedgerMark(root, -1)).toThrow(TypeError);
  expect(() => writeLedgerMark(root, 1.5)).toThrow(TypeError);
});
