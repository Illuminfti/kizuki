import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentSignature, hashBody } from "../src/claims/hash";
import { inspectOpenLedgerHealth, LEDGER_SCHEMA_VERSION, openLedger } from "../src/ledger/db";
import { readSchemaVersion } from "../src/ledger/integrity";
import { tableExists } from "../src/ledger/schema";
import { openStagingDb } from "../src/staging/proposals";

for (const claimCount of [0, 2]) {
  test(`opening staging before the ledger preserves ${claimCount} fixture claims through migration and reopen`, () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-staging-open-order-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const staging = openStagingDb(path);
      let rowsBefore: unknown[];
      try {
        expect(tableExists(staging, "schema_version")).toBe(false);
        expect(tableExists(staging, "promotions")).toBe(false);
        // The claims helpers open a full ledger first. Seed inactive schema
        // fixtures directly so this path starts with only the staging schema.
        for (let index = 0; index < claimCount; index++) {
          const body = `Synthetic migration fixture ${index + 1}.`;
          const at = "2026-09-06T00:00:00.000Z";
          const signature = contentSignature({
            kind: "claim", target: null, body, frontmatter: {}, subjects: [],
            producer: "deterministic", confidence: 0.5,
          });
          staging.query(`
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
        rowsBefore = staging.query("SELECT * FROM claims ORDER BY claim_id").all();
        expect(rowsBefore).toHaveLength(claimCount);
      } finally { staging.close(); }

      const ledger = openLedger(path);
      try {
        expect(readSchemaVersion(ledger)).toBe(LEDGER_SCHEMA_VERSION);
        expect(inspectOpenLedgerHealth(ledger, { full: true })).toMatchObject({
          ok: true, failures: [], quick_check: "ok", integrity_check: "ok",
        });
        expect(ledger.query("SELECT * FROM claims ORDER BY claim_id").all()).toEqual(rowsBefore);
        expect(ledger.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      } finally { ledger.close(); }

      const reopened = openLedger(path);
      try {
        expect(readSchemaVersion(reopened)).toBe(LEDGER_SCHEMA_VERSION);
        expect(reopened.query("SELECT * FROM claims ORDER BY claim_id").all()).toEqual(rowsBefore);
      } finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("opening a current-shape promotions table before the ledger preserves the receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-staging-current-promotions-"));
  const path = join(directory, "ledger.sqlite");
  const afterHash = "a".repeat(64);
  try {
    const staging = new Database(path, { create: true });
    try {
      staging.exec(`
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
      `);
      staging.query(`
        INSERT INTO promotions (
          receipt_id, proposal_id, provenance, sensitivity, page_path,
          kind, before_hash, after_hash, at
        ) VALUES (?, ?, '[]', 'private', 'facts/current.md', 'claim', NULL, ?, ?)
      `).run("receipt-current", "proposal-current", afterHash, "2026-09-06T00:00:00.000Z");
    } finally { staging.close(); }

    const ledger = openLedger(path);
    try {
      expect(readSchemaVersion(ledger)).toBe(LEDGER_SCHEMA_VERSION);
      expect(inspectOpenLedgerHealth(ledger, { full: true })).toMatchObject({
        ok: true, failures: [], quick_check: "ok", integrity_check: "ok",
      });
      expect(tableExists(ledger, "promotions")).toBe(false);
      expect(
        ledger.query<{ page_path: string; after_hash: string }, []>(
          "SELECT page_path, after_hash FROM canon_receipts",
        ).get(),
      ).toEqual({ page_path: "facts/current.md", after_hash: afterHash });
    } finally { ledger.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
