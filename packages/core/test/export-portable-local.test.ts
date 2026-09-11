import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportVault, restoreVault, verifyBackup, type ExportManifest, type PortableLocalAdapter } from "../src/export";
import { ConnectionStateStore } from "../src/ledger/connection-state";
import { getCheckpoint, getConnection } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";
import { enrollConnection } from "../src/ledger/enroll";
import { setSourceGrant, sourceCaptureAdmission } from "../src/ledger/source-grants";
import { PORTABLE_LOCAL_STREAM } from "../src/portable-local";
import { sha256Hex } from "../src/util/hash";
import { initVault } from "../src/vault/init";
import { connector, io, temporaryDirectories } from "./connections-helpers";

const dirs = temporaryDirectories("kizuki-portable-local-");
const close: (() => void)[] = [];
afterEach(() => { for (const dispose of close.splice(0)) dispose(); dirs.cleanup(); });
const adapter: PortableLocalAdapter = Object.freeze({
  connector_ids: Object.freeze(["fixture"]),
  decode(_id: string, bytes: Uint8Array) { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); },
  encode(_id: string, config: { readonly path: string }) { return new TextEncoder().encode(JSON.stringify(config)); },
});
const policy = { purposes: ["capture", "recall", "session", "derive", "extract", "export"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked",
  egress: "local_only", sensitivity_floor: "private" };
async function fixture(options: { disconnected?: boolean; capture?: boolean; grant?: boolean } = {}) {
  const root = dirs.temporary(), vault = join(root, "vault"), backup = join(root, "backup"), target = join(root, "restored");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki/kizuki.db")); close.push(() => db.close());
  const state = new ConnectionStateStore(join(vault, ".kizuki"));
  const connection = await enrollConnection(db, state, connector(async (_io, writer) => {
    await writer.write(adapter.encode("fixture", { path: join(root, "synthetic-source") })); return { display: "synthetic" };
  }), io);
  if (options.grant !== false) setSourceGrant(db, { source_key: connection.source_key, expected_revision: 0, operation_id: "fixture-grant",
    policy: { ...policy, purposes: options.capture === false ? ["export"] : policy.purposes } });
  if (options.disconnected) db.query("UPDATE connections SET disconnected_at=? WHERE source_key=?").run("2026-01-02T00:00:00.000Z", connection.source_key);
  db.query("INSERT INTO checkpoints(connector_id,source_key,cursor,mode,updated_at,last_run_at,last_result) VALUES (?,?,?,?,?,?,?)").run("fixture", connection.source_key, "synthetic-checkpoint", "sync", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z", JSON.stringify({ stored: 0, duplicates: 0, errors: [], proposals_created: 0, withdrawn: 0, retractions_filed: 0, cursor: "synthetic-checkpoint" }));
  const statePath = join(vault, ".kizuki/connections", `${connection.source_key}.state`);
  return { root, vault, db, backup, target, connection, statePath, options: { portableLocal: adapter } };
}
function rewritten(backup: string, path: string, rows: unknown[]): void {
  const bytes = rows.map(row => JSON.stringify(row) + "\n").join("");
  writeFileSync(join(backup, path), bytes, { mode: 0o600 });
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")) as ExportManifest;
  manifest.files[path] = { count: rows.length, size: Buffer.byteLength(bytes), mode: 0o600, sha256: sha256Hex(bytes) };
  const { manifest_sha256: _hash, ...unsigned } = manifest;
  unsigned.files = Object.fromEntries(Object.entries(unsigned.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const signed = { ...unsigned, manifest_sha256: sha256Hex(`${JSON.stringify(unsigned, null, 2)}\n`) };
  writeFileSync(join(backup, "manifest.json"), `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });
}
function rows(backup: string, path = PORTABLE_LOCAL_STREAM): Record<string, unknown>[] {
  return readFileSync(join(backup, path), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

for (const mode of ["active", "disconnected", "no-capture", "no-grant"] as const) {
  test(`portable restore preserves ${mode} source authority and original checkpoint`, async () => {
    const f = await fixture({ disconnected: mode === "disconnected", capture: mode !== "no-capture", grant: mode !== "no-grant" });
    const before = getConnection(f.db, "fixture", f.connection.source_key), checkpoint = getCheckpoint(f.db, "fixture", f.connection.source_key);
    const grants = f.db.query("SELECT * FROM source_grants").all();
    const manifest = exportVault(f.db, f.vault, f.backup, f.options);
    expect(manifest.files[PORTABLE_LOCAL_STREAM]?.count).toBe(mode === "no-grant" ? 0 : 1);
    if (mode !== "no-grant") expect(rows(f.backup)[0]?.was_connected).toBe(mode !== "disconnected");
    expect(verifyBackup(f.backup)).toEqual(manifest);
    const report = restoreVault(f.backup, f.target, f.options);
    expect(report.connection_state).toBe(mode === "no-grant" ? 0 : 1);
    const db = openLedger(join(f.target, ".kizuki/kizuki.db"));
    try {
      const restored = getConnection(db, "fixture", f.connection.source_key)!;
      if (mode === "no-grant") expect(restored.secret_refs).toEqual([]);
      else expect(new ConnectionStateStore(join(f.target, ".kizuki")).read(restored)).toEqual(new Uint8Array(readFileSync(f.statePath)));
      expect(getCheckpoint(db, "fixture", restored.source_key)).toEqual(checkpoint);
      expect(db.query("SELECT * FROM source_grants").all()).toEqual(grants);
      if (mode === "active") expect(sourceCaptureAdmission(db, "fixture", restored.source_key)).toEqual({ source_key: restored.source_key, expected_revision: 1 });
      else {
        expect(restored.disconnected_at).not.toBeNull();
        expect(() => sourceCaptureAdmission(db, "fixture", restored.source_key)).toThrow();
      }
      if (mode === "disconnected") expect(restored.disconnected_at).toBe(before!.disconnected_at);
    } finally { db.close(); }
    expect(getConnection(f.db, "fixture", f.connection.source_key)).toEqual(before);
  });
}

test("adapter absent validates the stream but restores inert history; legacy loose state is never consumed", async () => {
  const f = await fixture(); exportVault(f.db, f.vault, f.backup, f.options);
  const report = restoreVault(f.backup, f.target);
  expect(report.connection_state).toBe(0);
  expect(existsSync(join(f.target, ".kizuki/connections", `${f.connection.source_key}.state`))).toBe(false);
  const legacy = join(f.root, "legacy"), target = join(f.root, "legacy-restored");
  exportVault(f.db, f.vault, legacy);
  mkdirSync(join(legacy, "connections"), { mode: 0o700 });
  symlinkSync(f.statePath, join(legacy, "connections", `${f.connection.source_key}.state`));
  expect(restoreVault(legacy, target, f.options).connection_state).toBe(0);
  expect(existsSync(join(target, ".kizuki/connections", `${f.connection.source_key}.state`))).toBe(false);
});

for (const mutation of ["unknown-id", "unknown-source", "duplicate", "path-relative", "path-alias", "extra-key", "wrong-lifecycle"] as const) {
  test(`rehashed ${mutation} stream fails before publication and codec callbacks`, async () => {
    const f = await fixture(); exportVault(f.db, f.vault, f.backup, f.options);
    const [row] = rows(f.backup); expect(row).toBeDefined();
    if (mutation === "unknown-id") row!.connector_id = "unknown";
    if (mutation === "unknown-source") row!.source_key = "00000000000000000000000000";
    if (mutation === "path-relative") row!.path = "relative";
    if (mutation === "path-alias") row!.path = "/tmp/../synthetic";
    if (mutation === "extra-key") row!.secret_ref = "synthetic-rejected-extra";
    if (mutation === "wrong-lifecycle") row!.was_connected = false;
    rewritten(f.backup, PORTABLE_LOCAL_STREAM, mutation === "duplicate" ? [row, row] : [row]);
    let called = 0;
    const options = { portableLocal: { ...adapter, encode() { called++; return new Uint8Array(); }, decode() { called++; return { path: "/tmp" }; } } };
    expect(() => verifyBackup(f.backup, options)).toThrow();
    expect(() => restoreVault(f.backup, f.target, options)).toThrow();
    expect(called).toBe(0); expect(existsSync(f.target)).toBe(false);
  });
}

for (const mutation of ["file-mode", "directory-mode", "hardlink", "parent-symlink", "oversize", "malformed"] as const) {
  test(`export refuses ${mutation} source custody without publishing backup`, async () => {
    const f = await fixture();
    if (mutation === "file-mode") chmodSync(f.statePath, 0o644);
    if (mutation === "directory-mode") chmodSync(join(f.vault, ".kizuki/connections"), 0o755);
    if (mutation === "hardlink") linkSync(f.statePath, join(f.root, "state-alias"));
    if (mutation === "parent-symlink") {
      const from = join(f.vault, ".kizuki/connections"), to = join(f.root, "aliased-connections"); renameSync(from, to); symlinkSync(to, from);
    }
    if (mutation === "oversize") writeFileSync(f.statePath, new Uint8Array(1_048_577));
    if (mutation === "malformed") writeFileSync(f.statePath, "synthetic malformed state");
    expect(() => exportVault(f.db, f.vault, f.backup, f.options)).toThrow();
    expect(existsSync(f.backup)).toBe(false);
  });
}

for (const mutation of ["file-mode", "directory-mode", "root-mode", "parent-symlink", "unmanifested"] as const) {
  test(`verify refuses ${mutation} backup stream even without adapter`, async () => {
    const f = await fixture(); exportVault(f.db, f.vault, f.backup, f.options);
    if (mutation === "file-mode") chmodSync(join(f.backup, PORTABLE_LOCAL_STREAM), 0o644);
    if (mutation === "directory-mode") chmodSync(join(f.backup, "connections"), 0o755);
    if (mutation === "root-mode") chmodSync(f.backup, 0o755);
    if (mutation === "parent-symlink") {
      const from = join(f.backup, "connections"), to = join(f.root, "aliased-backup-connections"); renameSync(from, to); symlinkSync(to, from);
    }
    if (mutation === "unmanifested") {
      const bytes = readFileSync(join(f.backup, PORTABLE_LOCAL_STREAM));
      const manifest = JSON.parse(readFileSync(join(f.backup, "manifest.json"), "utf8")) as ExportManifest;
      delete manifest.files[PORTABLE_LOCAL_STREAM];
      const { manifest_sha256: _hash, ...unsigned } = manifest;
      writeFileSync(join(f.backup, "manifest.json"), JSON.stringify({ ...unsigned, manifest_sha256: sha256Hex(`${JSON.stringify(unsigned, null, 2)}\n`) }));
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
    expect(() => verifyBackup(f.backup)).toThrow();
    expect(() => restoreVault(f.backup, f.target, f.options)).toThrow(); expect(existsSync(f.target)).toBe(false);
  });
}

for (const mutation of ["throws", "state-tamper", "backup-tamper", "open-transaction"] as const) {
  test(`strict staged rebuild ${mutation} discards staging and leaves target absent`, async () => {
    const f = await fixture(); exportVault(f.db, f.vault, f.backup, f.options);
    let called = false;
    expect(() => restoreVault(f.backup, f.target, { ...f.options, rebuildDerived(db, staging) {
      called = true;
      expect(existsSync(f.target)).toBe(false);
      expect(getConnection(db, "fixture", f.connection.source_key)?.disconnected_at).toBeNull();
      if (mutation === "throws") throw new Error("synthetic_rebuild_failed");
      if (mutation === "state-tamper") writeFileSync(join(staging, ".kizuki/connections", `${f.connection.source_key}.state`), "synthetic tamper");
      if (mutation === "backup-tamper") writeFileSync(join(f.backup, PORTABLE_LOCAL_STREAM), "synthetic tamper");
      if (mutation === "open-transaction") db.exec("BEGIN");
    } })).toThrow();
    expect(called).toBe(true); expect(existsSync(f.target)).toBe(false);
    expect(readdirSync(f.root).some(name => name.includes(".partial"))).toBe(false);
  });
}

test("adapter inventory is copied once; accessor, duplicate and sparse inventories refuse before callbacks", async () => {
  const f = await fixture(); let calls = 0;
  for (const ids of [["fixture", "fixture"], new Array(2), Array.from({ length: 65 }, (_, i) => `fixture${i}`)]) {
    expect(() => exportVault(f.db, f.vault, f.backup, { portableLocal: { connector_ids: ids, decode() { calls++; return { path: "/tmp" }; }, encode: adapter.encode } })).toThrow();
  }
  const metadata = { ...adapter };
  Object.defineProperty(metadata, "connector_ids", { get() { calls++; return ["fixture"]; } });
  expect(() => exportVault(f.db, f.vault, f.backup, { portableLocal: metadata })).toThrow();
  expect(calls).toBe(0); expect(existsSync(f.backup)).toBe(false);
  const ids = ["fixture"], mutable = { ...adapter, connector_ids: ids };
  expect(exportVault(f.db, f.vault, f.backup, { portableLocal: mutable, onProgress() { ids.splice(0); } }).files[PORTABLE_LOCAL_STREAM]?.count).toBe(1);
});


test("missing grant never reads malformed/symlink state or invokes codec; no private path is exported", async () => {
  const f = await fixture({ grant: false });
  const unknown = join(f.root, "synthetic-private-canary");
  writeFileSync(unknown, "synthetic_unapproved_private_config", { mode: 0o600 });
  unlinkSync(f.statePath); symlinkSync(unknown, f.statePath);
  let calls = 0;
  const manifest = exportVault(f.db, f.vault, f.backup, { portableLocal: { ...adapter, decode() { calls++; throw new Error("must not decode"); } } });
  expect(calls).toBe(0); expect(manifest.files[PORTABLE_LOCAL_STREAM]?.count).toBe(0);
  expect(readFileSync(join(f.backup, PORTABLE_LOCAL_STREAM), "utf8")).toBe("");
  expect(JSON.stringify(rows(f.backup, "connections.jsonl"))).not.toContain("synthetic-source");
});

test("a captured active grant without export still refuses the entire export before state read", async () => {
  const f = await fixture();
  setSourceGrant(f.db, { source_key: f.connection.source_key, expected_revision: 1, operation_id: "remove-export", policy: { ...policy, purposes: ["capture"] } });
  let calls = 0;
  expect(() => exportVault(f.db, f.vault, f.backup, { portableLocal: { ...adapter, decode() { calls++; throw new Error("must not decode"); } } })).toThrow("source_export_denied");
  expect(calls).toBe(0); expect(existsSync(f.backup)).toBe(false);
});


test("excluded credential connector state is never read or decoded", async () => {
  const f = await fixture(); unlinkSync(f.statePath); symlinkSync("/does-not-exist", f.statePath);
  let calls = 0;
  const manifest = exportVault(f.db, f.vault, f.backup, { portableLocal: { ...adapter, connector_ids: [], decode() { calls++; throw new Error("must not decode"); } } });
  expect(calls).toBe(0); expect(manifest.files[PORTABLE_LOCAL_STREAM]?.count).toBe(0);
  expect(Object.keys(manifest.files).some(path => path.endsWith(".state"))).toBe(false);
});

test("source state changed after capture prevents publication", async () => {
  const f = await fixture(); let changed = false;
  expect(() => exportVault(f.db, f.vault, f.backup, { ...f.options, onProgress(phase) {
    if (phase === "ledger") { changed = true; writeFileSync(f.statePath, adapter.encode("fixture", { path: join(f.root, "changed-source") })); }
  } })).toThrow();
  expect(changed).toBe(true); expect(existsSync(f.backup)).toBe(false);
});

test("rehashed duplicate keys in the new versioned stream fail even when JSON would normalize them", async () => {
  const f = await fixture(); exportVault(f.db, f.vault, f.backup, f.options);
  const path = join(f.backup, PORTABLE_LOCAL_STREAM), original = readFileSync(path, "utf8");
  const bytes = original.replace('{"connector_id":', '{"path":"/synthetic-discarded-duplicate","connector_id":');
  writeFileSync(path, bytes);
  const manifest = JSON.parse(readFileSync(join(f.backup, "manifest.json"), "utf8")) as ExportManifest;
  manifest.files[PORTABLE_LOCAL_STREAM] = { count: 1, size: Buffer.byteLength(bytes), mode: 0o600, sha256: sha256Hex(bytes) };
  const { manifest_sha256: _hash, ...unsigned } = manifest;
  writeFileSync(join(f.backup, "manifest.json"), JSON.stringify({ ...unsigned, manifest_sha256: sha256Hex(`${JSON.stringify(unsigned, null, 2)}\n`) }));
  expect(() => verifyBackup(f.backup, f.options)).toThrow("portable_local_invalid");
  expect(() => restoreVault(f.backup, f.target, f.options)).toThrow("portable_local_invalid");
  expect(existsSync(f.target)).toBe(false);
});

for (const hostAdapter of [false, true]) {
  test(`portable path without captured export permission refuses restore (adapter=${hostAdapter})`, async () => {
    const f = await fixture(); exportVault(f.db, f.vault, f.backup, f.options);
    // Use Core's actual policy mutation to supply internally consistent, current
    // grant rows/receipts. Only the portable path is incompatible with that cut.
    setSourceGrant(f.db, { source_key: f.connection.source_key, expected_revision: 1,
      operation_id: "capture-without-export", policy: { ...policy, purposes: ["capture"] } });
    rewritten(f.backup, "ledger/source_grants.jsonl", f.db.query("SELECT * FROM source_grants ORDER BY source_key").all());
    rewritten(f.backup, "ledger/source_grant_receipts.jsonl", f.db.query("SELECT * FROM source_grant_receipts ORDER BY sequence").all());
    let codecCalls = 0;
    const options = hostAdapter ? { portableLocal: { ...adapter, encode(id: string, config: { readonly path: string }) { codecCalls++; return adapter.encode(id, config); } } } : {};
    expect(() => verifyBackup(f.backup, options)).toThrow("portable_local_invalid");
    expect(() => restoreVault(f.backup, f.target, options)).toThrow("portable_local_invalid");
    expect(codecCalls).toBe(0); expect(existsSync(f.target)).toBe(false);
  });
}


for (const mutation of ["missing", "duplicate", "wrong-connector", "inactive"] as const) {
  test(`portable verification refuses ${mutation} captured grant even without adapter`, async () => {
    const f = await fixture(); exportVault(f.db, f.vault, f.backup, f.options);
    const [grant] = rows(f.backup, "ledger/source_grants.jsonl");
    if (mutation === "wrong-connector") grant!.connector_id = "another";
    if (mutation === "inactive") grant!.status = "purged";
    rewritten(f.backup, "ledger/source_grants.jsonl", mutation === "missing" ? [] : mutation === "duplicate" ? [grant, grant] : [grant]);
    expect(() => verifyBackup(f.backup)).toThrow("portable_local_invalid");
    expect(() => restoreVault(f.backup, f.target)).toThrow("portable_local_invalid");
    expect(existsSync(f.target)).toBe(false);
  });
}
