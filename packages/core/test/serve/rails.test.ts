import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { dueRails, runRail, runServeOnce } from "../../src/serve/rails";
import { listSchedules } from "../../src/serve/schema";
import { listRunReceipts } from "../../src/serve/receipts";

const dirs: string[] = [];

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("rails", () => {
  test("fresh schedules are due and --once writes a receipt for every rail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-rails-"));
    dirs.push(directory);
    const vault = join(directory, "vault");
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    expect(listSchedules(db).map((row) => row.rail)).toEqual([
      "brief",
      "doctor-sweep",
      "embed-backfill",
      "journal-prune",
      "purge-sweep",
      "retrieval-sweep",
      "sync",
    ]);
    expect(dueRails(db, "2026-09-03T00:00:00Z").length).toBeGreaterThan(0);
    const receipts = await runServeOnce(db, vault, {
      now: () => "2026-09-03T00:00:00Z",
    });
    expect(receipts.map((item) => item.rail).sort()).toEqual([
      "brief",
      "doctor-sweep",
      "embed-backfill",
      "journal-prune",
      "purge-sweep",
      "retrieval-sweep",
      "sync",
    ]);
    expect(listRunReceipts(db)).toHaveLength(7);
    expect(existsSync(join(vault, "dashboards", "brief-2026-09-03.md"))).toBe(true);
    const brief = readFileSync(join(vault, "dashboards", "brief-2026-09-03.md"), "utf8");
    expect(brief).toContain("There is no review queue");
    expect(brief).toContain("kizuki tell");
    expect(brief).not.toContain("kizuki review");
    db.close();
  });

  test("the sync rail records the hook and never opens a canon page itself", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-rails-"));
    dirs.push(directory);
    const vault = join(directory, "vault");
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    const receipt = await runRail(db, vault, "sync", {
      hooks: {
        sync: async () => ({
          events_synced: 2,
          events_stored: 1,
          events_duplicate: 1,
          events_self_skipped: 0,
          errors: [],
        }),
      },
    });
    expect(receipt.events_stored).toBe(1);
    expect(receipt.canon_writes).toBe(0);
    db.close();
  });
});
