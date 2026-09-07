import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import type { ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import { createModelProducerPort, MODEL_PRODUCER_DESCRIPTOR } from "../../src/producer/model";
import { mineLiveDrafts, readExtractCursor } from "../../src/serve/extract";
import { runRail } from "../../src/serve/rails";
import { runReceiptsPath } from "../../src/serve/receipts";
import { runWritePass } from "../../src/serve/write-pass";
import { initVault } from "../../src/vault/init";
import { putEvent } from "../claims/helpers";
import { draft, FIXED_NOW, responseText, scriptedLlm } from "../producer/helpers";

const CANARY = "synthetic-private-port-result-canary";
const usage = { calls: 1, input_tokens: 10, output_tokens: 3 };
const badResults = [
  { status: CANARY, usage },
  { status: "rejected", reason: CANARY, usage },
  { status: "rejected", reason: "schema_invalid", usage, diagnostic: { stage: "response", rule: "bad_response", text: CANARY } },
  { status: "unavailable", reason: CANARY, usage: { ...usage, calls: -1 } },
  { status: "ok", claims: [], usage: { ...usage, output_tokens: Infinity } },
  { status: "ok", claims: [], usage, dropped: [{ reason: CANARY }] },
];

for (const rejectedCount of [1, 2]) {
  test(`${rejectedCount} malformed model claims are counted once in durable rail receipts without changing sibling authority`, async () => {
    const path = mkdtempSync(join(tmpdir(), "kizuki-partial-result-"));
    initVault(path);
    const db = openLedger(join(path, ".kizuki/kizuki.db"));
    try {
      const eventId = putEvent(db);
      const valid = draft({ subject: "person:ada", event_ids: [eventId] });
      const llm = scriptedLlm(() => responseText([
        ...Array.from({ length: rejectedCount + 1 }, (_, i) => ({ ...valid, object: `synthetic role ${i}` })),
        ...Array.from({ length: rejectedCount }, () => ({ ...valid, sensitivity: CANARY })),
      ]));
      const producer = createModelProducerPort({ vault_path: path, data_dir: join(path, ".kizuki/producer"), config: {},
        secrets: async () => { throw new Error("unused fixture secret"); }, clock: () => FIXED_NOW, logger: () => {},
      }, { llm });
      const hooks = { producer, claims: { db }, model_ref: "test.kizuki.llm.scripted:synthetic@127.0.0.1" };
      const receipt = await runRail(db, path, "sync", { hooks });
      expect(receipt.claims_extracted).toBe(rejectedCount + 1);
      expect(receipt.model.calls).toBe(1);
      expect(receipt.claims_rejected).toEqual({ schema_invalid: rejectedCount });
      expect(readExtractCursor(db)).not.toBeNull();
      const claims = db.query<{ authority: string; taint: string }, []>("SELECT authority,taint FROM claims").all();
      expect(claims.length).toBeGreaterThan(0);
      for (const claim of claims) expect(claim).toEqual({ authority: "model_inference", taint: "untrusted" });

      const stored = db.query<{ report: string }, [string]>("SELECT report FROM run_receipts WHERE run_id=?").get(receipt.run_id)!;
      expect(JSON.parse(stored.report).claims_rejected).toEqual({ schema_invalid: rejectedCount });
      const lines = readFileSync(runReceiptsPath(path), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(lines.find(line => line.run_id === receipt.run_id).claims_rejected).toEqual({ schema_invalid: rejectedCount });
      expect(stored.report).not.toContain(CANARY);
      expect(JSON.stringify(lines)).not.toContain(CANARY);

      const next = await runRail(db, path, "sync", { hooks });
      expect(next.model.calls).toBe(0);
      expect(next.claims_rejected).toEqual({});
      expect(llm.requests).toHaveLength(1);
      expect(db.query<{ report: string }, [string]>("SELECT report FROM run_receipts WHERE run_id=?").get(receipt.run_id)!.report).toBe(stored.report);
      await producer.close();
    } finally { db.close(); rmSync(path, { recursive: true, force: true }); }
  });
}

for (const seam of ["mine", "write", "rail"] as const) {
  test(`${seam} validates returned failures and throws before reports or durable decisions`, async () => {
    const calls: (() => unknown)[] = [
      ...badResults.map(value => () => value),
      () => { throw new Error(CANARY); },
      () => Promise.reject(new Error(CANARY)),
    ];
    for (const effect of calls) {
      const path = mkdtempSync(join(tmpdir(), "kizuki-result-boundary-"));
      initVault(path);
      const db = openLedger(join(path, ".kizuki/kizuki.db"));
      let count = 0;
      const producer: ProducerPort = { descriptor: MODEL_PRODUCER_DESCRIPTOR,
        health: async () => ({ status: "ready", detail: {} }), close: async () => {},
        produce: () => { count++; return effect() as ReturnType<ProducerPort["produce"]>; } };
      try {
        putEvent(db);
        const hooks = { producer, claims: { db }, model_ref: "kizuki.llm.synthetic:result-boundary" };
        const result = seam === "mine" ? await mineLiveDrafts(db, producer)
          : seam === "write" ? await runWritePass(db, path, { ...hooks, budget: createBudgetTracker({ canon_writes_per_run: 1 }) })
          : await runRail(db, path, "sync", { hooks });
        expect(count).toBe(1);
        expect(JSON.stringify(result)).not.toContain(CANARY);
        expect(readExtractCursor(db)).toBeNull();
        expect(db.query("SELECT 1 FROM claims").get()).toBeNull();
        expect(db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
        for (const table of ["extract_usage", "run_receipts"]) {
          expect(JSON.stringify(db.query(`SELECT * FROM ${table}`).all())).not.toContain(CANARY);
        }
        if ("model" in result) expect(result.model).toMatchObject({ calls: 1, usage_unknown: true });
        if (seam === "rail") expect(readFileSync(runReceiptsPath(path), "utf8")).not.toContain(CANARY);
        if (seam === "write") {
          const row = db.query<{ metrics: string }, []>("SELECT metrics FROM extract_usage").get();
          expect(JSON.parse(row!.metrics).model).toMatchObject({ calls: 1, usage_unknown: true });
        }
      } finally { db.close(); rmSync(path, { recursive: true, force: true }); }
    }
  });
}

test("valid legacy unavailable text is projected safely without losing known usage", async () => {
  const path = mkdtempSync(join(tmpdir(), "kizuki-result-unavailable-"));
  initVault(path);
  const db = openLedger(join(path, ".kizuki/kizuki.db"));
  try {
    putEvent(db);
    const producer: ProducerPort = { descriptor: MODEL_PRODUCER_DESCRIPTOR,
      health: async () => ({ status: "ready", detail: {} }), close: async () => {},
      produce: async () => ({ status: "unavailable", reason: CANARY, usage }) };
    const receipt = await runRail(db, path, "sync", { hooks: { producer, claims: { db }, model_ref: "kizuki.llm.synthetic:result-boundary" } });
    expect(receipt.stopped).toBe("model:unavailable");
    expect(receipt.model).toMatchObject(usage);
    expect(receipt.model.usage_unknown).toBeUndefined();
    expect(JSON.stringify(db.query("SELECT * FROM run_receipts").all())).not.toContain(CANARY);
    expect(readFileSync(runReceiptsPath(path), "utf8")).not.toContain(CANARY);
  } finally { db.close(); rmSync(path, { recursive: true, force: true }); }
});
