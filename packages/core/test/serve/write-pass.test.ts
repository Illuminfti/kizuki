import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker, ordinaryDailyOccupancy } from "../../src/canon/budget";
import { RECEIPTS_PATH } from "../../src/canon/receipts";
import { getClaim, listClaims, reviveUncontestedSkipped } from "../../src/claims/store";
import type { ProduceResult, ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import { createDurableWriteBudget } from "../../src/serve/budget-ledger";
import { runRail } from "../../src/serve/rails";
import { readExtractCursor } from "../../src/serve/extract";
import { runWritePass } from "../../src/serve/write-pass";
import { fileProposal } from "../../src/staging/proposals";
import { initVault } from "../../src/vault/init";
import { putEvent } from "../claims/helpers";

function stubProducer(result: ProduceResult): ProducerPort {
  return {
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
    produce: async () => result,
  };
}

function boundWriteOptions(db: ReturnType<typeof openLedger>, budget: ReturnType<typeof createBudgetTracker>) {
  return {
    budget,
    model_ref: "kizuki.llm.openai-compatible:synthetic@local",
    claims: { db },
    producer: stubProducer({
      status: "ok",
      claims: [],
      usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
      dropped: [],
    }),
  };
}

function filePerson(
  db: ReturnType<typeof openLedger>,
  eventId: string,
  name: "grace" | "ada",
) {
  const title = name === "grace" ? "Grace" : "Ada";
  const filed = fileProposal(db, {
    kind: "claim",
    target: `people/${name}`,
    body: `${title} works at Acme.`,
    frontmatter: { type: "person", title },
    provenance: [eventId],
    subjects: [`person:${name}`],
    producer: "deterministic",
    confidence: 0.8,
  });
  if (filed.outcome !== "stored") throw new Error("expected stored claim");
  return filed.proposal.proposal_id;
}

/** Fails the receipt row insert only, after the file and the JSONL line. */
function failingOnReceiptRow(db: Database): Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "query") {
        return (sql: string) => {
          if (sql.includes("INSERT INTO canon_receipts")) {
            throw new Error("synthetic storage failure");
          }
          return target.query(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const dirs: string[] = [];

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function vault() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-write-pass-"));
  dirs.push(directory);
  const path = join(directory, "vault");
  initVault(path);
  const db = openLedger(join(path, ".kizuki", "kizuki.db"));
  return { path, db };
}

describe("write pass", () => {
  test("ingest files a live claim that stays unwritten without a model", async () => {
    const { path, db } = vault();
    const eventId = putEvent(db);
    const filed = fileProposal(db, {
      kind: "claim",
      target: "people/grace",
      body: "Grace runs partnerships at Acme.",
      frontmatter: { type: "person", title: "Grace" },
      provenance: [eventId],
      subjects: ["person:grace"],
      producer: "deterministic",
      confidence: 0.8,
    });
    if (filed.outcome !== "stored") throw new Error("expected stored");
    expect(getClaim(db, filed.proposal.proposal_id)?.status).toBe("live");

    const receipt = await runRail(db, path, "sync");
    expect(receipt.canon_writes).toBe(0);
    expect(getClaim(db, filed.proposal.proposal_id)?.receipt_id).toBeNull();
    db.close();
  });

  test("a configured model writes the live claim through applyCanonWrite", async () => {
    const { path, db } = vault();
    const eventId = putEvent(db);
    const filed = fileProposal(db, {
      kind: "claim",
      target: "people/grace",
      body: "Grace runs partnerships at Acme.",
      frontmatter: { type: "person", title: "Grace" },
      provenance: [eventId],
      subjects: ["person:grace"],
      producer: "deterministic",
      confidence: 0.8,
    });
    if (filed.outcome !== "stored") throw new Error("expected stored");

    const receipt = await runRail(db, path, "sync", {
      hooks: {
        model_ref: "kizuki.llm.openai-compatible:synthetic@local",
        producer: stubProducer({
          status: "ok",
          claims: [],
          usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
          dropped: [],
        }),
        claims: { db },
      },
    });
    expect(receipt.canon_writes).toBe(1);
    expect(receipt.claims_written).toBe(1);
    expect(receipt.stopped).toBeNull();
    const claim = getClaim(db, filed.proposal.proposal_id);
    expect(claim?.status).toBe("live");
    expect(claim?.receipt_id).toBeString();
    expect(existsSync(join(path, "auto", "people", "grace.md"))).toBe(true);
    expect(existsSync(join(path, "people", "grace.md"))).toBe(false);
    db.close();
  });

  test("a derived refresh failure retains the receipted canon-write count and charges its daily budget", async () => {
    const { path, db } = vault();
    const eventId = putEvent(db);
    fileProposal(db, {
      kind: "claim", target: "people/grace", body: "Grace runs partnerships at Acme.",
      frontmatter: { type: "person", title: "Grace" }, provenance: [eventId], subjects: ["person:grace"],
      producer: "deterministic", confidence: 0.8,
    });
    const { budget: _budget, ...hooks } = boundWriteOptions(db, createBudgetTracker({ canon_writes_per_run: 8 }));
    const receipt = await runRail(db, path, "sync", {
      hooks: {
        ...hooks,
        refresh: async () => { throw new Error("synthetic derived failure"); },
      },
    });
    expect(receipt.status).toBe("degraded");
    expect(receipt.canon_writes).toBe(1);
    expect(db.query<{ used: number }, []>("SELECT used FROM budget_ledger WHERE name = 'canon_writes_per_day'").get()?.used).toBe(1);
    db.close();
  });

  test("a raw serve.toml model string never enables standalone canon writes", async () => {
    const { path, db } = vault();
    const eventId = putEvent(db);
    fileProposal(db, {
      kind: "claim",
      target: "people/grace",
      body: "Grace runs partnerships at Acme.",
      frontmatter: { type: "person", title: "Grace" },
      provenance: [eventId],
      subjects: ["person:grace"],
      producer: "deterministic",
      confidence: 0.8,
    });
    mkdirSync(join(path, ".kizuki"), { recursive: true });
    writeFileSync(
      join(path, ".kizuki", "serve.toml"),
      '[ports.llm]\nid = "kizuki.llm.openai-compatible"\nmodel = "synthetic@local"\n',
    );
    const receipt = await runRail(db, path, "sync");
    expect(receipt.canon_writes).toBe(0);
    expect(receipt.model.model_ref).toBeNull();
    expect(existsSync(join(path, "auto", "people", "grace.md"))).toBe(false);
    db.close();
  });

  test("the write budget stops the pass without inventing a review queue", async () => {
    const { path, db } = vault();
    const first = putEvent(db, { source_record_id: "one" });
    const second = putEvent(db, { source_record_id: "two" });
    fileProposal(db, {
      kind: "claim",
      target: "people/grace",
      body: "Grace runs partnerships at Acme.",
      frontmatter: { type: "person", title: "Grace" },
      provenance: [first],
      subjects: ["person:grace"],
      producer: "deterministic",
      confidence: 0.8,
    });
    fileProposal(db, {
      kind: "claim",
      target: "people/ada",
      body: "Ada works at Acme.",
      frontmatter: { type: "person", title: "Ada" },
      provenance: [second],
      subjects: ["person:ada"],
      producer: "deterministic",
      confidence: 0.8,
    });

    const result = await runWritePass(db, path, boundWriteOptions(
      db,
      createBudgetTracker({ canon_writes_per_run: 1 }),
    ));
    expect(result.canon_writes).toBe(1);
    expect(result.stopped).toBe("budget:canon_writes_per_run");
    db.close();
  });

  test("uncontested skipped leftovers revive so they can be written", () => {
    const { db } = vault();
    const eventId = putEvent(db);
    const filed = fileProposal(db, {
      kind: "claim",
      target: "people/grace",
      body: "Grace runs partnerships at Acme.",
      frontmatter: { type: "person", title: "Grace" },
      provenance: [eventId],
      subjects: ["person:grace"],
      producer: "deterministic",
      confidence: 0.8,
    });
    if (filed.outcome !== "stored") throw new Error("expected stored");
    db.query("UPDATE claims SET status = 'skipped' WHERE claim_id = ?").run(
      filed.proposal.proposal_id,
    );
    expect(getClaim(db, filed.proposal.proposal_id)?.status).toBe("skipped");
    expect(reviveUncontestedSkipped(db)).toBe(1);
    expect(getClaim(db, filed.proposal.proposal_id)?.status).toBe("live");
    db.close();
  });

  test("an edit of a human page stays on that page", async () => {
    const { path, db } = vault();
    mkdirSync(join(path, "people"), { recursive: true, mode: 0o700 });
    chmodSync(join(path, "people"), 0o700);
    const ownerPage = join(path, "people", "grace.md");
    writeFileSync(
      ownerPage,
      [
        "---",
        "id: person:grace",
        "title: Grace",
        "type: person",
        "status: active",
        "sensitivity: personal",
        "taint: clean",
        "---",
        "",
        "Grace keeps the partnership notes.",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    chmodSync(ownerPage, 0o600);
    const eventId = putEvent(db);
    fileProposal(db, {
      kind: "claim",
      target: "people/grace",
      body: "Grace runs partnerships at Acme.",
      frontmatter: { type: "person", title: "Grace" },
      provenance: [eventId],
      subjects: ["person:grace"],
      producer: "deterministic",
      confidence: 0.8,
    });
    const result = await runWritePass(db, path, boundWriteOptions(
      db,
      createBudgetTracker({ canon_writes_per_run: 8 }),
    ));
    // A page with no receipt is owner prose: the loop skips it and
    // does not open a parallel auto/ copy.
    expect(result.errors).toEqual([]);
    expect(result.canon_writes).toBe(0);
    expect(existsSync(join(path, "people", "grace.md"))).toBe(true);
    expect(existsSync(join(path, "auto", "people", "grace.md"))).toBe(false);
    db.close();
  });

  test("a held write-pass flock returns lock:busy and writes nothing", async () => {
    const { path, db } = vault();
    mkdirSync(join(path, ".kizuki"), { recursive: true });
    writeFileSync(join(path, ".kizuki", "write-pass.lock"), `${process.pid}\n`);
    const eventId = putEvent(db);
    fileProposal(db, {
      kind: "claim",
      target: "people/grace",
      body: "Grace runs partnerships at Acme.",
      frontmatter: { type: "person", title: "Grace" },
      provenance: [eventId],
      subjects: ["person:grace"],
      producer: "deterministic",
      confidence: 0.8,
    });
    const result = await runWritePass(db, path, boundWriteOptions(
      db,
      createBudgetTracker({ canon_writes_per_run: 8 }),
    ));
    expect(result.stopped).toBe("lock:busy");
    expect(result.canon_writes).toBe(0);
    expect(existsSync(join(path, "auto", "people", "grace.md"))).toBe(false);
    db.close();
  });

  test("skipped owner pages do not stall later writeable claims", async () => {
    const { path, db } = vault();
    mkdirSync(join(path, "people"), { recursive: true, mode: 0o700 });
    chmodSync(join(path, "people"), 0o700);
    for (let index = 0; index < 32; index += 1) {
      const slug = `skip-${String(index).padStart(2, "0")}`;
      const ownerPage = join(path, "people", `${slug}.md`);
      writeFileSync(
        ownerPage,
        [
          "---",
          `id: person:${slug}`,
          `title: ${slug}`,
          "type: person",
          "status: active",
          "sensitivity: personal",
          "taint: clean",
          "---",
          "",
          `${slug} keeps owner notes.`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      chmodSync(ownerPage, 0o600);
      fileProposal(db, {
        kind: "claim",
        target: `people/${slug}`,
        body: `${slug} keeps owner notes.`,
        frontmatter: { type: "person", title: slug },
        provenance: [putEvent(db, { source_record_id: slug })],
        subjects: [`person:${slug}`],
        producer: "deterministic",
        confidence: 0.8,
      });
    }
    fileProposal(db, {
      kind: "claim",
      target: "people/ada",
      body: "Ada works at Acme.",
      frontmatter: { type: "person", title: "Ada" },
      provenance: [putEvent(db, { source_record_id: "ada" })],
      subjects: ["person:ada"],
      producer: "deterministic",
      confidence: 0.8,
    });
    const budget = createBudgetTracker({ canon_writes_per_run: 8 });
    const result = await runWritePass(db, path, boundWriteOptions(db, budget));
    expect(result.errors).toEqual([]);
    expect(result.canon_writes).toBe(1);
    expect(budget.usage().canon_writes_per_run.used).toBe(1);
    expect(existsSync(join(path, "auto", "people", "ada.md"))).toBe(true);
    db.close();
  });

  test("extracting a draft counts as extracted, not written, until applyCanonWrite", async () => {
    const { path, db } = vault();
    const seed = putEvent(db, { source_record_id: "seed" });
    fileProposal(db, {
      kind: "claim",
      target: "people/grace",
      body: "Grace runs partnerships at Acme.",
      frontmatter: { type: "person", title: "Grace" },
      provenance: [seed],
      subjects: ["person:grace"],
      producer: "deterministic",
      confidence: 0.8,
    });
    const seeded = await runWritePass(db, path, boundWriteOptions(
      db,
      createBudgetTracker({ canon_writes_per_run: 8 }),
    ));
    expect(seeded.canon_writes).toBe(1);

    const eventId = putEvent(db, { source_record_id: "extract" });
    const result = await runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "kizuki.llm.openai-compatible:synthetic@local",
      claims: { db },
      producer: stubProducer({
        status: "ok",
        claims: [
          {
            kind: "claim",
            subject: "person:grace",
            predicate: "employment.works_at",
            object: "Acme",
            polarity: "positive",
            body: "Grace still runs partnerships at Acme.",
            valid_from: null,
            valid_to: null,
            confidence: 0.8,
            sensitivity: "personal",
            event_ids: [eventId],
          },
        ],
        usage: { calls: 1, input_tokens: 10, output_tokens: 4 },
      }),
    });
    expect(result.claims_extracted).toBe(1);
    expect(result.claims_written).toBe(1);
    expect(result.canon_writes).toBe(1);
    expect(result.model).toEqual({
      calls: 1,
      input_tokens: 10,
      output_tokens: 4,
      unavailable: 0,
      wall_ms: expect.any(Number),
    });
    expect(result.claims_rejected).toEqual({});
    db.close();
  });

  test("write-pass receipts preserve rejected and dropped model outcomes", async () => {
    const { path, db } = vault();
    putEvent(db, { source_record_id: "metrics" });
    const rejected = await runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "kizuki.llm.openai-compatible:synthetic@local",
      claims: { db },
      producer: stubProducer({
        status: "rejected",
        reason: "schema_invalid",
        usage: { calls: 1, input_tokens: 7, output_tokens: 0 },
      }),
    });
    expect(rejected.model).toEqual({
      calls: 1, input_tokens: 7, output_tokens: 0, unavailable: 0, wall_ms: expect.any(Number),
    });
    expect(rejected.claims_rejected).toEqual({ schema_invalid: 1 });

    const dropped = await runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "kizuki.llm.openai-compatible:synthetic@local",
      claims: { db },
      producer: stubProducer({
        status: "ok",
        claims: [],
        usage: { calls: 1, input_tokens: 3, output_tokens: 0 },
        dropped: [{ reason: "unknown_predicate", predicate: "employment.secret", event_ids: [putEvent(db, { source_record_id: "drop" })] }],
      }),
    });
    expect(dropped.claims_rejected).toEqual({ unknown_predicate: 1 });
    db.close();
  });

  test("draft durability converges across insertion and cursor-commit failures", async () => {
    for (const point of ["first", "between", "cursor"] as const) {
      const { path, db } = vault();
      putEvent(db, { source_record_id: `seed-${point}` });
      await runWritePass(db, path, boundWriteOptions(
        db,
        createBudgetTracker({ canon_writes_per_run: 8 }),
      ));
      const before = readExtractCursor(db);
      const grace = putEvent(db, { source_record_id: `grace-${point}` });
      const ada = putEvent(db, { source_record_id: `ada-${point}` });
      const producer = stubProducer({
        status: "ok",
        claims: [
          {
            kind: "claim", subject: "person:grace", predicate: "employment.works_at", object: "Acme",
            polarity: "positive", body: "Grace works at Acme.", valid_from: null, valid_to: null,
            confidence: 0.8, sensitivity: "personal", event_ids: [grace],
          },
          {
            kind: "claim", subject: "person:ada", predicate: "employment.works_at", object: "Acme",
            polarity: "positive", body: "Ada works at Acme.", valid_from: null, valid_to: null,
            confidence: 0.8, sensitivity: "personal", event_ids: [ada],
          },
        ],
        usage: { calls: 1, input_tokens: 10, output_tokens: 4 },
      });
      const options = {
        budget: createBudgetTracker({ canon_writes_per_run: 8 }),
        model_ref: "kizuki.llm.openai-compatible:synthetic@local",
        claims: { db }, producer,
      };
      const trigger = point === "first"
        ? "BEFORE INSERT ON claims WHEN NEW.subject = 'person:grace'"
        : point === "between"
          ? "BEFORE INSERT ON claims WHEN NEW.subject = 'person:ada'"
          : "BEFORE INSERT ON rail_cursors WHEN NEW.rail = 'kizuki.producer.model' AND NEW.source_key = 'extract'";
      db.exec(`CREATE TRIGGER fail_${point} ${trigger} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
      await expect(runWritePass(db, path, options)).rejects.toThrow("injected");
      expect(readExtractCursor(db)).toBe(before);
      db.exec(`DROP TRIGGER fail_${point}`);
      await runWritePass(db, path, options);
      expect(readExtractCursor(db)).not.toBe(before);
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM claims WHERE producer = 'model'").get()?.count).toBe(2);
      db.close();
    }
  });

  test("a partial filing retry replays the durable model output, never a new model decision", async () => {
    const { path, db } = vault();
    const grace = putEvent(db, { source_record_id: "journal-grace" });
    const ada = putEvent(db, { source_record_id: "journal-ada" });
    let calls = 0;
    const producer: ProducerPort = {
      ...stubProducer({ status: "ok", claims: [], usage: { calls: 0, input_tokens: 0, output_tokens: 0 } }),
      produce: async () => {
        calls += 1;
        return {
          status: "ok" as const,
          claims: calls === 1 ? [
            { kind: "claim" as const, subject: "person:grace", predicate: "employment.works_at", object: "Acme", polarity: "positive" as const, body: "Grace works at Acme.", valid_from: null, valid_to: null, confidence: 0.8, sensitivity: "personal" as const, event_ids: [grace] },
            { kind: "claim" as const, subject: "person:ada", predicate: "employment.works_at", object: "Acme", polarity: "positive" as const, body: "Ada works at Acme.", valid_from: null, valid_to: null, confidence: 0.8, sensitivity: "personal" as const, event_ids: [ada] },
          ] : [
            { kind: "claim" as const, subject: "person:grace", predicate: "employment.works_at", object: "Acme", polarity: "positive" as const, body: "Grace works at Acme.", valid_from: null, valid_to: null, confidence: 0.8, sensitivity: "personal" as const, event_ids: [grace] },
          ],
          usage: { calls: 1, input_tokens: 1, output_tokens: 1 },
        };
      },
    };
    const options = { budget: createBudgetTracker({ canon_writes_per_run: 8 }), model_ref: "kizuki.llm.openai-compatible:synthetic@local", claims: { db }, producer };
    db.exec("CREATE TRIGGER fail_ada BEFORE INSERT ON claims WHEN NEW.subject = 'person:ada' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(runWritePass(db, path, options)).rejects.toThrow("injected");
    db.exec("DROP TRIGGER fail_ada");
    await runWritePass(db, path, options);
    expect(calls).toBe(1);
    expect(listClaims(db, { status: "live", limit: 20 }).map((claim) => claim.subject)).toEqual(expect.arrayContaining(["person:grace", "person:ada"]));
    db.close();
  });

  test("occupancy does not parse promotions.jsonl; a torn journal stays fail-closed", async () => {
    const { path, db } = vault();
    filePerson(db, putEvent(db, { source_record_id: "jsonl-grace" }), "grace");
    filePerson(db, putEvent(db, { source_record_id: "jsonl-ada" }), "ada");
    const first = await runWritePass(db, path, boundWriteOptions(
      db,
      createBudgetTracker({ canon_writes_per_run: 1 }),
    ));
    expect(first.canon_writes).toBe(1);
    expect(first.stopped).toBe("budget:canon_writes_per_run");
    expect(db.query("SELECT 1 FROM canon_write_intents").get()).toBeNull();
    appendFileSync(join(path, RECEIPTS_PATH), "x");
    const second = await runWritePass(db, path, boundWriteOptions(
      db,
      createBudgetTracker({ canon_writes_per_run: 8 }),
    ));
    expect(second.canon_writes).toBe(0);
    expect(second.errors.length).toBeGreaterThan(0);
    expect(second.errors.some((error) => error.includes("Unexpected token") || error.includes("JSON Parse"))).toBe(false);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_receipts").get()?.n).toBe(1);
    expect(
      Number(existsSync(join(path, "auto", "people", "grace.md"))) +
        Number(existsSync(join(path, "auto", "people", "ada.md"))),
    ).toBe(1);
    db.close();
  });

  test("a file and JSONL effect without a receipt row still occupies the write slot", async () => {
    const { path, db } = vault();
    filePerson(db, putEvent(db, { source_record_id: "intent-grace" }), "grace");
    filePerson(db, putEvent(db, { source_record_id: "intent-ada" }), "ada");
    const failing = failingOnReceiptRow(db);
    const result = await runWritePass(failing, path, boundWriteOptions(
      failing,
      createBudgetTracker({ canon_writes_per_run: 8 }),
    ));
    expect(result.canon_writes).toBe(1);
    expect(result.claims_written).toBe(1);
    expect(result.errors.some((error) => error.includes("synthetic storage failure"))).toBe(true);
    expect(db.query("SELECT 1 FROM canon_receipts").get()).toBeNull();
    expect(db.query("SELECT 1 FROM canon_write_intents").get()).not.toBeNull();
    expect(db.query("SELECT 1 FROM canon_write_reservations").get()).not.toBeNull();
    expect(
      Number(existsSync(join(path, "auto", "people", "grace.md"))) +
        Number(existsSync(join(path, "auto", "people", "ada.md"))),
    ).toBe(1);
    db.close();
  });

  test("rails, receipts, and durable reservations share one UTC day clock", async () => {
    const { path, db } = vault();
    filePerson(db, putEvent(db, { source_record_id: "clock-grace" }), "grace");
    const NOW = "2026-08-28T23:59:59.000Z";
    const { budget: _budget, ...hooks } = boundWriteOptions(db, createBudgetTracker({ canon_writes_per_run: 8 }));
    const receipt = await runRail(db, path, "sync", { now: () => NOW, hooks });
    expect(receipt.canon_writes).toBe(1);
    expect(db.query<{ at: string }, []>("SELECT at FROM canon_receipts").get()?.at).toBe(NOW);
    expect(db.query<{ day: string; used: number }, []>(
      "SELECT day, used FROM budget_ledger WHERE name='canon_writes_per_day'",
    ).get()).toEqual({ day: "2026-08-28", used: 1 });
    expect(db.query("SELECT 1 FROM canon_write_reservations").get()).toBeNull();

    const split = createDurableWriteBudget(db, () => "2026-08-29", {
      canon_writes_per_run: 8,
      canon_writes_per_day: 8,
    });
    split.chargeWrite({
      receipt_id: "01CLOCKRESERVE0000000000000",
      page_path: "people/ada.md",
      before_hash: null,
      at: NOW,
    });
    expect(db.query<{ day: string }, []>("SELECT day FROM canon_write_reservations").get()?.day).toBe("2026-08-28");
    expect(ordinaryDailyOccupancy(db, "2026-08-28")).toBe(2);
    expect(ordinaryDailyOccupancy(db, "2026-08-29")).toBe(0);
    db.close();
  });
});
