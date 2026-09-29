import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { getCheckpoint, listConnections } from "@kizuki/core";
import { openLedger } from "@kizuki/core/internal";
import { createHelpers, fixtureConsent } from "../helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const helpers = createHelpers();
afterEach(helpers.cleanup);

function withLedger<T>(vault: string, fn: (db: ReturnType<typeof openLedger>) => T): T {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function checkpointFields(vault: string) {
  return withLedger(vault, (db) => {
    const connection = listConnections(db)[0];
    expect(connection).toBeDefined();
    const checkpoint = getCheckpoint(db, connection!.connector_id, connection!.source_key);
    expect(checkpoint).not.toBeNull();
    return {
      backfill_complete: checkpoint!.backfill_complete,
      backfill_cursor: checkpoint!.backfill_cursor,
      sync_cursor: checkpoint!.sync_cursor,
    };
  });
}

function markBackfillComplete(vault: string) {
  withLedger(vault, (db) => {
    db.query("UPDATE checkpoints SET backfill_complete = 1").run();
  });
}

function doctorConnection(env: Record<string, string | undefined>, flag?: "--json") {
  const result = flag === undefined
    ? helpers.runCli(env, "doctor")
    : helpers.runCli(env, "doctor", "--json");
  if (flag === "--json") {
    const report = JSON.parse(result.stdout) as {
      data: { connections: { backfill_complete: boolean; last_run_clean: boolean }[] };
    };
    expect(report.data.connections).toHaveLength(1);
    return report.data.connections[0]!;
  }
  const match = result.stdout.match(/last_run_clean=(yes|no)/);
  expect(match).not.toBeNull();
  expect(result.stdout).not.toContain("backfill_complete=");
  return match![1] === "yes";
}

test("doctor says a clean sync-only source had a clean last run, and keeps backfill completion as its own fact", () => {
  const setup = helpers.tempVault();
  const connected = helpers.runCli(setup.env, "connect", "markdown-folder", "--source", setup.notes);
  expect(connected.exitCode, connected.stderr).toBe(0);
  const key = connected.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)?.[1];
  expect(key).toBeDefined();
  const granted = helpers.runCli(
    setup.env,
    "connect",
    "grant",
    "--source",
    key!,
    ...fixtureConsent(setup.root),
  );
  expect(granted.exitCode, granted.stderr).toBe(0);

  // Never run: not clean.
  expect(doctorConnection(setup.env, "--json")).toMatchObject({ backfill_complete: false, last_run_clean: false });

  // Only ever synced, and clean: no backfill ever ran, and the last run recorded no error.
  const synced = helpers.runCli(setup.env, "sync", "markdown-folder");
  expect(synced.exitCode, synced.stderr).toBe(0);
  expect(checkpointFields(setup.vault).backfill_complete).toBe(false);
  expect(doctorConnection(setup.env)).toBe(true);
  expect(doctorConnection(setup.env, "--json")).toMatchObject({ backfill_complete: false, last_run_clean: true });
  const afterSync = checkpointFields(setup.vault);
  expect(doctorConnection(setup.env, "--json")).toMatchObject({ backfill_complete: false, last_run_clean: true });
  expect(checkpointFields(setup.vault)).toEqual(afterSync);

  // A completed backfill is still reported, and a failed run is not clean.
  markBackfillComplete(setup.vault);
  expect(doctorConnection(setup.env, "--json")).toMatchObject({ backfill_complete: true, last_run_clean: true });
  chmodSync(setup.notes, 0);
  const failed = helpers.runCli(setup.env, "sync", "markdown-folder");
  chmodSync(setup.notes, 0o700);
  expect(failed.exitCode).not.toBe(0);
  expect(checkpointFields(setup.vault).backfill_complete).toBe(true);
  expect(doctorConnection(setup.env)).toBe(false);
  expect(doctorConnection(setup.env, "--json")).toMatchObject({ backfill_complete: true, last_run_clean: false });
}, 120_000);
