import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudgetTracker } from "../../src/canon/budget";
import { getClaim, reviveUncontestedSkipped } from "../../src/claims/store";
import { openLedger } from "../../src/ledger/db";
import { runRail } from "../../src/serve/rails";
import { runWritePass } from "../../src/serve/write-pass";
import { fileProposal } from "../../src/staging/proposals";
import { initVault } from "../../src/vault/init";
import { putEvent } from "../claims/helpers";

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
    expect(existsSync(join(path, "people", "grace.md"))).toBe(true);
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
    expect(existsSync(join(path, "people", "grace.md"))).toBe(true);
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
});
