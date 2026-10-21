import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExportManifest } from "../../src/export";
import { exportVault, restoreVault } from "../../src/export";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import { writeRailCursor } from "../../src/ledger/checkpoints";
import { listUnwrittenLiveClaims } from "../../src/claims/store";
import { listQuarantinedClaims, recordStuckClaim, QUARANTINE_MS } from "../../src/serve/write-quarantine";
import { CANON_CLAIM_RETRY_MIGRATION_VERSION } from "../../src/world/tables/versions";
import { putEvent, storeClaim } from "../canon/helpers";
import { tempVault } from "../helpers/vault";

const at = "2026-03-01T00:00:00.000Z";
const prior = CANON_CLAIM_RETRY_MIGRATION_VERSION - 1;
function previousSchema(db: Database): void {
  db.exec("DROP TRIGGER canon_claim_retry_finished; DROP TABLE canon_claim_retries");
  db.query("UPDATE schema_version SET version=?").run(prior);
}
function oldHold(db: Database, id: string, overrides: Record<string, unknown> = {}): void {
  writeRailCursor(db, "kizuki.canon.writer", `legacy:${id}`, JSON.stringify({ attempts: 3, reason: "frontmatter_invalid", last_at: at, ...overrides }));
}

test("previous ledger retry rows migrate without changing claims or unrelated cursors; old backups transfer too", async () => {
  const vault = tempVault("kizuki-retry-migration-"), path = join(vault.path, ".kizuki", "kizuki.db");
  const backups = tempVault("kizuki-retry-backups-");
  let db = openLedger(path);
  try {
    const event = putEvent(db);
    const ids: string[] = [];
    for (const name of ["held", "expired", "future", "malformed", "dead"]) {
      ids.push((await storeClaim(db, event, { claim_id: `historical-${name}`, target: `people/${name}`,
        subject: `person:${name}`, subjects: [`person:${name}`], body: `Historical ${name} claim.` })).claim_id);
    }
    db.query("UPDATE claims SET status='skipped' WHERE claim_id=?").run(ids[4]!);
    previousSchema(db);
    oldHold(db, ids[0]!);
    oldHold(db, ids[1]!, { last_at: "2026-02-27T00:00:00.000Z" });
    oldHold(db, ids[2]!, { last_at: "2026-03-02T00:00:00.000Z" });
    oldHold(db, ids[3]!, { forged: true });
    oldHold(db, ids[4]!);
    oldHold(db, "missing-claim");
    writeRailCursor(db, "kizuki.canon.writer", "stuck:unrelated", "opaque unchanged");
    const claimsBefore = db.query("SELECT * FROM claims ORDER BY claim_id").all();
    const backup = join(backups.path, "old-backup"), restoredPath = join(backups.path, "restored");
    // Real previous-version table shape, before reopening applies the new migration.
    exportVault(db, vault.path, backup);
    db.close(); db = openLedger(path);
    expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: LEDGER_SCHEMA_VERSION });
    expect(db.query("SELECT * FROM claims ORDER BY claim_id").all()).toEqual(claimsBefore);
    expect(db.query("SELECT claim_id FROM canon_claim_retries ORDER BY claim_id").all()).toEqual(
      [ids[1], ids[2], ids[0]].map(claim_id => ({ claim_id })));
    expect(listQuarantinedClaims(db, at).claims.map(row => row.claim_id)).toEqual([ids[0]!]);
    expect(db.query("SELECT 1 FROM rail_cursors WHERE source_key LIKE 'legacy:%'").get()).toBeNull();
    expect(db.query("SELECT cursor FROM rail_cursors WHERE source_key='stuck:unrelated'").get()).toEqual({ cursor: "opaque unchanged" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    restoreVault(backup, restoredPath);
    const restored = openLedger(join(restoredPath, ".kizuki", "kizuki.db"));
    try {
      expect(listQuarantinedClaims(restored, at).claims).toEqual(listQuarantinedClaims(db, at).claims);
      expect(restored.query("SELECT 1 FROM rail_cursors WHERE source_key LIKE 'legacy:%'").get()).toBeNull();
    } finally { restored.close(); }
  } finally { db.close(); vault.dispose(); backups.dispose(); }
});

test("retry migration failure rolls back schema, cursor transfer and version before a successful restart", async () => {
  const vault = tempVault("kizuki-retry-rollback-"), path = join(vault.path, ".kizuki", "kizuki.db");
  let db: Database = openLedger(path);
  try {
    const claim = await storeClaim(db, putEvent(db));
    previousSchema(db); oldHold(db, claim.claim_id);
    db.exec("CREATE TRIGGER stop_retry_transfer BEFORE DELETE ON rail_cursors WHEN OLD.source_key LIKE 'legacy:%' BEGIN SELECT RAISE(ABORT,'synthetic migration interruption'); END");
    db.close();
    expect(() => openLedger(path)).toThrow("synthetic migration interruption");
    db = new Database(path);
    expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: prior });
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name='canon_claim_retries'").get()).toBeNull();
    expect(db.query("SELECT 1 FROM rail_cursors WHERE source_key LIKE 'legacy:%'").get()).not.toBeNull();
    db.exec("DROP TRIGGER stop_retry_transfer"); db.close(); db = openLedger(path);
    expect(listQuarantinedClaims(db, at).claims.map(row => row.claim_id)).toEqual([claim.claim_id]);
  } finally { db.close(); vault.dispose(); }
});

test("exact expiry, future time and completed lifecycle cannot suppress eligible work", async () => {
  const db = openLedger(":memory:");
  try {
    const claim = await storeClaim(db, putEvent(db));
    for (let attempt = 0; attempt < 3; attempt++) recordStuckClaim(db, claim.claim_id, "frontmatter_invalid", at);
    expect(listUnwrittenLiveClaims(db, 1, false, { now: at })).toEqual([]);
    expect(listUnwrittenLiveClaims(db, 1, false, { now: new Date(Date.parse(at) - 1).toISOString() })[0]?.claim_id).toBe(claim.claim_id);
    expect(listUnwrittenLiveClaims(db, 1, false, { now: new Date(Date.parse(at) + QUARANTINE_MS).toISOString() })[0]?.claim_id).toBe(claim.claim_id);
    db.query("UPDATE claims SET status='superseded' WHERE claim_id=?").run(claim.claim_id);
    expect(db.query("SELECT 1 FROM canon_claim_retries WHERE claim_id=?").get(claim.claim_id)).toBeNull();
    expect(recordStuckClaim(db, claim.claim_id, "ignored", at)).toBeNull();
    expect(recordStuckClaim(db, "missing-claim", "ignored", at)).toBeNull();
  } finally { db.close(); }
});


test("long identities survive backup; a backup cannot restore retry state for completed claims", async () => {
  const vault = tempVault("kizuki-retry-restore-"), backups = tempVault("kizuki-retry-restore-output-");
  const db = openLedger(join(vault.path, ".kizuki", "kizuki.db"));
  try {
    const id = "historical-" + "r".repeat(9000);
    await storeClaim(db, putEvent(db), { claim_id: id });
    for (let attempt = 0; attempt < 3; attempt++) recordStuckClaim(db, id, "frontmatter_invalid", at);
    const backup = join(backups.path, "backup"), restoredPath = join(backups.path, "restored");
    exportVault(db, vault.path, backup); restoreVault(backup, restoredPath);
    const restored = openLedger(join(restoredPath, ".kizuki", "kizuki.db"));
    try {
      expect(restored.query<{ claim_id: string }, []>("SELECT claim_id FROM canon_claim_retries").get()?.claim_id).toBe(id);
      expect(listQuarantinedClaims(restored, at)).toEqual({ claims: [], truncated: true });
      expect(listUnwrittenLiveClaims(restored, 1, false, { now: at })).toEqual([]);
    } finally { restored.close(); }

    const manifestPath = join(backup, "manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExportManifest;
    const stream = "claims/claims.jsonl";
    const rows = readFileSync(join(backup, stream), "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const row of rows) if (row.claim_id === id) row.status = "skipped";
    const bytes = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(join(backup, stream), bytes);
    manifest.files[stream] = { ...manifest.files[stream]!, size: Buffer.byteLength(bytes), sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
    const unsigned = { schema: manifest.schema, vault_id: manifest.vault_id, created_at: manifest.created_at,
      schema_versions: manifest.schema_versions, snapshot: manifest.snapshot, complete: manifest.complete,
      files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
    const digest = new Bun.CryptoHasher("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify({ ...unsigned, manifest_sha256: digest }, null, 2)}\n`);
    const refused = join(backups.path, "refused");
    expect(() => restoreVault(backup, refused)).toThrow("retry requires a live unwritten legacy claim");
    expect(existsSync(refused)).toBe(false);
  } finally { db.close(); vault.dispose(); backups.dispose(); }
});
