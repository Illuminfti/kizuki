import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import { inspectServeDoctor } from "../../src/serve/doctor";
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
      const resumed = await runRail(db, vault, "sync", { hooks: hooks(), now });
      expect(resumed.canon_writes).toBe(0);
      expect(resumed.stopped).toBe("budget:canon_writes_per_day");
      expect(resumed.budget.canon_writes_per_day).toEqual({ used: 1, limit: 1 });
      expect(inspectServeDoctor(db, vault, { now: now() }).model.budget.canon_writes_per_day).toEqual({ used: 1, limit: 1 });
      expect(inspectServeDoctor(db, vault, { now: nextDay }).model.budget.canon_writes_per_day).toEqual({ used: 0, limit: 1 });
    } finally { db.close(); rmSync(vault, { recursive: true, force: true }); }
  });
}
