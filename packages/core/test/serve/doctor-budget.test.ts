import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import { inspectServeDoctor } from "../../src/serve/doctor";
import { createDurableWriteBudget } from "../../src/serve/budget-ledger";
import { runRail } from "../../src/serve/rails";
import { fileProposal } from "../../src/staging/proposals";
import { initVault } from "../../src/vault/init";
import { putEvent } from "../claims/helpers";

for (const crashAfter of [undefined, "after-file", "after-jsonl", "after-db"] as const) {
  test(`doctor reports durable daily writes after ${crashAfter ?? "normal completion"} and reopen`, async () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-doctor-budget-"));
    initVault(vault);
    const dbPath = join(vault, ".kizuki/kizuki.db");
    let db = openLedger(dbPath);
    const now = () => new Date().toISOString();
    const day = now().slice(0, 10);
    const nextDay = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString();
    try {
      writeFileSync(join(vault, ".kizuki/serve.toml"), "[budget]\ncanon_writes_per_run = 1\ncanon_writes_per_day = 1\n");
      for (const name of ["grace", "ada"]) {
        const id = putEvent(db, { source_record_id: name });
        fileProposal(db, { kind: "claim", target: `people/${name}`, body: `${name} works at Acme.`,
          frontmatter: { type: "person", title: name }, provenance: [id], subjects: [`person:${name}`],
          producer: "deterministic", confidence: .8 });
      }
      const producer: ProducerPort = {
        descriptor: { id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1,
          supports: ["model"], requires_lease: false, optional_package: null },
        health: async () => ({ status: "ready", detail: {} }), close: async () => {},
        produce: async () => ({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 } }),
      };
      const hooks = () => ({ producer, claims: { db }, model_ref: "model:fixture" });
      const first = runRail(db, vault, "sync", { hooks: hooks(), now, ...(crashAfter === undefined ? {} : { crashAfter }) });
      if (crashAfter === undefined) expect((await first).canon_writes).toBe(1);
      else await expect(first).rejects.toThrow();
      db.close();
      db = openLedger(dbPath);
      expect(db.query("SELECT used FROM budget_ledger WHERE day=? AND name='canon_writes_per_day'").get(day)).toEqual({ used: 1 });
      expect(db.query("SELECT count(*) AS n FROM canon_receipts").get()).toEqual({ n: 1 });
      const before = db.query("SELECT total_changes() AS n").get();
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(inspectServeDoctor(db, vault, { now: now() }).model.budget.canon_writes_per_day).toEqual({ used: 1, limit: 1 });
      }
      expect(db.query("SELECT total_changes() AS n").get()).toEqual(before);
      expect(inspectServeDoctor(db, vault, { now: now() }).calibration.canon_writes_today).toBe(1);
      const resumed = await runRail(db, vault, "sync", { hooks: hooks(), now });
      expect(resumed.canon_writes).toBe(0);
      expect(resumed.stopped).toBe("budget:canon_writes_per_day");
      expect(resumed.budget.canon_writes_per_day).toEqual({ used: 1, limit: 1 });
      expect(inspectServeDoctor(db, vault, { now: now() }).model.budget.canon_writes_per_day).toEqual({ used: 1, limit: 1 });
      expect(inspectServeDoctor(db, vault, { now: nextDay }).model.budget.canon_writes_per_day).toEqual({ used: 0, limit: 1 });
    } finally { db.close(); rmSync(vault, { recursive: true, force: true }); }
  });
}


test("unreadable budget evidence returns an unavailable doctor report while write admission refuses", () => {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-doctor-budget-corrupt-"));
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  try {
    const path = join(vault, ".kizuki/receipts/promotions.jsonl");
    const bytes = '{"synthetic_private_receipt_body":';
    mkdirSync(join(vault, ".kizuki/receipts"), { recursive: true });
    writeFileSync(path, bytes);
    const before = db.query("SELECT total_changes() AS n").get();
    const report = inspectServeDoctor(db, vault);
    expect(report.ok).toBe(false);
    expect(report.model.budget.canon_writes_per_day?.used).toBeNull();
    expect(report.calibration.canon_writes_today).toBeNull();
    expect(report.failures).toContain("canon write budget unavailable: inspect canon receipt recovery");
    expect(JSON.stringify(report)).not.toContain("synthetic_private_receipt_body");
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(before);
    const budget = createDurableWriteBudget(db, vault, new Date().toISOString().slice(0, 10), {
      canon_writes_per_run: 1, canon_writes_per_day: 1,
    });
    expect(() => budget.chargeWrite({ receipt_id: "synthetic-denied", page_path: "facts/note.md", before_hash: null })).toThrow();
    expect(db.query("SELECT 1 FROM canon_write_reservations").get()).toBeNull();
  } finally { db.close(); rmSync(vault, { recursive: true, force: true }); }
});
