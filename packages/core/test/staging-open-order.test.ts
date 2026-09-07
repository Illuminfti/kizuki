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
