import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_SCHEMA, LEGACY_BACKUP_SCHEMA, V2_BACKUP_SCHEMA,
  exportVault, restoreVault, type ExportManifest,
} from "../src/export";
import { runSync } from "../src/ingest/run";
import { ConnectionStateStore, NULL_CONNECTION_CONFIG, STATE_CONNECTION_CONFIG } from "../src/ledger/connection-state";
import { getCheckpoint, getConnection, listConnections, registerConnection, saveCheckpoint } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";
import { enrollConnection } from "../src/ledger/enroll";
import { inspectSourceGrant, setSourceGrant, sourceCaptureAdmission } from "../src/ledger/source-grants";
import { isRfc3339 } from "../src/util/time";
import { ulid } from "../src/util/ulid";
import { initVault } from "../src/vault/init";
import { connector, io } from "./connections-helpers";

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
const CONNECTED_AT = "2026-01-01T00:00:00.000Z";
const DISCONNECTED_AT = "2026-02-01T00:00:00.000Z";
const policy = {
  purposes: ["capture", "recall", "session", "derive", "extract", "export"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kizuki-export-connections-"));
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(":memory:");
  disposers.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, root, vault, backup: join(root, "backup"), target: join(root, "restored") };
}

function addHistory(db: ReturnType<typeof openLedger>, options: { opaque?: boolean; disconnected?: boolean; grant?: boolean } = {}) {
  const source = ulid();
  registerConnection(db, "fixture", source, { implementation_version: "fixture@1" });
  const checkpoint = saveCheckpoint(db, "fixture", source, "historical-cursor", "sync", {
    stored: 0, duplicates: 0, errors: [], proposals_created: 0, withdrawn: 0, retractions_filed: 0, cursor: "historical-cursor",
  });
  db.query("UPDATE connections SET config=?,secret_refs=?,connected_at=?,disconnected_at=? WHERE source_key=?").run(
    options.opaque ? STATE_CONNECTION_CONFIG : NULL_CONNECTION_CONFIG,
    options.opaque ? JSON.stringify([`file:connections/${source}.state`]) : "[]",
    CONNECTED_AT, options.disconnected ? DISCONNECTED_AT : null, source,
  );
  if (options.grant) setSourceGrant(db, { source_key: source, expected_revision: 0, operation_id: "history-grant", policy });
  return { source, checkpoint };
}

function connectionRows(backup: string): Record<string, unknown>[] {
  return readFileSync(join(backup, "connections.jsonl"), "utf8").trim().split("\n")
    .filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

/** A benign historical-format connection record, consumed only by the repaired reader. */
function historicalConnection(backup: string, manifest: ExportManifest, source: string, schema: ExportManifest["schema"]): void {
  const row = {
    connector_id: "fixture", source_key: source,
    config: JSON.parse(STATE_CONNECTION_CONFIG) as unknown,
    secret_refs: [`file:connections/${source}.state`],
    connected_at: CONNECTED_AT, disconnected_at: null, implementation_version: "fixture@1", consent_required: 1,
  };
  const bytes = `${JSON.stringify(row)}\n`;
  writeFileSync(join(backup, "connections.jsonl"), bytes, { mode: 0o600 });
  manifest.files["connections.jsonl"] = {
    count: 1, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), size: Buffer.byteLength(bytes), mode: 0o600,
  };
  manifest.schema = schema;
  if (schema === LEGACY_BACKUP_SCHEMA) {
    manifest.schema_versions.ledger = 15;
    delete manifest.files["ledger/canon-machine-byte-intents.jsonl"];
    unlinkSync(join(backup, "ledger", "canon-machine-byte-intents.jsonl"));
  }
  const { manifest_sha256: _digest, ...unsigned } = manifest;
  unsigned.files = Object.fromEntries(Object.entries(unsigned.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const signed = { ...unsigned, manifest_sha256: new Bun.CryptoHasher("sha256")
    .update(`${JSON.stringify(unsigned, null, 2)}\n`).digest("hex") };
  writeFileSync(join(backup, "manifest.json"), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
}

describe("portable connection history", () => {
  test("exports disconnected null-state history without changing source rows or resolving opaque state", () => {
    const { db, vault, backup, target } = fixture();
    const active = addHistory(db, { opaque: true });
    const disconnected = addHistory(db, { disconnected: true });
    const before = db.query("SELECT * FROM connections ORDER BY source_key").all();
    const manifest = exportVault(db, vault, backup);
    expect(manifest.schema).toBe(BACKUP_SCHEMA);
    const rows = connectionRows(backup);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.config).toEqual(JSON.parse(NULL_CONNECTION_CONFIG));
      expect(row.secret_refs).toEqual([]);
      expect(row.connected_at).toBe(CONNECTED_AT);
      expect(isRfc3339(row.disconnected_at)).toBe(true);
    }
    expect(rows.find(row => row.source_key === disconnected.source)?.disconnected_at).toBe(DISCONNECTED_AT);
    expect(db.query("SELECT * FROM connections ORDER BY source_key").all()).toEqual(before);
    expect(Object.keys(manifest.files).some(path => path.includes(".state"))).toBe(false);
    const report = restoreVault(backup, target);
    expect(report.recovery_warnings.join(" ")).toContain("fresh enrollment with a new source key and fresh consent");
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    try {
      expect(listConnections(restored)).toEqual([]);
      expect(getConnection(restored, "fixture", active.source)).toMatchObject({ config: JSON.parse(NULL_CONNECTION_CONFIG), secret_refs: [] });
      expect(getConnection(restored, "fixture", disconnected.source)?.disconnected_at).toBe(DISCONNECTED_AT);
      expect(getCheckpoint(restored, "fixture", active.source)).toEqual(active.checkpoint);
      expect(getCheckpoint(restored, "fixture", disconnected.source)).toEqual(disconnected.checkpoint);
    } finally { restored.close(); }
  });

  for (const schema of [LEGACY_BACKUP_SCHEMA, V2_BACKUP_SCHEMA, BACKUP_SCHEMA]) {
    test(`normalizes old active ${schema} connection records and preserves inert source evidence`, async () => {
      const { db, vault, backup, target } = fixture();
      const { source, checkpoint } = addHistory(db, { opaque: true, grant: true });
      const grants = db.query("SELECT * FROM source_grants ORDER BY source_key").all();
      const receipts = db.query("SELECT * FROM source_grant_receipts ORDER BY sequence").all();
      historicalConnection(backup, exportVault(db, vault, backup), source, schema);
      const report = restoreVault(backup, target);
      expect(report.recovery_warnings.join(" ")).toContain("retained checkpoints will not resume automatically");
      const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
      try {
        const history = getConnection(restored, "fixture", source)!;
        expect(history.config).toEqual({ schema: "kizuki.connection-config/v1", state_ref_index: null });
        expect(history.secret_refs).toEqual([]);
        expect(isRfc3339(history.disconnected_at)).toBe(true);
        expect(listConnections(restored)).toEqual([]);
        expect(listConnections(restored, { includeDisconnected: true })).toHaveLength(1);
        expect(getCheckpoint(restored, "fixture", source)).toEqual(checkpoint);
        expect(restored.query("SELECT * FROM source_grants ORDER BY source_key").all()).toEqual(grants);
        expect(restored.query("SELECT * FROM source_grant_receipts ORDER BY sequence").all()).toEqual(receipts);
        expect(() => sourceCaptureAdmission(restored, "fixture", source)).toThrow("source_capture_denied");
        let contacted = false;
        const fixtureConnector = connector(async () => { contacted = true; return { display: "fixture" }; });
        fixtureConnector.sync = async () => { contacted = true; return { events: [], cursor: null }; };
        const run = await runSync(restored, fixtureConnector, "fixture", source);
        expect(run.errors).toContain("checkpoint requires an active connection");
        const store = new ConnectionStateStore(join(target, ".kizuki"));
        expect(store.read(history)).toBeNull();
        await expect(store.replace(restored, history, fixtureConnector, io)).rejects.toThrow("not eligible for state replacement");
        await expect(store.rewrite(restored, history, async () => { contacted = true; })).rejects.toThrow("not eligible for state replacement");
        expect(contacted).toBe(false);
        expect(existsSync(join(target, ".kizuki", "connections", `${source}.state`))).toBe(false);
      } finally { restored.close(); }
    });
  }

  test("independent core stateless enrollment gets a fresh identity, consent and checkpoint", async () => {
    const { db, vault, backup, target } = fixture();
    const { source, checkpoint } = addHistory(db, { grant: true });
    exportVault(db, vault, backup);
    restoreVault(backup, target);
    const restored = openLedger(join(target, ".kizuki", "kizuki.db"));
    try {
      const store = new ConnectionStateStore(join(target, ".kizuki"));
      const calls: (string | null)[] = [];
      const base = connector(async () => ({ display: "independent synthetic enrollment" }));
      const fixtureConnector = {
        ...base,
        manifest: () => ({ ...base.manifest(), capabilities: { ...base.manifest().capabilities, sync: true } }),
        sync: async (cursor: string | null) => { calls.push(cursor); return { events: [], cursor: "fresh-cursor" }; },
      };
      const fresh = await enrollConnection(restored, store, fixtureConnector, io);
      expect(fresh.source_key).not.toBe(source);
      expect(fresh.disconnected_at).toBeNull();
      expect(getCheckpoint(restored, "fixture", fresh.source_key)).toBeNull();
      expect(inspectSourceGrant(restored, fresh.source_key)).toBeNull();
      expect(() => sourceCaptureAdmission(restored, "fixture", fresh.source_key)).toThrow("source_capture_denied");
      setSourceGrant(restored, { source_key: fresh.source_key, expected_revision: 0, operation_id: "fresh-grant", policy });
      const run = await runSync(restored, fixtureConnector, "fixture", fresh.source_key);
      expect(run.errors).toEqual([]);
      expect(calls).toEqual([null]);
      expect(getCheckpoint(restored, "fixture", fresh.source_key)?.cursor).toBe("fresh-cursor");
      expect(getCheckpoint(restored, "fixture", source)).toEqual(checkpoint);
      expect(getConnection(restored, "fixture", source)?.disconnected_at).not.toBeNull();
    } finally { restored.close(); }
  });

  test("does not report connection re-enrollment when the backup has no connection history", () => {
    const { db, vault, backup, target } = fixture();
    exportVault(db, vault, backup);
    expect(restoreVault(backup, target).recovery_warnings).toEqual([]);
  });
});
