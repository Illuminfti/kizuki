import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonFixture, storeClaim, putEvent, write } from "./helpers";
import { CanonWriteError } from "../../src/canon/errors";
import { runWritePass } from "../../src/serve/write-pass";
import { createBudgetTracker } from "../../src/canon/budget";
import { DEFAULT_EXTRACTION_CONFIG } from "../../src/serve/types";
import { MAX_CANON_IMAGE_BYTES } from "../../src/ledger/canon-recovery-schema";
import * as canonApply from "../../src/canon/apply";
import { worldClaimHandle } from "../../src/canon/world-materialization";
import { worldFixture } from "../serving/world-fixture";
import { listQuarantinedPages, listQuarantinedClaims } from "../../src/serve/write-quarantine";

async function nearCapFixture() {
  const f = canonFixture();
  try {
    const event = putEvent(f.db), retained = [];
    for (let i = 0; i < 16; i++) retained.push(await storeClaim(f.db, event, {
      object: `synthetic-${i}`, body: `Neutral retained item ${i}: `.padEnd(64_000, "x"),
    }));
    const receipt = write(f.io, retained), path = join(f.vault, receipt.page_path), before = readFileSync(path);
    expect(before.byteLength).toBeLessThan(MAX_CANON_IMAGE_BYTES);
    expect(before.byteLength + 64_000).toBeGreaterThan(MAX_CANON_IMAGE_BYTES);
    const incoming = await storeClaim(f.db, event, { object: "synthetic-next", body: "Neutral incoming item: ".padEnd(64_000, "y") });
    return { ...f, event, incoming, before, path };
  } catch (error) { f.dispose(); throw error; }
}

test("a bounded claim that grows its existing page over the image cap refuses before durable effects or charging", async () => {
  const f = await nearCapFixture();
  try {
    const generation = f.db.query("SELECT * FROM canon_read_generation").all();
    const cursors = f.db.query("SELECT * FROM rail_cursors ORDER BY rail,source_key").all();
    let failure: unknown;
    try { write(f.io, f.incoming); } catch (error) { failure = error; }
    expect(readFileSync(f.path)).toEqual(f.before);
    expect(f.db.query("SELECT count(*) AS n FROM canon_write_intents").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM canon_receipts").get()).toEqual({ n: 1 });
    expect(f.db.query("SELECT * FROM canon_read_generation").all()).toEqual(generation);
    expect(f.db.query("SELECT * FROM rail_cursors ORDER BY rail,source_key").all()).toEqual(cursors);
    expect(f.db.query("SELECT status,receipt_id FROM claims WHERE claim_id=?").get(f.incoming.claim_id)).toEqual({ status: "live", receipt_id: null });
    expect(failure).toBeInstanceOf(CanonWriteError);
    expect((failure as CanonWriteError).code).toBe("page_too_large");
  } finally { f.dispose(); }
}, 30_000);

test("oversized output follows ordinary claim retry quarantine while a later healthy claim progresses", async () => {
  const f = await nearCapFixture();
  const now = "2026-10-22T12:00:00.000Z";
  let calls = 0;
  const producer = {
    descriptor: { id: "synthetic.no-model", kind: "producer" as const, contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
    health: async () => ({ status: "ready" as const, detail: {} }), close: async () => {},
    produce: async () => { calls++; throw new Error("synthetic model call forbidden"); },
  };
  try {
    const healthy = await storeClaim(f.db, f.event, { target: "people/linus", subject: "person:linus", subjects: ["person:linus"],
      object: "healthy", body: "Linus keeps neutral notes.", frontmatter: { type: "person", title: "Linus" } });
    for (let pass = 1; pass <= 3; pass++) {
      const result = await runWritePass(f.db, f.vault, { now: () => now, budget: createBudgetTracker({ canon_writes_per_run: 10 }), producer, claims: { db: f.db },
        model_ref: "synthetic/no-transport", extraction: { ...DEFAULT_EXTRACTION_CONFIG, max_calls_per_pass: 0 } });
      expect(result.model.calls).toBe(0);
      expect(result.stopped).toBeNull();
      expect(result.canon_writes).toBe(pass === 1 ? 1 : 0);
      expect(f.db.query("SELECT attempts,reason FROM canon_claim_retries WHERE claim_id=?").get(f.incoming.claim_id))
        .toEqual({ attempts: pass, reason: "page_too_large" });
      expect(readFileSync(f.path)).toEqual(f.before);
      expect(f.db.query("SELECT count(*) AS n FROM canon_write_intents").get()).toEqual({ n: 0 });
    }
    expect(f.db.query("SELECT receipt_id FROM claims WHERE claim_id=?").get(healthy.claim_id)).not.toEqual({ receipt_id: null });
    expect(listQuarantinedClaims(f.db, now).claims.map(row => row.claim_id)).toEqual([f.incoming.claim_id]);
    const fourth = await runWritePass(f.db, f.vault, { now: () => now, budget: createBudgetTracker({ canon_writes_per_run: 10 }), producer, claims: { db: f.db },
      model_ref: "synthetic/no-transport", extraction: { ...DEFAULT_EXTRACTION_CONFIG, max_calls_per_pass: 0 } });
    expect(fourth.errors).toEqual([]); expect(fourth.canon_writes).toBe(0); expect(calls).toBe(0);
    expect(f.db.query("SELECT attempts FROM canon_claim_retries WHERE claim_id=?").get(f.incoming.claim_id)).toEqual({ attempts: 3 });
    expect(f.db.query("SELECT status,receipt_id FROM claims WHERE claim_id=?").get(f.incoming.claim_id)).toEqual({ status: "live", receipt_id: null });
  } finally { f.dispose(); }
}, 30_000);


test("the typed-page path uses its existing quarantine for the same image admission refusal", async () => {
  const f = canonFixture(), now = "2026-10-22T12:00:00.000Z";
  const producer = {
    descriptor: { id: "synthetic.no-model", kind: "producer" as const, contract: "kizuki.producer/v1", contract_minor: 1, supports: ["model"], requires_lease: false, optional_package: null },
    health: async () => ({ status: "ready" as const, detail: {} }), close: async () => {},
    produce: async () => { throw new Error("synthetic model call forbidden"); },
  };
  try {
    const world = await worldFixture(f.db, { subject: "topic:image-bound", label: "Image bound" });
    const handle = worldClaimHandle(f.db, world.claims[0]!)!;
    const refused = spyOn(canonApply, "applyCanonWriteOwned").mockImplementation(() => {
      throw new CanonWriteError("page_too_large", "canon after image exceeds the recovery byte limit");
    });
    try {
      const pass = () => runWritePass(f.db, f.vault, { now: () => now, budget: createBudgetTracker({ canon_writes_per_run: 10 }),
        producer, claims: { db: f.db }, model_ref: "synthetic/no-transport", extraction: { ...DEFAULT_EXTRACTION_CONFIG, max_calls_per_pass: 0 } });
      for (let i = 0; i < 3; i++) {
        const result = await pass();
        expect(result.stopped).toBeNull(); expect(result.canon_writes).toBe(0);
        expect(result.errors.some(error => error.includes("canon after image exceeds the recovery byte limit"))).toBe(true);
      }
      expect(listQuarantinedPages(f.db, now)).toMatchObject([{ handle, attempts: 3 }]);
      expect((await pass()).errors).toEqual([]); expect(refused).toHaveBeenCalledTimes(3);
      expect(f.db.query("SELECT count(*) AS n FROM canon_write_intents").get()).toEqual({ n: 0 });
      expect(f.db.query("SELECT count(*) AS n FROM canon_claim_retries").get()).toEqual({ n: 0 });
    } finally { refused.mockRestore(); }
  } finally { f.dispose(); }
}, 30_000);
