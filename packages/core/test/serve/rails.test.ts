import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { doctorVault } from "../../src/vault/doctor";
import { parseFrontmatter } from "../../src/vault/frontmatter";
import { initVault } from "../../src/vault/init";
import { validatePage } from "../../src/vault/schema";
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
    expect(brief.startsWith("---\n")).toBe(true);
    const parsed = parseFrontmatter(brief);
    expect(validatePage(parsed.data)).toEqual([]);
    // The rollup is a deterministic notification, not evidence-backed canon:
    // it names no events, and it stays live and queryable rather than archived.
    expect(parsed.data["sources"]).toEqual([]);
    expect(parsed.data["status"]).toBe("active");
    const vaultDoctor = doctorVault(vault, db);
    const briefPage = vaultDoctor.pages.find(
      (page) => page.page === "dashboards/brief-2026-09-03.md",
    );
    expect(briefPage?.errors ?? ["missing brief page"]).toEqual([]);
    expect(vaultDoctor.counts.invalid).toBe(0);
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

  test("a retrieval sweep behind the index records progress instead of an empty pass", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-rails-"));
    dirs.push(directory);
    const vault = join(directory, "vault");
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    const behind = await runRail(db, vault, "retrieval-sweep", {
      hooks: {
        claims: { db },
        refresh: async () => ({ indexed: 500, remaining: 1_200, degraded: [] }),
      },
    });
    expect(behind.status).toBe("degraded");
    expect(behind.retrieval.upserts).toBe(500);
    expect(behind.retrieval.pending_ops).toBe(1_200);
    expect(behind.retrieval.degraded).toEqual(["derived-index-behind"]);

    const current = await runRail(db, vault, "retrieval-sweep", {
      hooks: {
        claims: { db },
        refresh: async () => ({ indexed: 0, remaining: 0, degraded: [] }),
      },
    });
    expect(current.status).toBe("ok");
    expect(current.retrieval.pending_ops).toBe(0);
    expect(current.retrieval.degraded).toEqual([]);
    db.close();
  });

  test("a sweep without a claims port still catches the derived index up", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-rails-"));
    dirs.push(directory);
    const vault = join(directory, "vault");
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    const receipt = await runRail(db, vault, "retrieval-sweep", {
      hooks: { refresh: async () => ({ indexed: 12, remaining: 0, degraded: [] }) },
    });
    expect(receipt.status).toBe("ok");
    expect(receipt.retrieval.upserts).toBe(12);
    expect(receipt.retrieval.pending_ops).toBe(0);
    db.close();
  });

  test("a refresh that throws is recorded as outstanding work, not an empty pass", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-rails-"));
    dirs.push(directory);
    const vault = join(directory, "vault");
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    const receipt = await runRail(db, vault, "retrieval-sweep", {
      hooks: {
        claims: { db },
        refresh: async () => { throw new Error("synthetic derived failure"); },
      },
    });
    expect(receipt.status).toBe("degraded");
    expect(receipt.retrieval.pending_ops).toBe(1);
    expect(receipt.retrieval.degraded).toContain("derived-index-behind");
    db.close();
  });
});
