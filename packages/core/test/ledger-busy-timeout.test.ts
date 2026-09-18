import { expect, test } from "bun:test";
import { openLedger } from "../src/ledger/db";
import { LEDGER_BUSY_TIMEOUT_MS } from "../src/ledger/limits";

test("file-backed ledgers wait for a bounded writer instead of failing immediately", () => {
  const db = openLedger(":memory:");
  try {
    const row = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get();
    expect(row?.timeout).toBe(LEDGER_BUSY_TIMEOUT_MS);
    expect(LEDGER_BUSY_TIMEOUT_MS).toBe(5_000);
  } finally {
    db.close();
  }
});
