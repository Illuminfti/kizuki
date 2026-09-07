import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { disconnectConnection, inspectConnectionDisconnect, resumeConnectionDisconnect } from "../src/ledger/disconnect";
import { ConnectionStateStore } from "../src/ledger/connection-state";
import { enrollConnection } from "../src/ledger/enroll";
import { getConnection } from "../src/ledger/connections";
import { openLedger } from "../src/ledger/db";
import { exportVault, restoreVault, verifyBackup } from "../src/export";
import { initVault } from "../src/vault/init";
import { sha256Hex } from "../src/util/hash";
import { DISCONNECT_RECEIPT_STREAM } from "../src/ledger/connection-disconnect-schema";
import { connector, enrolled, io as signInIo, temporaryDirectories } from "./connections-helpers";

const dirs = temporaryDirectories("kizuki-disconnect-lifecycle-");
afterEach(dirs.cleanup);
const provider = (revoke: () => Promise<void>) => ({ ...connector(async () => ({ display: "synthetic" })), revoke });

test("local denial and started audit precede provider revocation, while lease excludes replacement", async () => {
  const control = dirs.temporary(), f = await enrolled(control, "synthetic credential");
  try {
    let calls = 0;
    const result = await disconnectConnection(f, provider(async () => {
      calls++;
      expect(getConnection(f.db, "fixture", f.connection.source_key)?.disconnected_at).not.toBeNull();
      expect(f.db.query("SELECT phase FROM connection_disconnect_receipts").all()).toEqual([{ phase: "started" }]);
      expect(() => new ConnectionStateStore(control).begin()).toThrow("locked");
    }), f.connection);
    expect(result.status).toBe("completed");
    expect(calls).toBe(1);
    expect(inspectConnectionDisconnect(f.db, result.operation_id)).toEqual(result);
    expect(f.db.query("SELECT phase FROM connection_disconnect_receipts ORDER BY sequence").all()).toEqual([{ phase: "started" }, { phase: "revoked" }]);
    expect(() => f.db.exec("DELETE FROM connection_disconnect_receipts")).toThrow("append-only");
    expect(() => f.db.exec("UPDATE connection_disconnect_receipts SET at='changed'")).toThrow("append-only");
    await expect(disconnectConnection(f, provider(async () => { calls++; }), f.connection)).rejects.toThrow("already_disconnected");
    await expect(resumeConnectionDisconnect(f, provider(async () => { calls++; }), result.operation_id)).rejects.toThrow("already_completed");
    expect(calls).toBe(1);
  } finally { f.db.close(); }
});

test("provider failure stays locally disconnected, redacts detail and can explicitly resume after reopen", async () => {
  const control = dirs.temporary(), f = await enrolled(control, "synthetic credential");
  const result = await disconnectConnection(f, provider(async () => { throw new Error("SYNTHETIC_PRIVATE_PROVIDER_BYTES"); }), f.connection);
  expect(result).toMatchObject({ status: "provider_pending", diagnostic: "provider_revoke_failed" });
  expect(JSON.stringify(f.db.query("SELECT * FROM connection_disconnect_receipts").all())).not.toContain("SYNTHETIC_PRIVATE_PROVIDER_BYTES");
  f.db.close();
  const db = openLedger(join(control, "ledger.sqlite"));
  try {
    const resumed = await resumeConnectionDisconnect({ db, store: new ConnectionStateStore(control) }, provider(async () => {}), result.operation_id);
    expect(resumed).toMatchObject({ status: "completed", disconnected_at: result.disconnected_at, operation_id: result.operation_id });
    expect(getConnection(db, "fixture", f.connection.source_key)?.disconnected_at).toBe(result.disconnected_at);
    expect(db.query("SELECT phase FROM connection_disconnect_receipts ORDER BY sequence").all()).toEqual([
      { phase: "started" }, { phase: "revoke_failed" }, { phase: "started" }, { phase: "revoked" },
    ]);
  } finally { db.close(); }
});

test("unknown, mismatched and reenrolled identities never invoke the provider", async () => {
  const f = await enrolled(dirs.temporary(), "synthetic credential");
  try {
    let calls = 0; const impl = provider(async () => { calls++; });
    await expect(disconnectConnection(f, impl, { ...f.connection, source_key: "01JJ0000000000000000000001" })).rejects.toThrow("unknown_connection");
    await expect(disconnectConnection(f, { ...impl, manifest: () => ({ ...impl.manifest(), connector_id: "other" }) }, f.connection)).rejects.toThrow("enrollment_changed");
    expect(calls).toBe(0);
    const result = await disconnectConnection(f, provider(async () => { throw Error("synthetic"); }), f.connection);
    f.db.query("UPDATE connections SET connected_at=?,disconnected_at=NULL WHERE source_key=?").run("2026-01-01T00:00:00Z", f.connection.source_key);
    await expect(resumeConnectionDisconnect(f, impl, result.operation_id)).rejects.toThrow("enrollment_changed");
    expect(calls).toBe(0);
  } finally { f.db.close(); }
});

test("an audit insertion failure rolls back local disconnect before provider access", async () => {
  const f = await enrolled(dirs.temporary(), "synthetic credential");
  try {
    f.db.exec("CREATE TRIGGER fail_disconnect_audit BEFORE INSERT ON connection_disconnect_receipts BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
    let calls = 0;
    await expect(disconnectConnection(f, provider(async () => { calls++; }), f.connection)).rejects.toThrow("synthetic audit failure");
    expect(calls).toBe(0);
    expect(getConnection(f.db, "fixture", f.connection.source_key)).toEqual(f.connection);
  } finally { f.db.close(); }
});

test("a suppressed started receipt rolls back and never calls the provider", async () => {
  const f = await enrolled(dirs.temporary(), "synthetic credential");
  try {
    f.db.exec("CREATE TRIGGER ignore_disconnect_start BEFORE INSERT ON connection_disconnect_receipts BEGIN SELECT RAISE(IGNORE); END");
    let calls = 0;
    await expect(disconnectConnection(f, provider(async () => { calls++; }), f.connection)).rejects.toThrow("disconnect_audit_unavailable");
    expect(calls).toBe(0);
    expect(getConnection(f.db, "fixture", f.connection.source_key)).toEqual(f.connection);
  } finally { f.db.close(); }
});

test("a suppressed completion remains pending instead of claiming provider completion", async () => {
  const f = await enrolled(dirs.temporary(), "synthetic credential");
  try {
    f.db.exec("CREATE TRIGGER ignore_disconnect_completion BEFORE INSERT ON connection_disconnect_receipts WHEN NEW.phase='revoked' BEGIN SELECT RAISE(IGNORE); END");
    const result = await disconnectConnection(f, provider(async () => {}), f.connection);
    expect(result).toMatchObject({ status: "provider_pending", diagnostic: "disconnect_audit_unavailable" });
    expect(inspectConnectionDisconnect(f.db, result.operation_id)?.status).toBe("provider_pending");
    expect(f.db.query("SELECT phase FROM connection_disconnect_receipts").all()).toEqual([{ phase: "started" }]);
  } finally { f.db.close(); }
});

test("a different control-root lease cannot authorize disconnecting this database", async () => {
  const f = await enrolled(dirs.temporary(), "synthetic credential");
  try {
    let calls = 0;
    await expect(disconnectConnection({ db: f.db, store: new ConnectionStateStore(dirs.temporary()) }, provider(async () => { calls++; }), f.connection)).rejects.toThrow("disconnect_database_mismatch");
    expect(calls).toBe(0);
    expect(getConnection(f.db, "fixture", f.connection.source_key)).toEqual(f.connection);
  } finally { f.db.close(); }
});

test("a vanished database refuses before provider access without exposing the private path", async () => {
  const control = dirs.temporary(), f = await enrolled(control, "synthetic credential");
  try {
    renameSync(join(control, "ledger.sqlite"), join(control, "moved.sqlite"));
    let calls = 0;
    let failure: unknown;
    try { await disconnectConnection(f, provider(async () => { calls++; }), f.connection); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("disconnect_database_mismatch");
    expect(calls).toBe(0);
    expect(getConnection(f.db, "fixture", f.connection.source_key)).toEqual(f.connection);
  } finally { f.db.close(); }
});

test("a manifest callback cannot displace the database before disconnect and provider access", async () => {
  const control = dirs.temporary(), f = await enrolled(control, "synthetic credential");
  try {
    let calls = 0;
    const impl = provider(async () => { calls++; });
    await expect(disconnectConnection(f, { ...impl, manifest: () => {
      renameSync(join(control, "ledger.sqlite"), join(control, "displaced.sqlite"));
      return impl.manifest();
    } }, f.connection)).rejects.toThrow("disconnect_database_mismatch");
    expect(calls).toBe(0);
    expect(getConnection(f.db, "fixture", f.connection.source_key)).toEqual(f.connection);
  } finally { f.db.close(); }
});

test("a lost completion audit returns pending and preserves a resumable started receipt", async () => {
  const f = await enrolled(dirs.temporary(), "synthetic credential");
  try {
    const result = await disconnectConnection(f, provider(async () => {
      f.db.exec("CREATE TRIGGER fail_disconnect_completion BEFORE INSERT ON connection_disconnect_receipts WHEN NEW.phase='revoked' BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END");
    }), f.connection);
    expect(result).toMatchObject({ status: "provider_pending", diagnostic: "disconnect_audit_unavailable" });
    expect(inspectConnectionDisconnect(f.db, result.operation_id)?.status).toBe("provider_pending");
    f.db.exec("DROP TRIGGER fail_disconnect_completion");
    expect((await resumeConnectionDisconnect(f, provider(async () => {}), result.operation_id)).status).toBe("completed");
  } finally { f.db.close(); }
});

test("a killed provider process leaves durable pending history and releases the native lease", async () => {
  const control = dirs.temporary(), f = await enrolled(control, "synthetic credential");
  const child = Bun.spawn([process.execPath, "-e", `
    import { openLedger } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/db.ts"))};
    import { ConnectionStateStore } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/connection-state.ts"))};
    import { getConnection } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/connections.ts"))};
    import { disconnectConnection } from ${JSON.stringify(join(import.meta.dir, "../src/ledger/disconnect.ts"))};
    import { connector } from ${JSON.stringify(join(import.meta.dir, "connections-helpers.ts"))};
    const db=openLedger(${JSON.stringify(join(control, "ledger.sqlite"))});
    const impl={...connector(async()=>({display:'synthetic'})),revoke:async()=>{process.stdout.write('started\\n');await new Promise(()=>{});}};
    await disconnectConnection({db,store:new ConnectionStateStore(${JSON.stringify(control)})},impl,getConnection(db,'fixture',${JSON.stringify(f.connection.source_key)}));
  `], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("started");
    reader.releaseLock();
    child.kill("SIGKILL"); await child.exited;
    const receipt = f.db.query<{ operation_id: string }, []>("SELECT operation_id FROM connection_disconnect_receipts").get()!;
    expect(inspectConnectionDisconnect(f.db, receipt.operation_id)?.status).toBe("provider_pending");
    expect((await resumeConnectionDisconnect(f, provider(async () => {}), receipt.operation_id)).status).toBe("completed");
  } finally { child.kill("SIGKILL"); await child.exited; f.db.close(); }
});

for (const completed of [false, true]) {
  test(`export and restore preserve ${completed ? "complete" : "pending"} disconnect history without restoring credentials`, async () => {
    const root = dirs.temporary(), vault = join(root, "vault"); initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db")), store = new ConnectionStateStore(join(vault, ".kizuki"));
    const connection = await enrollConnection(db, store, connector(async (_io, writer) => {
      await writer.write(new TextEncoder().encode("synthetic credential")); return { display: "synthetic" };
    }), signInIo);
    const f = { db, store, connection };
    try {
      const result = await disconnectConnection(f, provider(async () => { if (!completed) throw Error("synthetic"); }), f.connection);
      const rows = f.db.query("SELECT * FROM connection_disconnect_receipts ORDER BY sequence").all();
      const backup = join(root, "backup"), target = join(root, "restored");
      const manifest = exportVault(f.db, vault, backup);
      expect(manifest.schema_versions.ledger).toBe(22);
      expect(manifest.files[DISCONNECT_RECEIPT_STREAM]?.count).toBe(2);
      expect(readFileSync(join(backup, DISCONNECT_RECEIPT_STREAM), "utf8")).not.toContain("synthetic credential");
      expect(verifyBackup(backup)).toEqual(manifest);
      restoreVault(backup, target);
      const db = openLedger(join(target, ".kizuki", "kizuki.db"));
      try {
        expect(db.query("SELECT * FROM connection_disconnect_receipts ORDER BY sequence").all()).toEqual(rows);
        expect(inspectConnectionDisconnect(db, result.operation_id)).toEqual(result);
        await expect(resumeConnectionDisconnect({ db, store: new ConnectionStateStore(join(target, ".kizuki")) }, provider(async () => {}), result.operation_id)).rejects.toThrow(completed ? "already_completed" : "enrollment_changed");
      } finally { db.close(); }
      // Removing even an empty required history stream must not silently turn
      // current history into an older backup. Re-sign the synthetic manifest.
      const { manifest_sha256: _hash, ...unsigned } = manifest;
      const files = { ...unsigned.files }; delete files[DISCONNECT_RECEIPT_STREAM];
      const modified = { ...unsigned, files };
      writeFileSync(join(backup, "manifest.json"), `${JSON.stringify({ ...modified, manifest_sha256: sha256Hex(`${JSON.stringify(modified, null, 2)}\n`) }, null, 2)}\n`);
      const refused = join(root, "missing-history-target");
      expect(() => restoreVault(backup, refused)).toThrow("disconnect receipt stream is missing");
      expect(existsSync(refused)).toBe(false);
    } finally { f.db.close(); }
  });
}
