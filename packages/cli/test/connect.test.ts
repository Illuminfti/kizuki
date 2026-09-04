import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listConnections, openLedger } from "@kizuki/core";
import { createHelpers } from "./helpers";

const { cleanup, runCli, tempVault, writeNotes } = createHelpers();
afterEach(cleanup);

describe("connect", () => {
  test("unknown connector lists known ids", () => {
    const setup = tempVault();
    const result = runCli(
      setup.env,
      "connect",
      "not-a-connector",
      "--source",
      setup.notes,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown connector: not-a-connector");
    expect(result.stderr).toContain("kizuki.markdown-folder");
  });

  test("missing directory persists nothing", () => {
    const setup = tempVault();
    const missing = join(setup.root, "missing-notes");
    const result = runCli(
      setup.env,
      "connect",
      "markdown-folder",
      "--source",
      missing,
    );
    expect(result.exitCode).toBe(1);
    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      expect(listConnections(db)).toEqual([]);
    } finally {
      db.close();
    }
    expect(readdirSync(join(setup.vault, ".kizuki", "connections"))).toEqual([]);
  });

  test("connect twice reuses the same source key", () => {
    const setup = tempVault();
    const first = runCli(
      setup.env,
      "connect",
      "markdown-folder",
      "--source",
      setup.notes,
    );
    expect(first.exitCode).toBe(0);
    const key = first.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)?.[1];
    expect(key).toBeDefined();

    const second = runCli(
      setup.env,
      "connect",
      "markdown-folder",
      "--source",
      setup.notes,
    );
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain(`source=${key}`);

    const db = openLedger(join(setup.vault, ".kizuki", "kizuki.db"));
    try {
      expect(listConnections(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("backfill --source KEY and --source path select the same connection", () => {
    const setup = tempVault();
    const connected = runCli(
      setup.env,
      "connect",
      "markdown-folder",
      "--source",
      setup.notes,
    );
    const key = connected.stdout.match(
      /source=([0-9A-HJKMNPQRSTVWXYZ]{26})/,
    )?.[1];
    expect(key).toBeDefined();

    const byKey = runCli(
      setup.env,
      "backfill",
      "markdown-folder",
      "--source",
      key ?? "",
    );
    expect(byKey.exitCode).toBe(0);
    expect(byKey.stdout).toContain("events_stored=3");

    const byPath = runCli(
      setup.env,
      "backfill",
      "markdown-folder",
      "--source",
      setup.notes,
    );
    expect(byPath.exitCode).toBe(0);
    // Same connection, same exhausted cursor: an unchanged folder is a
    // no-op. A second enrollment would have stored three new events.
    expect(byPath.stdout).toContain("events_stored=0");
    expect(byPath.stdout).toContain("duplicates=0");
  });

  test("two connections of one connector require --source", () => {
    const setup = tempVault();
    const extra = join(setup.root, "more-notes");
    writeNotes(extra);
    expect(
      runCli(setup.env, "connect", "markdown-folder", "--source", setup.notes)
        .exitCode,
    ).toBe(0);
    expect(
      runCli(setup.env, "connect", "markdown-folder", "--source", extra)
        .exitCode,
    ).toBe(0);
    const result = runCli(setup.env, "backfill", "markdown-folder");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("several connections");
  });

  test("garbage state fails closed and never stores the source path in SQLite", () => {
    const setup = tempVault();
    const connected = runCli(
      setup.env,
      "connect",
      "markdown-folder",
      "--source",
      setup.notes,
    );
    const key = connected.stdout.match(
      /source=([0-9A-HJKMNPQRSTVWXYZ]{26})/,
    )?.[1];
    expect(key).toBeDefined();
    const statePath = join(
      setup.vault,
      ".kizuki",
      "connections",
      `${key}.state`,
    );
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    writeFileSync(statePath, "not-json");

    const backfill = runCli(setup.env, "backfill", "markdown-folder");
    expect(backfill.exitCode).toBe(1);
    expect(backfill.stderr).toContain(`source=${key}`);

    const doctor = runCli(setup.env, "doctor");
    expect(doctor.exitCode).toBe(1);
    expect(doctor.stdout).toContain("state=missing");

    const dbBytes = readFileSync(join(setup.vault, ".kizuki", "kizuki.db"));
    expect(dbBytes.includes(Buffer.from(setup.notes))).toBe(false);
  });
});
