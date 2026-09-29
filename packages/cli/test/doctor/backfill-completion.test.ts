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
      data: { connections: { backfill_complete: boolean; caught_up: boolean }[] };
    };
    expect(report.data.connections).toHaveLength(1);
    return report.data.connections[0]!;
  }
  const match = result.stdout.match(/caught_up=(yes|no)/);
  expect(match).not.toBeNull();
  expect(result.stdout).not.toContain("backfill_complete=");
  return match![1] === "yes";
}

test("doctor says a caught-up sync-only source is caught up, and keeps backfill completion as its own fact", () => {
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

  // Never run: not caught up.
  expect(doctorConnection(setup.env, "--json")).toMatchObject({ backfill_complete: false, caught_up: false });

  // Only ever synced, and clean: no backfill ever ran, yet nothing is left to fetch.
  const synced = helpers.runCli(setup.env, "sync", "markdown-folder");
  expect(synced.exitCode, synced.stderr).toBe(0);
  expect(checkpointFields(setup.vault).backfill_complete).toBe(false);
  expect(doctorConnection(setup.env)).toBe(true);
  expect(doctorConnection(setup.env, "--json")).toMatchObject({ backfill_complete: false, caught_up: true });
  const afterSync = checkpointFields(setup.vault);
  expect(doctorConnection(setup.env, "--json")).toMatchObject({ backfill_complete: false, caught_up: true });
  expect(checkpointFields(setup.vault)).toEqual(afterSync);

  // A completed backfill is still reported, and a failed run is not caught up.
  markBackfillComplete(setup.vault);
  expect(doctorConnection(setup.env, "--json")).toMatchObject({ backfill_complete: true, caught_up: true });
  chmodSync(setup.notes, 0);
  const failed = helpers.runCli(setup.env, "sync", "markdown-folder");
  chmodSync(setup.notes, 0o700);
  expect(failed.exitCode).not.toBe(0);
  expect(checkpointFields(setup.vault).backfill_complete).toBe(true);
  expect(doctorConnection(setup.env)).toBe(false);
  expect(doctorConnection(setup.env, "--json")).toMatchObject({ backfill_complete: true, caught_up: false });
}, 120_000);
