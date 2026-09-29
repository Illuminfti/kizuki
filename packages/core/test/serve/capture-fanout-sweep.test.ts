import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countCaptureFanout } from "../../src/claims/capture-fanout";
import { getClaim } from "../../src/claims/store";
import { countCanonReceipts } from "../../src/canon/receipts";
import { openLedger } from "../../src/ledger/db";
import { tryWriteFlock } from "../../src/serve/flock";
import { runRail } from "../../src/serve/rails";
import { getRunReceipt } from "../../src/serve/receipts";
import { initVault } from "../../src/vault/init";
import { putEvent, storeClaim } from "../canon/helpers";

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
