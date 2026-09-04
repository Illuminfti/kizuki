import { fixtureConsent } from "./helpers";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accept, createVaultFts5Port, insertClaim, readSince, serializePage } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
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
      setup.notes, ...fixtureConsent(setup.root),
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

    // Include the two deterministic import claims even when this test did
    // not explicitly index them. Purge proves absence for the whole closure.
    const targetClaims = db.query<{ claim_id: string }, [string]>(
      "SELECT claim_id FROM claims c WHERE EXISTS (SELECT 1 FROM json_each(c.provenance) p WHERE p.value=?) ORDER BY claim_id",
    ).all(target.event_id).map(row => `claim:${row.claim_id}`);
    expect(targetClaims).toHaveLength(3);
    expect(targetClaims).toContain(`claim:${claim.claim.claim_id}`);

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
    const proofDb = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      const op = proofDb.query<{ ids: string }, [string]>("SELECT ids FROM purge_ops WHERE receipt_id=?").get(receipt)!;
      expect(JSON.parse(op.ids).sort()).toEqual([
        `event:${target.event_id}`, "page:page-grace", ...targetClaims,
      ].sort());
    } finally { proofDb.close(); }
    // Event, page and all three claims are checked, including absent docs.
    expect(verified.stdout).toMatch(
      /kizuki\.retrieval\.fts5\s+checked 5\s+found 0\s+done/,
    );
    expect(verified.stdout).toMatch(/canon\s+pages rewritten 1\s+hold lifted/);
  });

  test("dry-run prints a plan and leaves events in place", () => {
    const setup = tempVault();
    writeFileSync(join(setup.notes, "acme.md"), "Grace runs partnerships at Acme.\n");
    expect(
      runCli(setup.env, "import", "markdown-folder", "--source", setup.notes, ...fixtureConsent(setup.root)).exitCode,
    ).toBe(0);

    const preview = runCli(
      setup.env,
      "purge",
      "--connector",
      "kizuki.markdown-folder",
      "--record",
      "acme.md",
      "--reason",
      "source deleted",
      "--dry-run",
    );
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("dry-run: 1 event");
    expect(preview.stdout).not.toContain("purged 1 event");

    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    expect(readSince(db, null, 20).events.length).toBeGreaterThan(0);
    db.close();
  });

  test("dry-run --json --allow-empty reports ok for no match", () => {
    const setup = tempVault();
    const preview = runCli(
      setup.env,
      "purge",
      "--event",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--reason",
      "no such event",
      "--dry-run",
      "--allow-empty",
      "--json",
    );
    expect(preview.exitCode).toBe(0);
    const body = JSON.parse(preview.stdout) as {
      status: string;
      data: { event_count: number; dry_run: boolean; uncertain_pages: string[] };
    };
    expect(body.status).toBe("ok");
    expect(body.data.event_count).toBe(0);
    expect(body.data.dry_run).toBe(true);
    expect(body.data.uncertain_pages).toEqual([]);
  });

  test("dry-run no-match does not list leftover unreadable pages as uncertain", () => {
    const setup = tempVault();
    mkdirSync(join(setup.vault, "facts"), { recursive: true });
    writeFileSync(join(setup.vault, "facts", "orphan.md"), "no frontmatter\n");
    const preview = runCli(
      setup.env,
      "purge",
      "--event",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--reason",
      "no such event",
      "--dry-run",
      "--allow-empty",
      "--json",
    );
    expect(preview.exitCode).toBe(0);
    const body = JSON.parse(preview.stdout) as {
      status: string;
      data: { event_count: number; uncertain_pages: string[] };
    };
    expect(body.status).toBe("ok");
    expect(body.data.event_count).toBe(0);
    expect(body.data.uncertain_pages).toEqual([]);
  });

  test("no-match purge exits nonzero and writes no receipt", () => {
    const setup = tempVault();
    const missing = runCli(
      setup.env,
      "purge",
      "--event",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--reason",
      "no such event",
    );
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("matched no events");
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    expect(
      db.query<{ n: number }, []>("SELECT count(*) AS n FROM event_purges").get(),
    ).toEqual({ n: 0 });
    db.close();
  });

  test("purges a retired connector id that is no longer in the registry", () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    const stored = accept(db, {
      schema: "kizuki.event/v1",
      connector_id: "retired.mail",
      source_record_id: "retired-1",
      kind: "message",
      occurred_at: "2026-02-28T10:30:00Z",
      observed_at: "2026-03-01T00:00:00Z",
      text: "synthetic retired connector note",
      subjects: [{ subject_id: "person:ada", role: "from" }],
      deleted: false,
      attachments: [],
      metadata: { thread: "t-retired" },
    });
    expect(stored.status).toBe("stored");
    db.close();

    const purged = runCli(
      setup.env,
      "purge",
      "--connector",
      "retired.mail",
      "--record",
      "retired-1",
      "--reason",
      "connector removed",
    );
    expect(purged.exitCode).toBe(0);
    expect(purged.stdout).toContain("purged 1 event");
  });

  test("broad connector purge requires --confirm", () => {
    const setup = tempVault();
    const refused = runCli(
      setup.env,
      "purge",
      "--connector",
      "kizuki.markdown-folder",
      "--reason",
      "account erased",
    );
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("--confirm");
  });
});
