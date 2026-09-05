import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { getClaim, reviveUncontestedSkipped } from "../../src/claims/store";
import type { ProduceResult, ProducerPort } from "../../src/contracts/producer";
import { openLedger } from "../../src/ledger/db";
import { runRail } from "../../src/serve/rails";
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
      hooks: { model_ref: "kizuki.llm.openai-compatible:synthetic@local" },
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

  test("serve.toml model_ref is enough for the sync rail to write", async () => {
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
    expect(receipt.canon_writes).toBe(1);
    expect(receipt.model.model_ref).toBe(
      "kizuki.llm.openai-compatible:synthetic@local",
    );
    expect(existsSync(join(path, "auto", "people", "grace.md"))).toBe(true);
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

    const result = await runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 1 }),
      model_ref: "kizuki.llm.openai-compatible:synthetic@local",
    });
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
    mkdirSync(join(path, "people"), { recursive: true });
    writeFileSync(
      join(path, "people", "grace.md"),
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
    );
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
    const result = await runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "kizuki.llm.openai-compatible:synthetic@local",
    });
    // A page with no receipt is owner prose: the loop skips it and
    // does not open a parallel auto/ copy.
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
    const result = await runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "kizuki.llm.openai-compatible:synthetic@local",
    });
    expect(result.stopped).toBe("lock:busy");
    expect(result.canon_writes).toBe(0);
    expect(existsSync(join(path, "auto", "people", "grace.md"))).toBe(false);
    db.close();
  });

  test("skipped owner pages do not stall later writeable claims", async () => {
    const { path, db } = vault();
    mkdirSync(join(path, "people"), { recursive: true });
    for (let index = 0; index < 32; index += 1) {
      const slug = `skip-${String(index).padStart(2, "0")}`;
      writeFileSync(
        join(path, "people", `${slug}.md`),
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
      );
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
    const result = await runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "kizuki.llm.openai-compatible:synthetic@local",
    });
    expect(result.canon_writes).toBe(1);
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
    const seeded = await runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "kizuki.llm.openai-compatible:synthetic@local",
    });
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
    });
    db.close();
  });

  test("a rejected model response is distinguishable from an unreachable one (#438)", async () => {
    const { path, db } = vault();
    putEvent(db, { source_record_id: "rejected" });
    const rejected = await runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "kizuki.llm.openai-compatible:synthetic@local",
      claims: { db },
      producer: stubProducer({
        status: "rejected",
        reason: "budget_exhausted",
        usage: { calls: 1, input_tokens: 9_000, output_tokens: 0 },
        detail: "max_input_tokens used=9000 limit=8000",
      }),
    });
    // Reached the provider and it was refused: status is not "stopped", and
    // the error names the budget with its used/limit, not a bare reason.
    expect(rejected.stopped).toBeNull();
    expect(rejected.errors).toEqual([
      "budget_exhausted: max_input_tokens used=9000 limit=8000",
    ]);
    expect(rejected.model).toEqual({
      calls: 1,
      input_tokens: 9_000,
      output_tokens: 0,
      unavailable: 0,
    });

    putEvent(db, { source_record_id: "unavailable" });
    const unavailable = await runWritePass(db, path, {
      budget: createBudgetTracker({ canon_writes_per_run: 8 }),
      model_ref: "kizuki.llm.openai-compatible:synthetic@local",
      claims: { db },
      producer: stubProducer({
        status: "unavailable",
        reason: "llm timeout",
      }),
    });
    // Never reached: status is "stopped", and no usage is claimed.
    expect(unavailable.stopped).toBe("model:llm timeout");
    expect(unavailable.errors).toEqual([]);
    expect(unavailable.model).toEqual({
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      unavailable: 1,
    });
    db.close();
  });
});
