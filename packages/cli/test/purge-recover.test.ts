import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accept, insertClaim, serializePage } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { purgeEvents, setPurgeRecoveryHook } from "../../core/src/ledger/purge";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const { cleanup, runCliAsync, tempVault } = createHelpers();
const AT = "2026-09-06T16:00:00.000Z";
const MARKER = "zqxrecovermarker9902";
afterEach(() => { setPurgeRecoveryHook(); cleanup(); });

async function interrupted(stage: "phase-one-committed" | "discovery-held") {
  const setup = tempVault();
  const path = join(setup.vault, ".kizuki", "kizuki.db");
  const db = openLedger(path);
  const stored = accept(db, {
    schema: "kizuki.event/v1", connector_id: "fixture", source_record_id: "note-1", kind: "message",
    text: `Retired note ${MARKER}`, occurred_at: AT, observed_at: AT, subjects: [], attachments: [], metadata: {},
    sensitivity_hint: "personal", deleted: false,
  });
  if (stored.status !== "stored") throw new Error("event was not stored");
  const body = `Retired note ${MARKER}`;
  const claim = await insertClaim({ db, now: () => AT }, {
    kind: "claim", target: "facts/note", body, provenance: [stored.event.event_id],
    producer: "deterministic", confidence: 0.8, sensitivity: "personal", taint: "quoted",
  });
  if (claim.outcome !== "stored") throw new Error("claim was not stored");
  writeFileSync(join(setup.vault, "facts/note.md"), serializePage({
    data: { id: "note", title: "note", type: "fact", status: "active", sensitivity: "personal", taint: "quoted", sources: [`event:${stored.event.event_id}`] },
    body: `${body}\n`,
  }), { mode: 0o600 });
  setPurgeRecoveryHook(hit => { if (hit === stage) throw new Error("simulated crash"); });
  expect(() => purgeEvents(db, setup.vault, { event_id: stored.event.event_id }, "retire", { now: () => AT })).toThrow("simulated crash");
  setPurgeRecoveryHook();
  db.close();
  return { ...setup, path, claimId: claim.claim.claim_id };
}

for (const stage of ["phase-one-committed", "discovery-held"] as const) {
  test(`recover finishes a purge interrupted at ${stage}`, async () => {
    const f = await interrupted(stage);
    const before = openLedger(f.path);
    try {
      // The crash left the hold in place and the claim text on disk.
      expect(before.query("SELECT state FROM purge_batches").all()).toEqual([{ state: "discovering" }]);
      expect(before.query<{ body: string }, []>("SELECT body FROM claims").get()!.body).toContain(MARKER);
    } finally { before.close(); }

    const result = await runCliAsync(f.env, "recover", "--json");
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("ok");
    expect(report.data.purges_resumed).toHaveLength(1);
    expect(report.data.purges_pending).toEqual([]);

    const db = openLedger(f.path);
    try {
      expect(db.query("SELECT state FROM purge_batches").all()).toEqual([{ state: "ready" }]);
      expect(db.query("SELECT 1 FROM canon_holds").all()).toEqual([]);
      const claim = db.query<{ body: string; status: string }, [string]>("SELECT body, status FROM claims WHERE claim_id = ?").get(f.claimId)!;
      expect(claim).toEqual({ body: "", status: "purged" });
    } finally { db.close(); }
    expect(readFileSync(join(f.vault, "facts/note.md"), "utf8")).not.toContain(MARKER);
    // The database file and its log hold no trace either, whether or not the compaction ran.
    for (const name of ["kizuki.db", "kizuki.db-wal"]) {
      if (existsSync(join(f.vault, ".kizuki", name))) expect(readFileSync(join(f.vault, ".kizuki", name)).includes(MARKER)).toBe(false);
    }
    for (const name of existsSync(join(f.vault, "archive")) ? readdirSync(join(f.vault, "archive")) : []) {
      expect(readFileSync(join(f.vault, "archive", name), "utf8")).not.toContain(MARKER);
    }

    const again = JSON.parse((await runCliAsync(f.env, "recover", "--json")).stdout);
    expect(again.data.purges_resumed).toEqual([]);
  });
}
