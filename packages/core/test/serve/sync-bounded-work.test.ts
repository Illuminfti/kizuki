import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import { runRail } from "../../src/serve/rails";
import { listRunReceipts } from "../../src/serve/receipts";
import { fileProposal } from "../../src/staging/proposals";
import { initVault } from "../../src/vault/init";
import { putEvent } from "../claims/helpers";

const MODEL_REF = "kizuki.llm.openai-compatible:synthetic@local";
const EVENTS = 2_000;
const CLAIMS = 40;
const KILLED_RUN = "01J0000000000000000000KZ00";
/** Above every platform's pid ceiling, so the holder can never be alive. */
const DEAD_PID = 2 ** 22 + 1;

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Counts native statement preparation on this ledger connection only. */
function countedVault() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-sync-bounded-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  const counter = { prepares: 0 };
  const original = Database.prototype.prepare;
  Database.prototype.prepare = function (this: Database, ...args: Parameters<Database["prepare"]>) {
    counter.prepares += 1;
    return Reflect.apply(original, this, args);
  } as Database["prepare"];
  try { return { path, db: openLedger(join(path, ".kizuki", "kizuki.db")), counter }; }
  finally { Database.prototype.prepare = original; }
}

const unavailableModel: ProducerPort = {
  descriptor: {
    id: "kizuki.producer.fixture",
    kind: "producer",
    contract: "kizuki.producer/v1",
    contract_minor: 1,
    supports: ["model"],
    requires_lease: false,
    optional_package: null,
  },
  health: async () => ({ status: "ready", detail: {} }),
  close: async () => undefined,
  produce: async () => ({
    status: "unavailable",
    reason: "http",
    usage: { calls: 1, input_tokens: 0, output_tokens: 0 },
    diagnostic: { stage: "transport", rule: "http", http_status: 402 },
  }),
};

test("sync over a large backlog with an unavailable model does bounded statement work and makes progress", async () => {
  const { path, db, counter } = countedVault();
  try {
    const events = db.transaction(() => Array.from({ length: EVENTS }, (_, index) =>
      putEvent(db, { source_record_id: `synthetic-${index}`, text: `Synthetic note ${index % 10}.` })))();
    for (let index = 0; index < CLAIMS; index++) {
      const filed = fileProposal(db, {
        kind: "claim",
        target: `notes/synthetic-${index}`,
        body: `Synthetic fact ${index}.`,
        frontmatter: { type: "topic", title: `Synthetic ${index}` },
        provenance: [events[index * 7]!],
        subjects: [`topic:synthetic-${index}`],
        producer: "deterministic",
        confidence: 0.8,
      });
      if (filed.outcome !== "stored") throw new Error("expected stored claim");
    }
    // A run killed after its model decision leaves this row for journal recovery.
    db.query("INSERT INTO extract_usage(run_id,model_ref,metrics,created_at,holder_pid) VALUES (?,?,?,?,?)").run(
      KILLED_RUN, MODEL_REF,
      JSON.stringify({ claims_rejected: {}, claims_extracted: 0,
        model: { calls: 1, input_tokens: 0, output_tokens: 0, unavailable: 1, wall_ms: 1 } }),
      "2026-09-24T00:00:00.000Z", DEAD_PID,
    );
    const hooks = { producer: unavailableModel, claims: { db }, model_ref: MODEL_REF };

    const passes = [];
    for (let pass = 0; pass < 3; pass++) {
      const before = counter.prepares;
      const receipt = await runRail(db, path, "sync", { hooks });
      passes.push({ receipt, prepares: counter.prepares - before });
    }

    // The unavailable model is one cheap typed stop; canon writing still drains the backlog.
    expect(passes.map(({ receipt }) => [receipt.stopped, receipt.canon_writes, receipt.model.calls, receipt.model.unavailable]))
      .toEqual([["model:unavailable", 32, 1, 1], ["model:unavailable", CLAIMS - 32, 1, 1], ["model:unavailable", 0, 1, 1]]);
    // The killed run is published once as failed and never replayed.
    expect(listRunReceipts(db).filter(receipt => receipt.run_id === KILLED_RUN).map(receipt => [receipt.status, receipt.errors]))
      .toEqual([["failed", ["sync interrupted after model decision"]]]);
    // Preparation follows distinct SQL and writes, never writes times canon pages.
    const [first, second, third] = passes.map(({ prepares }) => prepares);
    expect(first).toBeLessThan(1_000);
    expect(second).toBeLessThan(250);
    expect(third).toBeLessThan(250);
  } finally {
    db.close();
  }
}, 120_000);
