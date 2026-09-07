import { expect, test } from "bun:test";
import { Database, constants } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../src/ledger/db";

test("the last writable ledger connection closes WAL sidecars and preserves committed data", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-ledger-wal-")), path = join(root, "ledger.sqlite");
  try {
    const db = openLedger(path);
    try {
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      if (process.platform === "darwin") {
        const persistence = new Int32Array([-1]);
        expect(db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, persistence)).toBe(0);
        expect(persistence[0]).toBe(0);
      }
      db.exec("CREATE TABLE wal_close_fixture (n INTEGER); INSERT INTO wal_close_fixture VALUES (7)");
      expect(readdirSync(root)).toContain("ledger.sqlite-wal");
    } finally { db.close(true); }
    expect(readdirSync(root)).toEqual(["ledger.sqlite"]);
    const reader = new Database(path, { readonly: true });
    try { expect(reader.query("SELECT n FROM wal_close_fixture").get()).toEqual({ n: 7 }); }
    finally { reader.close(true); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ["unsupported", "throws", "missing"] as const) test(`Darwin ledger refuses ${failure} WAL lifecycle control before SQL and closes its connection`, () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-ledger-wal-fault-"));
  try {
    const script = `
      import { Database, constants } from "bun:sqlite";
      import { strict as assert } from "node:assert";
      import { openLedger } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/db.ts"))};
      import { LedgerStoreError } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/errors.ts"))};
      Object.defineProperty(process, "platform", { value: "darwin" });
      let calls = 0, closes = 0, statements = 0, held;
      const originalClose = Database.prototype.close, originalExec = Database.prototype.exec;
      Database.prototype.exec = function(...args) { statements++; return originalExec.apply(this, args); };
      Database.prototype.close = function(...args) { closes++; held=this; return originalClose.apply(this,args); };
      const failure = ${JSON.stringify(failure)};
      Database.prototype.fileControl = failure === "missing" ? undefined : function(op,value) {
        calls++; assert.equal(op,constants.SQLITE_FCNTL_PERSIST_WAL); assert.equal(value,0);
        if(failure === "throws") throw new Error("do not expose native failure details");
        return 12;
      };
      assert.throws(() => openLedger(${JSON.stringify(join(root, "ledger.sqlite"))}), error => error instanceof LedgerStoreError && error.code === "infrastructure" && error.message === "ledger WAL lifecycle is unavailable");
      assert.equal(closes,1); assert.equal(statements,0); assert.equal(calls,failure === "missing" ? 0 : 1);
      assert.throws(() => originalExec.call(held,"SELECT 1"), /closed/i);
      // Memory databases have no WAL and must not depend on file control.
      for(const path of [":memory:",""]) { const db=openLedger(path); db.close(true); }
      assert.equal(calls,failure === "missing" ? 0 : 1);
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.length).toBe(0); expect(child.stderr.length).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
