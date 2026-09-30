import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProducerPort } from "../../src/contracts/producer";
import { countCaptureFanout } from "../../src/claims/capture-fanout";
import { getClaim } from "../../src/claims/store";
import { recoverCanonWrites } from "../../src/canon/recovery";
import { inspectCanonRecovery } from "../../src/canon/write-intent";
import { runWritePass } from "../../src/serve/write-pass";
import { createBudgetTracker } from "../../src/canon/budget";
import { countCanonReceipts } from "../../src/canon/receipts";
import { openLedger } from "../../src/ledger/db";
import { tryWriteFlock } from "../../src/serve/flock";
import { runRail } from "../../src/serve/rails";
import { getRunReceipt, readRunReceiptsLog, recoverRunJournal, pruneRunReceipts } from "../../src/serve/receipts";
import { initVault } from "../../src/vault/init";
import { putEvent, storeClaim, write } from "../canon/helpers";

setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function vaultWithNotes(count: number) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-fanout-"));
  roots.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const eventId = putEvent(db, {
      source_record_id: `session-1/${index}`,
      text: `turn ${index}`,
    });
    const note = await storeClaim(db, eventId, {
      kind: "claim",
      target: "captures/session-connector/2026-09-01",
      subject: null,
      predicate: null,
      object: null,
      body: `Captured from \`session-connector\` (message) at 2026-09-01T09:00:00Z.\n\n> turn ${index}`,
      frontmatter: {
        type: "source",
        title: "Capture from session-connector at 2026-09-01T09:00:00Z",
        "x-connector": "session-connector",
        "x-capture-kind": "message",
      },
      subjects: [],
      confidence: 1,
      taint: "quoted",
      sensitivity: "private",
    });
    ids.push(note.claim_id);
  }
  return { vault, db, ids };
}

describe("the doctor sweep closes out capture notes filed for conversational events", () => {
  test("skips them, receipts the count, and a second sweep changes nothing", async () => {
    const f = await vaultWithNotes(4);
    try {
      expect(countCaptureFanout(f.db)).toEqual({ pending: 4, skipped: 0 });

      const sweep = await runRail(f.db, f.vault, "doctor-sweep", {
        now: () => "2026-09-29T08:00:00.000Z",
      });
      expect(sweep.captures_skipped).toBe(4);
      expect(getRunReceipt(f.db, sweep.run_id)?.captures_skipped).toBe(4);
      expect(countCaptureFanout(f.db)).toEqual({ pending: 0, skipped: 4 });
      for (const id of f.ids)
        expect(getClaim(f.db, id)?.status).toBe("skipped");
      expect(countCanonReceipts(f.db)).toBe(0);
      expect(existsSync(join(f.vault, "captures"))).toBe(false);

      const again = await runRail(f.db, f.vault, "doctor-sweep", {
        now: () => "2026-09-29T09:00:00.000Z",
      });
      expect(again.captures_skipped).toBeUndefined();
      expect(countCaptureFanout(f.db)).toEqual({ pending: 0, skipped: 4 });
    } finally {
      f.db.close();
    }
  });

  test("an interrupted canon write keeps its claims intact until recovery", async () => {
    const f = await vaultWithNotes(1);
    try {
      f.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON canon_receipts
        BEGIN SELECT RAISE(FAIL, 'injected receipt failure'); END`);
      expect(() => write({ db: f.db, vault_path: f.vault }, getClaim(f.db, f.ids[0]!)!)).toThrow();
      f.db.exec("DROP TRIGGER fail_receipt");
      expect(inspectCanonRecovery(f.db).pending).toBe(true);
      const before = getClaim(f.db, f.ids[0]!)!;
      const sweep = await runRail(f.db, f.vault, "doctor-sweep");
      expect(sweep.captures_skipped).toBeUndefined();
      expect(getClaim(f.db, f.ids[0]!)).toEqual(before);
      expect(recoverCanonWrites({ db: f.db, vault_path: f.vault }).pending).toBe(false);
      expect(getClaim(f.db, f.ids[0]!)!.receipt_id).not.toBeNull();
    } finally { f.db.close(); }
  });

  test("a failed progress receipt rolls back the skips in its batch", async () => {
    const f = await vaultWithNotes(2);
    try {
      f.db.exec(`CREATE TRIGGER fail_progress BEFORE INSERT ON run_receipts
        WHEN NEW.stopped = 'capture-repair:receipt-pending'
        BEGIN SELECT RAISE(FAIL, 'injected progress failure'); END`);
      const failed = await runRail(f.db, f.vault, "doctor-sweep");
      expect(failed.status).toBe("failed");
      expect(failed.captures_skipped).toBeUndefined();
      expect(countCaptureFanout(f.db)).toEqual({ pending: 2, skipped: 0 });
      f.db.exec("DROP TRIGGER fail_progress");
      const retry = await runRail(f.db, f.vault, "doctor-sweep");
      expect(retry.captures_skipped).toBe(2);
    } finally { f.db.close(); }
  });

  test("second-batch failure receipts the committed first batch exactly once", async () => {
    const f = await vaultWithNotes(501);
    try {
      f.db.exec(`CREATE TRIGGER fail_second_batch BEFORE UPDATE OF status ON claims
        WHEN NEW.status = 'skipped' AND (SELECT count(*) FROM claims WHERE status = 'skipped') >= 500
        BEGIN SELECT RAISE(FAIL, 'injected batch failure'); END`);
      const failed = await runRail(f.db, f.vault, "doctor-sweep");
      expect(failed.status).toBe("failed");
      expect(countCaptureFanout(f.db)).toEqual({ pending: 1, skipped: 500 });
      expect(failed.captures_skipped).toBe(500);
      expect(getRunReceipt(f.db, failed.run_id)?.captures_skipped).toBe(500);
      f.db.exec("DROP TRIGGER fail_second_batch");
      const retry = await runRail(f.db, f.vault, "doctor-sweep");
      expect(retry.captures_skipped).toBe(1);
      expect(readRunReceiptsLog(f.vault).reduce((sum, r) => sum + (r.captures_skipped ?? 0), 0)).toBe(501);
      expect(countCanonReceipts(f.db)).toBe(0);
    } finally { f.db.close(); }
  });

  test.each(["after-file", "after-jsonl"] as const)("restart recovers repair progress interrupted %s", async (crashAfter) => {
    const f = await vaultWithNotes(2);
    let originalOpen = true;
    try {
      await expect(runRail(f.db, f.vault, "doctor-sweep", { crashAfter })).rejects.toThrow();
      expect(countCaptureFanout(f.db)).toEqual({ pending: 0, skipped: 2 });
      // Reopen the ledger: recovery must depend on durable state alone.
      f.db.close();
      originalOpen = false;
      const restarted = openLedger(join(f.vault, ".kizuki", "kizuki.db"));
      try {
        if (crashAfter === "after-file") {
          // Retention must neither publish an interim report nor lose progress.
          pruneRunReceipts(restarted, f.vault, "2100-01-01T00:00:00.000Z");
          const lock = tryWriteFlock(f.vault);
          expect(lock).not.toBeNull();
          try {
            expect(recoverRunJournal(restarted, f.vault)).toEqual([]);
            expect(readRunReceiptsLog(f.vault)).toEqual([]);
          } finally { lock?.release(); }
        }
        recoverRunJournal(restarted, f.vault);
        recoverRunJournal(restarted, f.vault);
        expect(readRunReceiptsLog(f.vault).filter(r => r.captures_skipped === 2)).toHaveLength(1);
        const reports = restarted.query<{ report: string }, []>("SELECT report FROM run_receipts").all();
        expect(reports.filter(r => JSON.parse(r.report).captures_skipped === 2)).toHaveLength(1);
        const retry = await runRail(restarted, f.vault, "doctor-sweep");
        expect(retry.captures_skipped).toBeUndefined();
        expect(countCanonReceipts(restarted)).toBe(0);
      } finally { restarted.close(); }
    } finally { if (originalOpen) f.db.close(); }
  });

  test("sync before the sweep never writes a legacy message capture", async () => {
    const f = await vaultWithNotes(1);
    const producer: ProducerPort = {
      descriptor: { id: "fixture.producer", contract: "kizuki.producer/v1" as const, contract_minor: 0, kind: "producer", supports: ["model"], requires_lease: false, optional_package: null },
      health: async () => ({ status: "ready" as const, detail: {} }), close: async () => {},
      produce: async () => ({ status: "ok" as const, claims: [], usage: { calls: 1, input_tokens: 0, output_tokens: 0 } }),
    };
    try {
      const sync = await runRail(f.db, f.vault, "sync", {
        hooks: { model_ref: "fixture-model", producer, claims: { db: f.db } },
      });
      expect(sync.canon_writes).toBe(0);
      // The direct pass has the same protection, independent of the rail and repair limit.
      const pass = await runWritePass(f.db, f.vault, {
        budget: createBudgetTracker({ canon_writes_per_run: 10 }),
        model_ref: "fixture-model", producer, claims: { db: f.db },
      });
      expect(pass.canon_writes).toBe(0);
      expect(getClaim(f.db, f.ids[0]!)!.receipt_id).toBeNull();
      const sweep = await runRail(f.db, f.vault, "doctor-sweep");
      expect(sweep.captures_skipped).toBe(1);
      expect(countCanonReceipts(f.db)).toBe(0);
      expect(existsSync(join(f.vault, "auto", "captures"))).toBe(false);
    } finally { f.db.close(); }
  });

  test("a busy canon writer defers the repair to the next sweep", async () => {
    const f = await vaultWithNotes(2);
    try {
      const lock = tryWriteFlock(f.vault);
      expect(lock).not.toBeNull();
      try {
        const busy = await runRail(f.db, f.vault, "doctor-sweep", {
          now: () => "2026-09-29T08:00:00.000Z",
        });
        expect(busy.captures_skipped).toBeUndefined();
        expect(countCaptureFanout(f.db)).toEqual({ pending: 2, skipped: 0 });
      } finally {
        lock?.release();
      }
      const next = await runRail(f.db, f.vault, "doctor-sweep", {
        now: () => "2026-09-29T09:00:00.000Z",
      });
      expect(next.captures_skipped).toBe(2);
    } finally {
      f.db.close();
    }
  });
});
