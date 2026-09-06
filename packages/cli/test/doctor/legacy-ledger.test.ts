import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "../helpers";
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

  const result = runCli(setup.env, "doctor", "--json", "--integrity");
  expect(result.stderr).toBe("");
  const envelope = JSON.parse(result.stdout);
  expect(parseSqliteRuntime(envelope.data.runtime)).toMatchObject({
    schema: "kizuki.sqlite-runtime/v1", bun_version: Bun.version,
  });
  expect(envelope.data.ledger).toEqual({
    ok: true, schema_version: 18, quick_check: "ok",
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
