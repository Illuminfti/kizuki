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
});
