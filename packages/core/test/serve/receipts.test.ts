import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { persistRunReceipt, recoverRunJournal, getRunReceipt } from "../../src/serve/receipts";
import { runRail } from "../../src/serve/rails";
import { InjectedCrash, emptyRunTotals } from "../../src/serve/types";

const dirs: string[] = [];

function vault() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-receipt-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  return { path, db };
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("run receipts", () => {
  test("a kill after the file write converges on restart", async () => {
    const { path, db } = vault();
    try {
      await runRail(db, path, "brief", { crashAfter: "after-file" });
      throw new Error("expected crash");
    } catch (error) {
      expect(error).toBeInstanceOf(InjectedCrash);
    }
    expect(existsSync(join(path, "dashboards", "brief-2026-09-03.md")) || existsSync(join(path, "dashboards"))).toBe(true);
    const recovered = recoverRunJournal(db, path);
    expect(recovered).toEqual([]);
    const second = await runRail(db, path, "brief");
    expect(second.status).toBe("ok");
    expect(getRunReceipt(db, second.run_id)?.rail).toBe("brief");
    db.close();
  });

  test("a kill after the JSONL append converges on restart", async () => {
    const { path, db } = vault();
    try {
      await runRail(db, path, "doctor-sweep", { crashAfter: "after-jsonl" });
      throw new Error("expected crash");
    } catch (error) {
      expect(error).toBeInstanceOf(InjectedCrash);
    }
    const recovered = recoverRunJournal(db, path);
    expect(recovered).toHaveLength(1);
    expect(getRunReceipt(db, recovered[0] ?? "")?.rail).toBe("doctor-sweep");
    const again = recoverRunJournal(db, path);
    expect(again).toEqual([]);
    db.close();
  });

  test("a kill after the database row converges on restart", async () => {
    const { path, db } = vault();
    try {
      await runRail(db, path, "journal-prune", { crashAfter: "after-db" });
      throw new Error("expected crash");
    } catch (error) {
      expect(error).toBeInstanceOf(InjectedCrash);
    }
    const receipts = recoverRunJournal(db, path);
    expect(receipts).toEqual([]);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run_receipts").get()?.n,
    ).toBe(1);
    db.close();
  });

  test("persist writes a redacted journal line", () => {
    const { path, db } = vault();
    const receipt = {
      ...emptyRunTotals(),
      run_id: "01JBRECEIPT000000000000001",
      rail: "sync",
      started_at: "2026-09-03T00:00:00Z",
      finished_at: "2026-09-03T00:00:01Z",
      status: "ok" as const,
      stopped: null,
      errors: ["failed at /home/owner/vault/secret.md token=abcdefghijklmnopqrstuvwxyz"],
    };
    persistRunReceipt(db, path, receipt);
    const log = readFileSync(join(path, ".kizuki", "run-receipts.jsonl"), "utf8");
    expect(log).not.toContain("/home/owner");
    expect(log).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(log).toContain("[path]");
    db.close();
  });

  test("generated typed page locators survive receipts while secrets and malformed locators do not", () => {
    const { path, db } = vault();
    try {
      const handle = "a".repeat(32), other = "b".repeat(32);
      const locator = `page ${handle} at auto/world/${handle}.md`;
      const marker = "synthetic-secret-value-1234567890";
      const receipt = { ...emptyRunTotals(), run_id: "fixture-page-failure", rail: "sync",
        started_at: "2026-03-01T00:00:00.000Z", finished_at: "2026-03-01T00:00:01.000Z",
        status: "degraded" as const, stopped: null, errors: [
          `secret=${marker} (${locator})`,
          `typed ${locator} set aside until 2026-03-02T00:00:00.000Z after 3 failed passes`,
          `failure (page ${handle} at auto/world/${other}.md)`,
        ] };
      persistRunReceipt(db, path, receipt);
      const stored = getRunReceipt(db, receipt.run_id)!;
      expect(stored.errors[0]).toBe(`secret=[redacted] (${locator})`);
      expect(stored.errors[1]).toBe(receipt.errors[1]!);
      expect(stored.errors[2]).not.toContain(handle);
      expect(stored.errors[2]).not.toContain(other);
      expect(readFileSync(join(path, ".kizuki", "run-receipts.jsonl"), "utf8")).not.toContain(marker);
    } finally { db.close(); }
  });
});

test("malformed existing receipt cannot consume the recovered schedule transition", () => {
 const {path,db}=vault(), due="2026-09-05T00:00:00.000Z", run_id="01K00000000000000000000000";
 try {
  db.query("UPDATE schedules SET next_run_at=? WHERE rail='doctor-sweep'").run(due);
  const receipt={...emptyRunTotals(),run_id,rail:"doctor-sweep",started_at:due,finished_at:due,status:"ok" as const,stopped:null,execution:{instance_id:"i",pid:12,boot_id:"b",trigger:"scheduled" as const,due_at:due}};
  expect(()=>persistRunReceipt(db,path,receipt,{crashAfter:"after-jsonl"})).toThrow();
  const malformed=JSON.stringify({run_id});
  db.query("INSERT INTO run_receipts(run_id,rail,started_at,finished_at,status,stopped,report) VALUES (?,?,?,?,?,?,?)").run(run_id,"doctor-sweep",due,due,"ok",null,malformed);
  expect(()=>recoverRunJournal(db,path)).toThrow();
  expect(db.query<{next_run_at:string},[]>("SELECT next_run_at FROM schedules WHERE rail='doctor-sweep'").get()!.next_run_at).toBe(due);
  expect(db.query<{report:string},[string]>("SELECT report FROM run_receipts WHERE run_id=?").get(run_id)!.report).toBe(malformed);
  expect(getRunReceipt(db,run_id)).toBeNull();
 } finally {db.close();}
});
