import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backfillSupportObservations } from "../../src/claims/observations";
import { rebuildWorldLayer } from "../../src/derived";
import { exportVault, restoreVault, type ExportManifest } from "../../src/export";
import { ensureLedgerSchema, openLedger } from "../../src/ledger/db";
import { purgeEvents } from "../../src/ledger/purge";
import { serveWorldView } from "../../src/serving/world-view";
import { assertWorldState } from "../../src/world/integrity";
import { referenceScope } from "../../src/world/ref-kinds/common";
import { issueObservationRef } from "../../src/world/ref-kinds/observation";
import { applyObservationHistoryErasure } from "../../src/world/tables/observations";
import { OBSERVATION_HISTORY_ERASURE_MIGRATION_VERSION } from "../../src/world/tables/versions";
import { tempVault } from "../helpers/vault";
import { worldFixture } from "../serving/world-fixture";

const observations = (db: Database) => db.query<{ observation_id: string; admission_id: string; support_key: string; record: string }, []>(
  "SELECT * FROM world_observations ORDER BY observation_id").all();
const orphanCount = (db: Database) => db.query<{ n: number }, []>(`SELECT count(*) n FROM world_observations o
  WHERE NOT EXISTS(SELECT 1 FROM claim_lifecycle_history h WHERE h.support_key=o.support_key)`).get()!.n;

async function fixture() {
  const vault = tempVault("kizuki-observation-history-"), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const first = await worldFixture(db, { completeSummary: true });
  const survivor = await worldFixture(db, { completeSummary: true, sourceKey: first.sourceKey });
  const unrelated = await worldFixture(db, { completeSummary: true, subject: "topic:independent", label: "Independent topic" });
  const members = db.query<{ observation_id: string; event_id: string }, [string]>(
    "SELECT * FROM world_observation_events WHERE event_id=? ORDER BY observation_id").all(survivor.eventId);
  const retained = observations(db).filter(row => members.some(member => member.observation_id === row.observation_id));
  const ctx = { ...survivor.ctx, vaultPath: vault.path };
  const ref = db.transaction(() => issueObservationRef(referenceScope(ctx), retained[0]!.observation_id)).immediate();
  const read = () => serveWorldView(ctx, { operation: "observation", ref, valid: { kind: "all" }, knownAt: { kind: "current" } }).data;
  const other = () => db.query("SELECT o.* FROM world_observations o JOIN world_observation_events e USING(observation_id) WHERE e.event_id=? ORDER BY observation_id").all(unrelated.eventId);
  const erase = () => purgeEvents(db, vault.path, { event_id: first.eventId }, "synthetic history erasure");
  return { db, vault, first, survivor, retained, members, ref, read, other, erase, dispose() { db.close(); vault.dispose(); } };
}

test("erasure removes only history-dependent observations and capabilities; surviving support remains a rebuildable baseline", async () => {
  const f = await fixture(); try {
    assertWorldState(f.db); expect(orphanCount(f.db)).toBe(0);
    expect(f.read()).not.toEqual({ status: "not_found" });
    const other = f.other();
    const event = f.db.query("SELECT * FROM events WHERE event_id=?").get(f.survivor.eventId);
    f.erase();
    assertWorldState(f.db); expect(orphanCount(f.db)).toBe(0);
    expect(f.db.query("SELECT * FROM events WHERE event_id=?").get(f.survivor.eventId)).toEqual(event);
    expect(f.other()).toEqual(other);
    expect(f.read()).toEqual({ status: "not_found" });
    expect(f.db.query("SELECT 1 FROM world_wire_refs WHERE wire_ref=?").get(f.ref.token)).toBeNull();
    for (const row of f.retained) {
      expect(f.db.query("SELECT 1 FROM claim_v2_support WHERE support_key=?").get(row.support_key)).not.toBeNull();
      expect(f.db.query("SELECT 1 FROM world_observations WHERE observation_id=?").get(row.observation_id)).toBeNull();
    }
    for (const id of f.first.claims) {
      expect(f.db.query("SELECT status,provenance FROM claims WHERE claim_id=?").get(id)).toEqual({ status: "live", provenance: JSON.stringify([f.survivor.eventId]) });
      expect(f.db.query("SELECT coverage FROM claim_history_coverage WHERE claim_id=?").get(id)).toEqual({ coverage: "baseline_only" });
      expect(f.db.query("SELECT support_key FROM claim_lifecycle_history WHERE claim_id=?").all(id)).toEqual([{ support_key: null }]);
    }
    const before = observations(f.db);
    rebuildWorldLayer(f.db);
    f.db.transaction(() => backfillSupportObservations(f.db)).immediate();
    assertWorldState(f.db); expect(observations(f.db)).toEqual(before);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.dispose(); }
}, 120_000);

for (const version of [45, 46]) test(`schema ${version} observation upgrade cleans old orphans atomically without changing surviving admission records`, async () => {
  const f = await fixture(); try {
    // Observation/history schemas are identical in these two predecessors.
    f.db.exec("DROP TRIGGER world_observation_history_erased");
    f.db.query("UPDATE schema_version SET version=?").run(version);
    assertWorldState(f.db); f.erase();
    expect(orphanCount(f.db)).toBe(3);
    expect(() => assertWorldState(f.db)).toThrow("observation does not match its admitted support");
    const before = observations(f.db), other = f.other();
    expect(() => f.db.transaction(() => { applyObservationHistoryErasure(f.db); throw Error("migration rollback"); }).immediate()).toThrow("migration rollback");
    expect(observations(f.db)).toEqual(before);
    expect(f.db.query("SELECT 1 FROM sqlite_master WHERE name='world_observation_history_erased'").get()).toBeNull();
    ensureLedgerSchema(f.db);
    assertWorldState(f.db); expect(orphanCount(f.db)).toBe(0);
    expect(f.other()).toEqual(other);
    expect(f.db.query("SELECT version FROM schema_version").get()).toEqual({ version: OBSERVATION_HISTORY_ERASURE_MIGRATION_VERSION });
    expect(f.db.query("SELECT 1 FROM world_wire_refs WHERE wire_ref=?").get(f.ref.token)).toBeNull();
    const after = observations(f.db);
    ensureLedgerSchema(f.db); expect(observations(f.db)).toEqual(after);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { f.dispose(); }
}, 120_000);

function legacyArchive(backup: string, version: number, f: Awaited<ReturnType<typeof fixture>>): void {
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")) as ExportManifest;
  for (const [table, rows] of [["world_observations", f.retained], ["world_observation_events", f.members]] as const) {
    const key = `world/${table}.jsonl`, path = join(backup, key);
    const bytes = readFileSync(path, "utf8") + rows.map(row => `${JSON.stringify(row)}\n`).join("");
    writeFileSync(path, bytes);
    manifest.files[key] = { ...manifest.files[key]!, size: Buffer.byteLength(bytes), count: manifest.files[key]!.count + rows.length,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
  }
  manifest.schema_versions.ledger = version;
  const { manifest_sha256: ignored, ...unsigned } = manifest;
  manifest.manifest_sha256 = new Bun.CryptoHasher("sha256").update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex");
  writeFileSync(join(backup, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

test("legacy archives reconcile after import; current archives reject orphans and clean backups round trip", async () => {
  const f = await fixture(), storage = tempVault("kizuki-observation-history-backup-"); try {
    f.erase(); const before = observations(f.db);
    const backup = join(storage.path, "clean"), restored = join(storage.path, "restored");
    exportVault(f.db, f.vault.path, backup); restoreVault(backup, restored);
    let db = openLedger(join(restored, ".kizuki/kizuki.db"));
    try { assertWorldState(db); expect(observations(db)).toEqual(before); } finally { db.close(); }
    for (const version of [45, 46, OBSERVATION_HISTORY_ERASURE_MIGRATION_VERSION]) {
      const archive = join(storage.path, `archive-${version}`), target = join(storage.path, `restored-${version}`);
      exportVault(f.db, f.vault.path, archive); legacyArchive(archive, version, f);
      if (version === OBSERVATION_HISTORY_ERASURE_MIGRATION_VERSION) {
        expect(() => restoreVault(archive, target)).toThrow("observation does not match its admitted support");
        expect(existsSync(target)).toBe(false);
      } else {
        restoreVault(archive, target); db = openLedger(join(target, ".kizuki/kizuki.db"));
        try {
          assertWorldState(db); expect(observations(db)).toEqual(before); expect(orphanCount(db)).toBe(0);
          expect(db.query("SELECT count(*) n FROM claim_v2_support").get()).toEqual({ n: 6 });
          rebuildWorldLayer(db); expect(observations(db)).toEqual(before);
        } finally { db.close(); }
      }
    }
  } finally { f.dispose(); storage.dispose(); }
}, 120_000);
