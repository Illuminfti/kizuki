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
