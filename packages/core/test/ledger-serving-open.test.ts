import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAgents } from "../src/agents/schema";
import { initGraph } from "../src/graph/schema";
import { openLedger, openLedgerForServing } from "../src/ledger/db";
import { isLedgerBusy } from "../src/ledger/busy";
import { tableExists } from "../src/ledger/schema";
import { initSearch } from "../src/search/schema";

let dir: string | null = null;
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function ledgerPath(): string {
  dir = mkdtempSync(join(tmpdir(), "kizuki-serving-open-"));
  return join(dir, "kizuki.db");
}

/** A ledger as the adapter finds it once the vault has been initialized and served. */
function currentLedger(path: string): void {
  const db = openLedger(path);
  initSearch(db);
  initGraph(db);
  initAgents(db);
  db.close();
}

test("a current ledger opens while another connection holds the write lock", () => {
  const path = ledgerPath();
  currentLedger(path);
  const holder = new Database(path);
  holder.exec("BEGIN IMMEDIATE");
  try {
    // With no wait budget any write, including a repair that turns out to be
    // a no-op, fails at once: opening must not need the write lock.
    const db = openLedgerForServing(path, { busyTimeoutMs: 0 });
    try {
      expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get()?.n).toBe(0);
      expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});

test("the plain opener needs the write lock for the same ledger", () => {
  const path = ledgerPath();
  currentLedger(path);
  const holder = new Database(path);
  holder.exec("BEGIN IMMEDIATE");
  try {
    let refused: unknown;
    try {
      openLedger(path, { busyTimeoutMs: 0 }).close();
    } catch (error) {
      refused = error;
    }
    expect(isLedgerBusy(refused)).toBe(true);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});

test("a ledger missing a derived layer is repaired as before", () => {
  const path = ledgerPath();
  currentLedger(path);
  const damaged = new Database(path);
  damaged.exec("DROP TABLE graph_edges");
  damaged.close();

  const db = openLedgerForServing(path);
  try {
    expect(tableExists(db, "graph_edges")).toBe(true);
  } finally {
    db.close();
  }
});

test("a ledger that was never initialized is created complete", () => {
  const db = openLedgerForServing(ledgerPath());
  try {
    for (const name of ["events", "agents", "search_documents", "search_docs", "graph_edges", "canon_receipts"]) {
      expect(tableExists(db, name)).toBe(true);
    }
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
  } finally {
    db.close();
  }
});
