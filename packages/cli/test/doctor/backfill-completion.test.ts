import { afterEach, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { getCheckpoint, listConnections } from "@kizuki/core";
import { openLedger } from "@kizuki/core/internal";
import { createHelpers, fixtureConsent } from "../helpers";

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
      data: { connections: { backfill_complete: boolean }[] };
    };
    expect(report.data.connections).toHaveLength(1);
    return report.data.connections[0]!.backfill_complete;
  }
  const match = result.stdout.match(/backfill_complete=(yes|no)/);
  expect(match).not.toBeNull();
  return match![1] === "yes";
}

test("doctor reports persisted backfill completion, not last-run mode", () => {
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

  const synced = helpers.runCli(setup.env, "sync", "markdown-folder");
  expect(synced.exitCode, synced.stderr).toBe(0);
  expect(checkpointFields(setup.vault).backfill_complete).toBe(false);
  expect(doctorConnection(setup.env)).toBe(false);
  expect(doctorConnection(setup.env, "--json")).toBe(false);
  const afterIncomplete = checkpointFields(setup.vault);
  expect(afterIncomplete.backfill_complete).toBe(false);
  expect(doctorConnection(setup.env, "--json")).toBe(false);
  expect(checkpointFields(setup.vault)).toEqual(afterIncomplete);

  markBackfillComplete(setup.vault);
  expect(checkpointFields(setup.vault).backfill_complete).toBe(true);
  expect(doctorConnection(setup.env)).toBe(true);
  expect(doctorConnection(setup.env, "--json")).toBe(true);
  const afterComplete = checkpointFields(setup.vault);
  expect(afterComplete.backfill_complete).toBe(true);
  expect(doctorConnection(setup.env, "--json")).toBe(true);
  expect(checkpointFields(setup.vault)).toEqual(afterComplete);

  chmodSync(setup.notes, 0);
  const failed = helpers.runCli(setup.env, "sync", "markdown-folder");
  chmodSync(setup.notes, 0o700);
  expect(failed.exitCode).not.toBe(0);
  expect(checkpointFields(setup.vault).backfill_complete).toBe(true);
  expect(doctorConnection(setup.env)).toBe(true);
  expect(doctorConnection(setup.env, "--json")).toBe(true);
  const afterFailure = checkpointFields(setup.vault);
  expect(afterFailure.backfill_complete).toBe(true);
  expect(doctorConnection(setup.env, "--json")).toBe(true);
  expect(checkpointFields(setup.vault)).toEqual(afterFailure);
});
