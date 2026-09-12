import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "../helpers";
import { LEDGER_SCHEMA_VERSION } from "../../../core/src/ledger/db";
import { parseSqliteRuntime } from "@kizuki/core/internal";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

test("doctor JSON accepts a genuine migrated v1 event without hiding unrelated health failures", () => {
  const setup = tempVault(), ledgerPath = join(setup.vault, ".kizuki/kizuki.db");
  const oldPath = join(setup.root, "legacy.sqlite"), old = new Database(oldPath);
  try {
    old.exec(readFileSync(join(import.meta.dir, "../../../core/test/fixtures/doctor-ledger15-legacy.sql"), "utf8"));
    expect(old.query("SELECT version FROM schema_version").get()).toEqual({ version: 15 });
  } finally { old.close(true); }
  expect(existsSync(`${ledgerPath}-wal`)).toBe(false);
  expect(existsSync(`${ledgerPath}-shm`)).toBe(false);
  renameSync(oldPath, ledgerPath);
  chmodSync(ledgerPath, 0o600);
  // The release-upgrade fixture has accepted evidence, so its readiness mark
  // is positive. Explicit init must still be able to migrate it.
  writeFileSync(join(setup.vault, ".kizuki", "ledger-mark"), "1\n", { mode: 0o600 });
  const refused = runCli(setup.env, "doctor", "--json", "--integrity");
  expect(refused.exitCode).toBe(1); expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain("migration_required");
  // Migration is an explicit initialization effect, never doctor startup.
  const beforeRejectedLedger = readFileSync(ledgerPath);
  writeFileSync(join(setup.vault, ".kizuki", "ledger-mark"), "2\n", { mode: 0o600 });
  const incomplete = runCli(setup.env, "init", setup.vault, "--no-service");
  expect(incomplete.exitCode).toBe(1); expect(incomplete.stderr).toContain("vault ledger not ready");
  expect(readFileSync(ledgerPath)).toEqual(beforeRejectedLedger);
  expect(readFileSync(join(setup.vault, ".kizuki", "ledger-mark"), "utf8")).toBe("2\n");
  writeFileSync(join(setup.vault, ".kizuki", "ledger-mark"), "1\n", { mode: 0o600 });
  expect(runCli(setup.env, "init", setup.vault, "--no-service").exitCode).toBe(0);


  const result = runCli(setup.env, "doctor", "--json", "--integrity");
  expect(result.stderr).toBe("");
  const envelope = JSON.parse(result.stdout);
  expect(parseSqliteRuntime(envelope.data.runtime)).toMatchObject({
    schema: "kizuki.sqlite-runtime/v1", bun_version: Bun.version,
  });
  expect(envelope.data.ledger).toEqual({
    ok: true, schema_version: LEDGER_SCHEMA_VERSION, quick_check: "ok",
    integrity_check: "ok", sampled_events: 1, failures: [],
  });
  // The historical synthetic connector has no installed configuration. Keep
  // that separate health failure; a valid ledger does not make the vault ready.
  expect(result.exitCode).toBe(1);
  expect(envelope.status).toBe("error");
  expect(envelope.data.ok).toBe(false);
  expect(envelope.data.connections.some((connection: { health: string }) => connection.health !== "ok")).toBe(true);
  expect(result.stdout).not.toContain("Neutral synthetic compatibility event.");
});

test("init migrates a sealed historical event and purge when its acceptance floor matches", () => {
  const setup = tempVault(), ledgerPath = join(setup.vault, ".kizuki/kizuki.db");
  const oldPath = join(setup.root, "legacy-purge.sqlite"), old = new Database(oldPath);
  try {
    old.exec(readFileSync(join(import.meta.dir, "../../../core/test/fixtures/doctor-ledger15-legacy.sql"), "utf8"));
    const eventId = old.query<{ event_id: string }, []>("SELECT event_id FROM events LIMIT 1").get()?.event_id;
    if (eventId === undefined) throw new Error("legacy fixture event missing");
    old.query(
      "INSERT INTO event_purges(receipt_id,event_id,connector_id,reason,purged_at) VALUES(?,?,?,?,?)",
    ).run("legacy-purge-receipt", eventId, "fixture", "historical purge", "2026-09-01T00:00:00.000Z");
  } finally { old.close(true); }
  renameSync(oldPath, ledgerPath); chmodSync(ledgerPath, 0o600);
  writeFileSync(join(setup.vault, ".kizuki", "ledger-mark"), "2\n", { mode: 0o600 });
  expect(runCli(setup.env, "init", setup.vault, "--no-service").exitCode).toBe(0);
  const migrated = new Database(ledgerPath, { readonly: true });
  try {
    expect(migrated.query("SELECT version FROM schema_version").get()).toEqual({ version: LEDGER_SCHEMA_VERSION });
    expect(migrated.query("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });
    expect(migrated.query("SELECT COUNT(*) AS count FROM event_purges").get()).toEqual({ count: 1 });
  } finally { migrated.close(true); }
});
