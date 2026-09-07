import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { insertClaim } from "../../src/claims/store";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { verifyPurge } from "../../src/ledger/purge";
import { validEvent } from "../fixtures";
import { tempVault } from "../helpers/vault";

const AT = "2026-09-06T15:00:00.000Z";
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });

async function legacyFixture(ambiguous = false) {
  const disk = tempVault("kizuki-purge-migration-");
  const path = join(disk.path, ".kizuki", "kizuki.db");
  let db = openLedger(path);
  disposers.push(disk.dispose, () => db.close());
  const event = (name: string) => {
    const result = accept(db, { ...validEvent(), source_record_id: name, text: name });
    if (result.status !== "stored") throw new Error("ordinary event was not stored");
    return result.event;
  };
  const first = event("Atlas"), second = event("Beacon");
  await insertClaim({ db, now: () => AT }, {
    kind: "claim", body: "Ordinary historical claim", provenance: [first.event_id], producer: "deterministic",
    confidence: 0.8, sensitivity: "personal", taint: "quoted",
  });
  // Reconstruct only v18 purge metadata. No historical program is executed.
  db.exec("DROP TABLE purge_batch_receipts; DROP TABLE purge_batches; UPDATE schema_version SET version=18");
  const receipt = db.query("INSERT INTO event_purges VALUES(?,?, 'fixture','ordinary retired fixture',?)");
  receipt.run("ordinary-first-receipt", first.event_id, AT);
  receipt.run("ordinary-second-receipt", second.event_id, AT);
  db.query("DELETE FROM events WHERE event_id IN (?,?)").run(first.event_id, second.event_id);
  const ids = JSON.stringify([`event:${first.event_id}`, `event:${second.event_id}`, "page:atlas"]);
  const proof = JSON.stringify({ checked: 3, found: [], store: "kizuki.retrieval.fts5", method: "sql-exact-documents", at: AT });
  const op = db.query("INSERT INTO purge_ops VALUES(?,?,'kizuki.retrieval.fts5',?,'done',?,?,?)");
  op.run("ordinary-first-op", "ordinary-first-receipt", ids, proof, AT, AT);
  if (ambiguous) op.run("ordinary-second-op", "ordinary-second-receipt", ids, proof, AT, AT);
  db.query("INSERT INTO canon_holds VALUES('facts/atlas.md','ordinary-first-receipt','ordinary fixture',?)").run(AT);
  const before = { claims: db.query("SELECT * FROM claims").all(), receipts: db.query("SELECT * FROM event_purges").all() };
  return {
    get db() { return db; }, before, vaultPath: disk.path, path,
    reopen() { db.close(); db = openLedger(path); },
  };
}

test("v19 derives legacy aliases only from explicit event inventories and preserves claim history", async () => {
  const f = await legacyFixture();
  f.reopen();
  expect(f.db.query("SELECT version FROM schema_version").get()).toEqual({ version: LEDGER_SCHEMA_VERSION });
  expect(f.db.query("SELECT * FROM claims").all()).toEqual(f.before.claims);
  expect(f.db.query("SELECT * FROM event_purges").all()).toEqual(f.before.receipts);
  expect(f.db.query("SELECT * FROM purge_batch_receipts ORDER BY receipt_id").all()).toEqual([
    { receipt_id: "ordinary-first-receipt", batch_id: "ordinary-first-receipt" },
    { receipt_id: "ordinary-second-receipt", batch_id: "ordinary-first-receipt" },
  ]);
  expect(f.db.query("SELECT state FROM purge_batches").all()).toEqual([{ state: "discovering" }]);
  expect(f.db.query("SELECT state,proof,done_at FROM purge_ops").all()).toEqual([{ state: "pending", proof: null, done_at: null }]);
  for (const receipt of ["ordinary-first-receipt", "ordinary-second-receipt"]) {
    expect((await verifyPurge(f.db, f.vaultPath, receipt)).ok).toBe(false);
  }
});

test("overlapping legacy inventories retain unresolved batches without invented aliases", async () => {
  const f = await legacyFixture(true);
  f.reopen();
  expect(f.db.query("SELECT state FROM purge_batches").all()).toEqual([{ state: "legacy_unresolved" }, { state: "legacy_unresolved" }]);
  expect(f.db.query("SELECT * FROM purge_batch_receipts").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM claims").all()).toEqual(f.before.claims);
  for (const receipt of ["ordinary-first-receipt", "ordinary-second-receipt"]) {
    expect((await verifyPurge(f.db, f.vaultPath, receipt)).ok).toBe(false);
  }
});

for (const alteration of ["missing index", "missing constraints"] as const) {
  test(`current batch metadata with ${alteration} is refused on open`, () => {
    const disk = tempVault("kizuki-purge-schema-check-");
    disposers.push(disk.dispose);
    const path = join(disk.path, ".kizuki", "kizuki.db");
    const initialized = openLedger(path); initialized.close();
    const fixture = new Database(path);
    try {
      if (alteration === "missing index") fixture.exec("DROP INDEX purge_batch_receipts_by_batch");
      else fixture.exec(`DROP TABLE purge_batch_receipts;
        CREATE TABLE purge_batch_receipts(receipt_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL) STRICT;
        CREATE INDEX purge_batch_receipts_by_batch ON purge_batch_receipts(batch_id,receipt_id)`);
    } finally { fixture.close(); }
    expect(() => openLedger(path)).toThrow("purge batch");
  });
}
