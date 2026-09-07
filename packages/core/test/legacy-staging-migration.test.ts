import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashBody } from "../src/claims/hash";
import { inspectOpenLedgerHealth, LEDGER_SCHEMA_VERSION, openLedger } from "../src/ledger/db";
import { readSchemaVersion } from "../src/ledger/integrity";

// Literal initStaging schema at 870ccdca1c487d5dbebdabfa08b961d8a6a4c824.
// Calling today's compatibility opener cannot reproduce this persisted shape.
const STAGING_SCHEMA = readFileSync(join(import.meta.dir, "fixtures/legacy-staging-schema.sql"), "utf8");
const AT = "2026-01-01T00:00:00.000Z";
const AFTER = "a".repeat(64);
const BEFORE = "b".repeat(64);

function populate(db: Database): void {
  for (const [kind, before] of [["claim", null], ["entity", BEFORE], ["deletion", BEFORE]] as const) {
    const body = `Synthetic legacy ${kind} evidence.`;
    db.query("INSERT INTO proposals VALUES (?, ?, ?, ?, '{}', '[]', '[]', 'deterministic', 0.5, 'pending', ?, ?)")
      .run(`proposal-${kind}`, kind, `facts/${kind}`, body, AT, hashBody(body));
    db.query("INSERT INTO promotions VALUES (?, ?, '[]', 'private', ?, ?, ?, ?, ?)")
      .run(`receipt-${kind}`, `proposal-${kind}`, `facts/${kind}.md`, kind, before, AFTER, AT);
  }
  db.query("INSERT INTO rejections VALUES (?, 'Synthetic retained reason.', 'proposal-claim', ?)")
    .run(hashBody("Synthetic legacy claim evidence."), AT);
}

for (const populated of [false, true]) {
  test(`historical staging-first database migrates ${populated ? "populated" : "empty"} receipts and reopens without data loss`, () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-staging-legacy-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const old = new Database(path);
      old.exec(STAGING_SCHEMA);
      if (populated) populate(old);
      const proposals = old.query("SELECT proposal_id, kind, target, body, frontmatter, provenance, subjects, producer, confidence, status, created_at, body_hash FROM proposals ORDER BY proposal_id").all();
      const receipts = old.query("SELECT receipt_id, json_array(proposal_id) AS claim_ids, provenance, sensitivity, page_path, kind, before_hash, after_hash, at FROM promotions ORDER BY receipt_id").all();
      old.close();

      let snapshot: unknown[] = [];
      for (let open = 0; open < 2; open++) {
        const db = openLedger(path);
        try {
          expect(readSchemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
          expect(inspectOpenLedgerHealth(db, { full: true }).ok).toBe(true);
          expect(db.query("SELECT proposal_id, kind, target, body, frontmatter, provenance, subjects, producer, confidence, status, created_at, body_hash FROM proposals WHERE proposal_id LIKE 'proposal-%' ORDER BY proposal_id").all()).toEqual(proposals);
          expect(db.query("SELECT receipt_id, claim_ids, provenance, sensitivity, page_path, kind, before_hash, after_hash, at FROM canon_receipts ORDER BY receipt_id").all()).toEqual(receipts);
          expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('promotions', 'rejections')").all()).toEqual([]);
          if (populated) {
            expect(db.query("SELECT kind, page_action, before_hash, after_hash FROM canon_receipts ORDER BY kind").all()).toEqual([
              { kind: "claim", page_action: "create", before_hash: null, after_hash: AFTER },
              { kind: "deletion", page_action: "archive", before_hash: BEFORE, after_hash: AFTER },
              { kind: "entity", page_action: "edit", before_hash: BEFORE, after_hash: AFTER },
            ]);
            expect(db.query("SELECT body,frontmatter FROM claims WHERE authority='owner_correction'").all()).toEqual([{
              body: "Synthetic legacy claim evidence.",
              frontmatter: JSON.stringify({ "x-rejection-reason": "Synthetic retained reason.", "x-migrated-from": "rejections" }),
            }]);
            expect(db.query("SELECT count(*) AS n FROM proposals WHERE producer='owner'").get()).toEqual({ n: 1 });
          }
          const claims = db.query("SELECT * FROM claims ORDER BY claim_id").all();
          if (open === 0) snapshot = claims;
          else expect(claims).toEqual(snapshot);
        } finally { db.close(); }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const mutation of ["missing-hash", "ambiguous-hashes", "extra-column"] as const) {
  test(`malformed historical ${mutation} rolls back all pending migrations and preserves staged rows`, () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-staging-malformed-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const old = new Database(path);
      old.exec(STAGING_SCHEMA);
      populate(old);
      old.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (0)");
      if (mutation === "missing-hash") old.exec("ALTER TABLE promotions RENAME COLUMN after_hash TO unknown_hash");
      else old.exec(`ALTER TABLE promotions ADD COLUMN ${mutation === "ambiguous-hashes" ? "page_hash" : "unknown_column"} TEXT`);
      const schema = old.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
      const receipts = old.query("SELECT * FROM promotions ORDER BY receipt_id").all();
      const proposals = old.query("SELECT * FROM proposals ORDER BY proposal_id").all();
      old.close();

      expect(() => openLedger(path)).toThrow("historical promotions schema is unsupported");
      const unchanged = new Database(path);
      try {
        expect(readSchemaVersion(unchanged)).toBe(0);
        expect(unchanged.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schema);
        expect(unchanged.query("SELECT * FROM promotions ORDER BY receipt_id").all()).toEqual(receipts);
        expect(unchanged.query("SELECT * FROM proposals ORDER BY proposal_id").all()).toEqual(proposals);
      } finally { unchanged.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
