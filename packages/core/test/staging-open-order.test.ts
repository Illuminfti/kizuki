import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentSignature, hashBody } from "../src/claims/hash";
import { insertClaim } from "../src/claims/store";
import { inspectOpenLedgerHealth, LEDGER_SCHEMA_VERSION, openLedger } from "../src/ledger/db";
import { LedgerStoreError } from "../src/ledger/errors";
import { readSchemaVersion } from "../src/ledger/integrity";
import { accept } from "../src/ledger/ledger";
import { tableExists } from "../src/ledger/schema";
import { openStagingDb, initStaging } from "../src/staging/proposals";
import { validEvent } from "./fixtures";

const HASH_V1 = "b".repeat(64);
const HASH_BEFORE = "1".repeat(64);
const HASH_AFTER = "2".repeat(64);

const V1_PROMOTIONS = `
  CREATE TABLE promotions (
    receipt_id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL UNIQUE,
    provenance TEXT NOT NULL,
    sensitivity TEXT NOT NULL,
    page_path TEXT NOT NULL,
    page_hash TEXT NOT NULL,
    at TEXT NOT NULL
  ) STRICT;
`;

const V2_PROMOTIONS = `
  CREATE TABLE promotions (
    receipt_id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL UNIQUE,
    provenance TEXT NOT NULL,
    sensitivity TEXT NOT NULL,
    page_path TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'claim',
    before_hash TEXT,
    after_hash TEXT NOT NULL,
    at TEXT NOT NULL
  ) STRICT;
`;

async function withTempDb(run: (path: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-staging-open-order-"));
  const path = join(directory, "ledger.sqlite");
  try {
    await run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectCurrent(db: Database): void {
  expect(readSchemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
  expect(inspectOpenLedgerHealth(db, { full: true })).toMatchObject({
    ok: true, failures: [], quick_check: "ok", integrity_check: "ok",
  });
  expect(tableExists(db, "promotions")).toBe(false);
  expect(tableExists(db, "canon_receipts")).toBe(true);
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
}

function plant(path: string, sql: string): void {
  const db = new Database(path);
  db.exec(sql);
  db.close();
}

function plantHistoricalClaims(path: string, claimCount: number): unknown[] {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE claims (
        claim_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        target TEXT,
        body TEXT NOT NULL,
        frontmatter TEXT NOT NULL,
        provenance TEXT NOT NULL,
        subjects TEXT NOT NULL,
        producer TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        content_hash TEXT,
        sensitivity TEXT,
        valid_from TEXT NOT NULL DEFAULT '',
        asserted_at TEXT NOT NULL DEFAULT '',
        retracted_at TEXT,
        last_confirmed_at TEXT
      ) STRICT;
    `);
    expect(tableExists(db, "schema_version")).toBe(false);
    expect(tableExists(db, "promotions")).toBe(false);
    for (let index = 0; index < claimCount; index++) {
      const body = `Synthetic migration fixture ${index + 1}.`;
      const at = "2026-09-06T00:00:00.000Z";
      const signature = contentSignature({
        kind: "claim", target: null, body, frontmatter: {}, subjects: [],
        producer: "deterministic", confidence: 0.5,
      });
      db.query(`
        INSERT INTO claims (
          claim_id, kind, body, frontmatter, provenance, subjects, producer,
          confidence, status, created_at, body_hash, content_hash,
          sensitivity, valid_from, asserted_at, retracted_at, last_confirmed_at
        ) VALUES (?, 'claim', ?, '{}', '[]', '[]', 'deterministic',
          0.5, 'skipped', ?, ?, ?, 'private', ?, ?, ?, ?)
      `).run(
        `01ARZ3NDEKTSV4RRFFQ69G5FA${index}`, body, at, hashBody(body),
        signature, at, at, at, at,
      );
    }
    return db.query("SELECT * FROM claims ORDER BY claim_id").all();
  } finally {
    db.close();
  }
}

function expectReceipt(
  db: Database,
  expected: { kind: string; before_hash: string | null; after_hash: string },
): void {
  expect(
    db.query<{ kind: string; before_hash: string | null; after_hash: string; writer: string }, []>(
      "SELECT kind, before_hash, after_hash, writer FROM canon_receipts WHERE receipt_id = 'receipt-1'",
    ).get(),
  ).toEqual({ ...expected, writer: "import" });
}

async function filePublicClaim(path: string): Promise<string> {
  const ledger = openLedger(path);
  try {
    const stored = accept(ledger, validEvent());
    expect(stored.status).toBe("stored");
    if (stored.status !== "stored") throw new Error("expected stored");
    const filed = await insertClaim(
      { db: ledger, now: () => "2026-09-06T00:00:00.000Z" },
      {
        kind: "claim",
        subject: "person:ada",
        predicate: "employment.works_at",
        object: "acme",
        polarity: "positive",
        body: "Synthetic ledger-first fixture.",
        provenance: [stored.event.event_id],
        subjects: ["person:ada"],
        producer: "deterministic",
        confidence: 0.5,
        sensitivity: "private",
        taint: "quoted",
      },
    );
    expect(filed.outcome).toBe("stored");
    if (filed.outcome !== "stored") throw new Error("expected stored");
    expectCurrent(ledger);
    return filed.claim.claim_id;
  } finally { ledger.close(); }
}

test("opening staging before the ledger yields a current ledger immediately", async () => {
  await withTempDb((path) => {
    const staging = openStagingDb(path);
    try {
      expectCurrent(staging);
      expect(staging.query("SELECT * FROM claims ORDER BY claim_id").all()).toEqual([]);
    } finally { staging.close(); }

    const ledger = openLedger(path);
    try {
      expectCurrent(ledger);
    } finally { ledger.close(); }
  });
});

for (const claimCount of [0, 2]) {
  test(`opening staging on a historical claims-only database preserves ${claimCount} fixture claims`, async () => {
    await withTempDb((path) => {
      const rowsBefore = plantHistoricalClaims(path, claimCount);
      expect(rowsBefore).toHaveLength(claimCount);

      const staging = openStagingDb(path);
      try {
        expectCurrent(staging);
        expect(staging.query("SELECT claim_id FROM claims ORDER BY claim_id").all())
          .toEqual(rowsBefore.map((row) => ({ claim_id: (row as { claim_id: string }).claim_id })));
      } finally { staging.close(); }

      const reopened = openLedger(path);
      try {
        expectCurrent(reopened);
        expect(reopened.query("SELECT claim_id FROM claims ORDER BY claim_id").all())
          .toEqual(rowsBefore.map((row) => ({ claim_id: (row as { claim_id: string }).claim_id })));
      } finally { reopened.close(); }
    });
  });
}

test("opening ledger before staging preserves a public claim through reopen", async () => {
  await withTempDb(async (path) => {
    const claimId = await filePublicClaim(path);

    const staging = openStagingDb(path);
    try {
      expect(tableExists(staging, "promotions")).toBe(false);
      expect(tableExists(staging, "canon_receipts")).toBe(true);
      expect(
        staging.query<{ claim_id: string }, [string]>(
          "SELECT claim_id FROM claims WHERE claim_id = ?",
        ).get(claimId),
      ).toEqual({ claim_id: claimId });
    } finally { staging.close(); }

    const reopened = openLedger(path);
    try {
      expectCurrent(reopened);
      expect(
        reopened.query<{ claim_id: string }, [string]>(
          "SELECT claim_id FROM claims WHERE claim_id = ?",
        ).get(claimId),
      ).toEqual({ claim_id: claimId });
    } finally { reopened.close(); }
  });
});
const leftoverShapes = [
  {
    name: "v1 page_hash",
    sql: `
      ${V1_PROMOTIONS}
      INSERT INTO promotions VALUES (
        'receipt-1', 'proposal-1', '["event-1"]', 'personal',
        'facts/legacy.md', '${HASH_V1}', '2026-01-01T00:00:00Z'
      );
    `,
    receipt: { kind: "claim", before_hash: null, after_hash: HASH_V1 },
  },
  {
    name: "v2 after_hash",
    sql: `
      ${V2_PROMOTIONS}
      INSERT INTO promotions VALUES (
        'receipt-1', 'proposal-1', '["event-1"]', 'personal',
        'facts/legacy.md', 'edit', '${HASH_BEFORE}', '${HASH_AFTER}',
        '2026-01-01T00:00:00Z'
      );
    `,
    receipt: { kind: "edit", before_hash: HASH_BEFORE, after_hash: HASH_AFTER },
  },
] as const;

for (const shape of leftoverShapes) {
  test(`a leftover ${shape.name} promotions table migrates through staging then ledger and reopen`, async () => {
    await withTempDb((path) => {
      plant(path, shape.sql);
      const staging = openStagingDb(path);
      try {
        expectCurrent(staging);
        expectReceipt(staging, shape.receipt);
      } finally { staging.close(); }

      const reopened = openLedger(path);
      try {
        expectCurrent(reopened);
        expectReceipt(reopened, shape.receipt);
      } finally { reopened.close(); }
    });
  });

  test(`a leftover ${shape.name} promotions table migrates through ledger then staging and reopen`, async () => {
    await withTempDb((path) => {
      plant(path, shape.sql);
      const ledger = openLedger(path);
      try {
        expectCurrent(ledger);
        expectReceipt(ledger, shape.receipt);
      } finally { ledger.close(); }

      const staging = openStagingDb(path);
      try {
        expect(tableExists(staging, "promotions")).toBe(false);
        expect(tableExists(staging, "canon_receipts")).toBe(true);
        expect(readSchemaVersion(staging)).toBe(LEDGER_SCHEMA_VERSION);
        expectReceipt(staging, shape.receipt);
      } finally { staging.close(); }

      const reopened = openLedger(path);
      try {
        expectCurrent(reopened);
        expectReceipt(reopened, shape.receipt);
      } finally { reopened.close(); }
    });
  });
}

test("an unknown leftover promotions table fails closed", async () => {
  await withTempDb((path) => {
    plant(path, "CREATE TABLE promotions (receipt_id TEXT PRIMARY KEY) STRICT;");
    expect(() => openLedger(path)).toThrow(/missing page_hash and after_hash/);
  });
});

test("an unknown leftover promotions table fails closed through staging", async () => {
  await withTempDb((path) => {
    plant(path, "CREATE TABLE promotions (receipt_id TEXT PRIMARY KEY) STRICT;");
    expect(() => openStagingDb(path)).toThrow(/missing page_hash and after_hash/);
  });
});

test("initStaging on an existing connection migrates through the ledger coordinator", async () => {
  await withTempDb((path) => {
    plantHistoricalClaims(path, 2);
    const db = new Database(path);
    try {
      initStaging(db);
      expectCurrent(db);
      expect(db.query("SELECT COUNT(*) AS n FROM claims").get()).toEqual({ n: 2 });
    } finally { db.close(); }
  });
});

test("a mixed page_hash and after_hash promotions table fails closed without changing its schema or receipt", async () => {
  await withTempDb((path) => {
    plant(path, `
      CREATE TABLE schema_version (version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_version VALUES (0);
      ${V2_PROMOTIONS}
      ALTER TABLE promotions ADD COLUMN page_hash TEXT NOT NULL;
      INSERT INTO promotions VALUES (
        'receipt-1', 'proposal-1', '["event-1"]', 'personal',
        'facts/legacy.md', 'edit', '${HASH_BEFORE}', '${HASH_AFTER}',
        '2026-01-01T00:00:00Z', '${HASH_V1}'
      );
    `);
    const original = new Database(path, { readonly: true });
    let schema: unknown[];
    let receipts: unknown[];
    try {
      schema = original.query("SELECT * FROM sqlite_schema ORDER BY name").all();
      receipts = original.query("SELECT * FROM promotions").all();
    } finally { original.close(); }

    let failure: unknown;
    try { openLedger(path).close(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(LedgerStoreError);
    expect(failure).toMatchObject({ code: "corrupt", retryable: false });
    expect((failure as LedgerStoreError).message).toMatch(/both page_hash and after_hash/);

    let stagingFailure: unknown;
    try { openStagingDb(path).close(); } catch (error) { stagingFailure = error; }
    expect(stagingFailure).toBeInstanceOf(LedgerStoreError);
    expect(stagingFailure).toMatchObject({ code: "corrupt", retryable: false });
    expect((stagingFailure as LedgerStoreError).message).toMatch(/both page_hash and after_hash/);

    const unchanged = new Database(path, { readonly: true });
    try {
      expect(unchanged.query("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
      expect(unchanged.query("SELECT * FROM promotions").all()).toEqual(receipts);
      expect(readSchemaVersion(unchanged)).toBe(0);
      expect(tableExists(unchanged, "promotions_v2")).toBe(false);
      expect(tableExists(unchanged, "canon_receipts")).toBe(false);
    } finally { unchanged.close(); }
  });
});
