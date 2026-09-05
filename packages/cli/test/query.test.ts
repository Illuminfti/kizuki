import { fixtureConsent } from "./helpers";
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  accept,
  indexPage,
  initSearch,
  openLedger,
  serializePage,
} from "@kizuki/core";
import type { CanonPage, SearchHit } from "@kizuki/core";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

function importNotes(setup: ReturnType<typeof tempVault>) {
  const imported = runCli(
    setup.env,
    "import",
    "markdown-folder",
    "--source",
    setup.notes, ...fixtureConsent(setup.root),
  );
  expect(imported.exitCode).toBe(0);
  return imported;
}

function seedCanonPage(
  setup: ReturnType<typeof tempVault>,
  {
    id,
    relPath,
    body,
    status = "active",
  }: {
    id: string;
    relPath: string;
    body: string;
    status?: "active" | "archived";
  },
): string {
  const evidence = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  // This fixture page cites real captured evidence under its explicit source grant.
  const source = evidence.query<{ event_id: string }, []>("SELECT event_id FROM events ORDER BY event_id LIMIT 1").get();
  evidence.close();
  const data = {
    id,
    title: id,
    type: "fact",
    status,
    sensitivity: "personal",
    taint: "clean",
    sources: source === null ? [] : [source.event_id],
  };
  const page: CanonPage = {
    id,
    path: relPath,
    relPath,
    data,
    body,
    contentHash: new Bun.CryptoHasher("sha256").update(serializePage({ data, body })).digest("hex"),
  };
  writeFileSync(
    join(setup.vault, relPath),
    serializePage({ data, body }),
    "utf8",
  );

  const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
  try {
    initSearch(db);
    indexPage(db, page);
  } finally {
    db.close();
  }
  return relPath;
}

describe("query", () => {
  test("--limit 0 and --limit x are usage errors", () => {
    const setup = tempVault();
    for (const limit of ["0", "x"]) {
      const result = runCli(setup.env, "query", "acme", "--limit", limit);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("usage: kizuki query");
    }
  });

  test("--scope canon and --scope ledger split pages from connected source events", () => {
    const setup = tempVault();
    importNotes(setup);
    seedCanonPage(setup, {
      id: "fact:acme",
      relPath: "facts/acme.md",
      body: "acme canonical fact",
    });

    const canon = runCli(setup.env, "query", "acme", "--scope", "canon");
    expect(canon.exitCode).toBe(0);
    expect(canon.stdout).toMatch(/^page /);
    expect(canon.stdout).not.toMatch(/^event /m);

    const ledger = runCli(setup.env, "query", "acme", "--scope", "ledger");
    expect(ledger.exitCode).toBe(0);
    expect(ledger.stdout).toMatch(/^event /);
    expect(ledger.stdout).toContain("acme");
    expect(ledger.stdout).not.toMatch(/^page /m);
    expect(ledger.stderr).not.toContain("withheld=");
  });

  test("held and archived pages are never returned", () => {
    const setup = tempVault();
    const heldPath = seedCanonPage(setup, {
      id: "fact:held",
      relPath: "facts/held.md",
      body: "heldword",
    });
    seedCanonPage(setup, {
      id: "fact:archived",
      relPath: "facts/archived.md",
      body: "archivedword",
      status: "archived",
    });

    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      db.query(
        `INSERT INTO canon_holds (page_path, proposal_id, reason, held_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        heldPath,
        "fixture-hold",
        "source purge",
        "2026-09-01T00:00:00Z",
      );
    } finally {
      db.close();
    }

    expect(runCli(setup.env, "query", "heldword").stdout).toBe("");
    expect(runCli(setup.env, "query", "archivedword").stdout).toBe("");
  });

  test("tombstoned records never return their events", () => {
    const setup = tempVault();
    importNotes(setup);
    rmSync(join(setup.notes, "linus.md"));
    expect(runCli(setup.env, "sync", "markdown-folder").exitCode).toBe(0);
    const result = runCli(setup.env, "query", "moth-lantern", "--scope", "ledger");
    expect(result.stdout).toBe("");
  });

  test("--json lines parse as SearchHit", () => {
    const setup = tempVault();
    seedCanonPage(setup, {
      id: "fact:acme",
      relPath: "facts/acme.md",
      body: "acme canonical fact",
    });

    const result = runCli(setup.env, "query", "acme", "--json");
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout.trim()) as {
      schema: string;
      data: { hits: SearchHit[] };
    };
    expect(envelope.schema).toBe("kizuki.cli.query/v1");
    const hit = envelope.data.hits[0];
    expect(hit?.scope).toBe("canon");
    expect(hit?.doc_id).toBeDefined();
    expect(hit?.snippet).toContain("acme");
  });

  test("query refuses when canon receipts drift without a derived refresh", () => {
    const setup = tempVault();
    seedCanonPage(setup, {
      id: "fact:receipt-drift",
      relPath: "facts/receipt-drift.md",
      body: "receiptdriftword",
    });
    expect(runCli(setup.env, "query", "receiptdriftword").exitCode).toBe(0);

    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      db.query(
        `INSERT INTO canon_receipts (
           receipt_id, claim_ids, provenance, sensitivity, page_path, kind,
           after_hash, at, receipt_kind, page_action, writer, producer,
           authority, confidence, taint, candidates, superseded, retrieval_ops
         ) VALUES (?, '[]', '[]', 'personal', ?, 'claim',
           'aaa', '2026-09-01T00:00:00Z', 'write', 'create', 'import',
           'deterministic', 'connector_evidence', 1.0, 'quoted', '[]', '[]', '[]')`,
      ).run("01RECEIPTDRIFT000000000001", "facts/receipt-drift.md");
    } finally {
      db.close();
    }

    const refused = runCli(setup.env, "query", "receiptdriftword");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("index-behind-receipts");

    const degraded = runCli(setup.env, "query", "receiptdriftword", "--degraded");
    expect(degraded.exitCode).toBe(0);
    expect(degraded.stderr).toContain("index-behind-receipts");
  });

  test("query refuses a stale index unless --degraded is set", () => {
    const setup = tempVault();
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      const accepted = accept(db, {
        schema: "kizuki.event/v1",
        connector_id: "fixture",
        source_record_id: "stale-1",
        kind: "message",
        occurred_at: "2026-09-01T00:00:00Z",
        observed_at: "2026-09-01T00:00:00Z",
        text: "staleindexword",
        subjects: [],
        deleted: false,
        attachments: [],
        metadata: {},
      });
      expect(accepted.status).toBe("stored");
    } finally {
      db.close();
    }

    const refused = runCli(setup.env, "query", "staleindexword");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("search index is stale");

    const degraded = runCli(setup.env, "query", "staleindexword", "--degraded");
    expect(degraded.exitCode).toBe(0);
    expect(degraded.stderr).toContain("degraded=");
  });
});
