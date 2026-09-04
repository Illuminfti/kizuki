import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createVaultFts5Port,
  insertClaim,
  openLedger,
  readSince,
  serializePage,
} from "@kizuki/core";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

describe("RFC 0002 §16.4 purge and undo", () => {
  test("purge --record holds the page and --verify prints absence proofs", async () => {
    const setup = tempVault();
    writeFileSync(join(setup.notes, "acme.md"), "Grace runs partnerships at Acme.\n");
    const imported = runCli(
      setup.env,
      "import",
      "markdown-folder",
      "--source",
      setup.notes,
    );
    expect(imported.exitCode).toBe(0);

    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const events = readSince(db, null, 20).events;
    const target = events.find((event) => event.source_record_id === "acme.md");
    expect(target).toBeDefined();
    if (target === undefined) {
      db.close();
      throw new Error("acme.md was not imported");
    }

    mkdirSync(join(setup.vault, "people"), { recursive: true });
    writeFileSync(
      join(setup.vault, "people/grace.md"),
      serializePage({
        data: {
          id: "page-grace",
          title: "grace",
          type: "person",
          status: "active",
          sensitivity: "personal",
          taint: "clean",
          sources: [target.event_id],
        },
        body: "Grace runs partnerships at Acme.\n",
      }),
      "utf8",
    );

    const claim = await insertClaim(
      { db },
      {
        kind: "claim",
        target: "people/grace",
        subject: "person:grace",
        predicate: "employment.works_at",
        object: "acme",
        polarity: "positive",
        body: "Grace runs partnerships at Acme.",
        frontmatter: { type: "person", title: "grace" },
        provenance: [target.event_id],
        subjects: ["person:grace"],
        producer: "deterministic",
        confidence: 0.8,
        sensitivity: "personal",
        taint: "clean",
      },
    );
    expect(claim.outcome).toBe("stored");
    if (claim.outcome !== "stored") {
      db.close();
      return;
    }

    const port = createVaultFts5Port(setup.vault);
    const at = "2026-09-02T12:00:00.000Z";
    await port.upsert([
      {
        doc_id: `event:${target.event_id}`,
        kind: "event",
        title: "acme",
        text: "Grace runs partnerships at Acme.",
        sensitivity: "personal",
        taint: "quoted",
        authority: "connector_evidence",
        subjects: ["person:grace"],
        provenance: [target.event_id],
        occurred_at: at,
        updated_at: at,
      },
      {
        doc_id: "page:page-grace",
        kind: "page",
        title: "grace",
        text: "Grace runs partnerships at Acme.",
        sensitivity: "personal",
        taint: "clean",
        authority: "connector_evidence",
        subjects: ["person:grace"],
        provenance: [target.event_id],
        occurred_at: null,
        updated_at: at,
      },
      {
        doc_id: `claim:${claim.claim.claim_id}`,
        kind: "claim",
        title: "works at",
        text: "Grace runs partnerships at Acme.",
        sensitivity: "personal",
        taint: "clean",
        authority: "connector_evidence",
        subjects: ["person:grace"],
        provenance: [target.event_id],
        occurred_at: null,
        updated_at: at,
      },
    ]);
    await port.close();
    db.close();

    const purged = runCli(
      setup.env,
      "purge",
      "--connector",
      "kizuki.markdown-folder",
      "--record",
      "acme.md",
      "--reason",
      "source deleted",
    );
    expect(purged.exitCode).toBe(0);
    expect(purged.stderr).toContain("Undo cannot resurrect purged events");
    expect(purged.stdout).toContain(
      "purged 1 event; held 1 page; 1 store op pending",
    );
    expect(purged.stdout).toContain("Undo cannot resurrect purged events");
    const receipt = purged.stdout.match(/receipt ([0-9A-HJKMNP-TV-Z]{26})/)?.[1];
    expect(receipt).toBeDefined();
    if (receipt === undefined) return;

    const verified = runCli(setup.env, "purge", "--verify", receipt);
    expect(verified.exitCode).toBe(0);
    // Import's live leftover is retracted with the event; verify then
    // proves absence of the three docs this test indexed (event, page, claim).
    expect(verified.stdout).toMatch(
      /kizuki\.retrieval\.fts5\s+checked 3\s+found 0\s+done/,
    );
    expect(verified.stdout).toMatch(/canon\s+pages rewritten 1\s+hold lifted/);
  });
});
