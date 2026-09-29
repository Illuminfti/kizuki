import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import type { ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import { runRail } from "../../src/serve/rails";
import { STOP_REQUESTED, runWritePass } from "../../src/serve/write-pass";
import { tryWriteFlock } from "../../src/serve/flock";
import { fileProposal } from "../../src/staging/proposals";
import { initVault } from "../../src/vault/init";
import { putEvent } from "../claims/helpers";

const dirs: string[] = [];
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const producer: ProducerPort = {
  descriptor: { id: "kizuki.producer.fixture", kind: "producer", contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
  health: async () => ({ status: "ready", detail: {} }),
  close: async () => {},
  produce: async () => ({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 }, dropped: [] }),
};

/** A vault with `pages` unwritten claims, each for a page of its own. */
function pending(pages: number) {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-write-release-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  for (let index = 0; index < pages; index += 1) {
    const filed = fileProposal(db, {
      kind: "claim", target: `people/person-${index}`, body: `Person ${index} works at Acme.`,
      frontmatter: { type: "person", title: `Person ${index}` },
      provenance: [putEvent(db, { source_record_id: `person-${index}` })], subjects: [`person:${index}`],
      producer: "deterministic", confidence: 0.8,
    });
    if (filed.outcome !== "stored") throw new Error("expected stored claim");
  }
  const written = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_receipts").get()!.n;
  const options = (extra: { stopRequested?: () => boolean } = {}) => ({
    budget: createBudgetTracker({ canon_writes_per_run: 32 }), model_ref: "fixture/model", claims: { db }, producer, ...extra,
  });
  return { path, db, written, options };
}

test("the pass lets the writer go before every page", async () => {
  const { path, db, written, options } = pending(4);
  const free: boolean[] = [];
  const result = await runWritePass(db, path, options({
    stopRequested: () => {
      // The pass asks before each page, with nothing held: another operation could take the writer now.
      const lock = tryWriteFlock(path);
      free.push(lock !== null);
      lock?.release();
      return false;
    },
  }));
  expect(result.canon_writes).toBe(4);
  expect(written()).toBe(4);
  // One check per page, one after the last, and the extraction step before them.
  expect(free.length).toBeGreaterThanOrEqual(5);
  expect(free.every(Boolean)).toBe(true);
  db.close();
});

test("a stop request between two pages ends the pass with at most one more page", async () => {
  const { path, db, written, options } = pending(6);
  let requested = false;
  const result = await runWritePass(db, path, options({
    stopRequested: () => {
      if (written() >= 2) requested = true;
      return requested;
    },
  }));
  expect(result.stopped).toBe(STOP_REQUESTED);
  expect(result.canon_writes).toBe(2);
  expect(written()).toBe(2);
  db.close();
});

test("a run budget below 32 stops the pass at its limit", async () => {
  const { path, db, options } = pending(5);
  const capped = await runWritePass(db, path, { ...options(), budget: createBudgetTracker({ canon_writes_per_run: 3 }) });
  expect(capped.canon_writes).toBe(3);
  expect(capped.stopped).toBe("budget:canon_writes_per_run");
  const rest = await runWritePass(db, path, options());
  expect(rest.canon_writes).toBe(2);
  db.close();
});

test("serve.toml's canon_writes_per_run raises the pages a sync rail writes per pass past 32, and lowers them below", async () => {
  const { path, db, options } = pending(34);
  const hooks = { model_ref: "fixture/model", producer, claims: { db } };
  writeFileSync(join(path, ".kizuki", "serve.toml"), "[budget]\ncanon_writes_per_run = 3\n");
  const small = await runRail(db, path, "sync", { hooks });
  expect(small.canon_writes).toBe(3);
  expect(small.stopped).toBe("budget:canon_writes_per_run");
  writeFileSync(join(path, ".kizuki", "serve.toml"), "[budget]\ncanon_writes_per_run = 40\n");
  const large = await runRail(db, path, "sync", { hooks });
  expect(large.canon_writes).toBe(31);
  const rest = await runWritePass(db, path, options());
  expect(rest.canon_writes).toBe(0);
  db.close();
}, 120_000);

test("without a configured value one pass still writes at most 32 pages", async () => {
  const { path, db, options } = pending(33);
  const first = await runWritePass(db, path, options());
  expect(first.canon_writes).toBe(32);
  expect(first.stopped).toBeNull();
  expect((await runWritePass(db, path, options())).canon_writes).toBe(1);
  db.close();
}, 120_000);
