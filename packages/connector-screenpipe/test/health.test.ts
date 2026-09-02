import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { HealthReport } from "@kizuki/core";
import {
  FIXTURE_NOW,
  SCREENPIPE_SCHEMA_FLOOR,
  SCREENPIPE_SCHEMA_VERIFIED,
  ScreenpipeConnector,
  ScreenpipeConnectorError,
  createScreenpipeConnector,
  parseConfig,
} from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

describe("ScreenpipeConnector health and lifecycle", () => {
  test("manifest declares the exact read-only capabilities", () => {
    expect(
      createScreenpipeConnector({ path: "/tmp/not-opened.sqlite" }).manifest(),
    ).toEqual({
      schema: "kizuki.connector/v1",
      connector_id: "kizuki.screenpipe",
      version: "0.1.0",
      kinds: ["screen_text", "audio_transcription"],
      capabilities: {
        backfill: true,
        sync: true,
        tombstones: false,
        purge: true,
        fixture: true,
      },
      required_secrets: [],
      emits_sensitivity_hint: true,
      auth_modes: ["none"],
      default_sensitivity: "private",
      sensitivity_floor: "personal",
    });
  });

  test("config resolves a relative path and applies defaults", () => {
    expect(parseConfig({ path: "screenpipe/db.sqlite" })).toEqual({
      path: path.resolve("screenpipe/db.sqlite"),
      since: null,
      settle_seconds: 300,
    });
  });

  test("config rejects unknown keys and malformed values", () => {
    const invalid: unknown[] = [
      null,
      {},
      { path: "" },
      { path: "/tmp/db.sqlite", extra: true },
      { path: "/tmp/db.sqlite", since: "2026-01-01" },
      { path: "/tmp/db.sqlite", settle_seconds: -1 },
      { path: "/tmp/db.sqlite", settle_seconds: 86_401 },
      { path: "/tmp/db.sqlite", settle_seconds: 1.5 },
    ];
    for (const config of invalid) {
      try {
        parseConfig(config);
        throw new Error("expected config to be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(ScreenpipeConnectorError);
        if (error instanceof ScreenpipeConnectorError) {
          expect(error.code).toBe("misconfigured");
        }
      }
    }
  });

  test("a verified database is healthy and every report is a HealthReport", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps(FIXTURE_NOW),
    );

    const health = await connector.health();

    expect(health).toBeInstanceOf(HealthReport);
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `screenpipe schema verified (max migration ${SCREENPIPE_SCHEMA_VERIFIED})`,
    );
    expect(health.last_success_at).toBeUndefined();
    await connector.revoke();
  });

  test("missing files and old schemas are misconfigured", async () => {
    const oldFixture = createFixtureDatabase({
      migrations: [20260312000000],
      rows: false,
    });
    const missing = new ScreenpipeConnector(
      { path: path.join(oldFixture.dir, "missing.sqlite") },
      fixtureDeps(FIXTURE_NOW),
    );
    const old = new ScreenpipeConnector(
      { path: oldFixture.path },
      fixtureDeps(FIXTURE_NOW),
    );

    expect((await missing.health()).state).toBe("misconfigured");
    const oldHealth = await old.health();
    expect(oldHealth.state).toBe("misconfigured");
    expect(oldHealth.detail).toContain(
      `migration ${SCREENPIPE_SCHEMA_FLOOR} not applied`,
    );
    await missing.revoke();
    await old.revoke();
  });

  test("a locked database is unreachable", async () => {
    const fixture = createFixtureDatabase();
    fixture.writer.exec("BEGIN EXCLUSIVE");
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      {
        now: () => Date.parse(FIXTURE_NOW),
        open: (databasePath) => {
          const db = new Database(databasePath, {
            readonly: true,
            create: false,
            safeIntegers: true,
          });
          db.exec("PRAGMA query_only = 1");
          db.exec("PRAGMA busy_timeout = 50");
          return db;
        },
      },
    );

    const health = await connector.health();

    expect(health).toBeInstanceOf(HealthReport);
    expect(health.state).toBe("unreachable");
    expect(health.detail).toBe("screenpipe database is locked; retry");
    fixture.writer.exec("ROLLBACK");
    await connector.revoke();
  });

  test("the last successful batch and skip deltas appear in health", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps(FIXTURE_NOW),
    );
    await connector.backfill(null);

    const health = await connector.health();

    expect(health.state).toBe("ok");
    expect(health.last_success_at).toBe(FIXTURE_NOW);
    expect(health.detail).toBe(
      `screenpipe schema verified (max migration ${SCREENPIPE_SCHEMA_VERIFIED}); skipped 2 without text, 1 unparsable timestamps`,
    );
    await connector.revoke();
  });

  test("revoke disables health and closes every data operation", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps(FIXTURE_NOW),
    );
    await connector.connect(async () => {
      throw new Error("the resolver must not be called");
    });
    await connector.revoke();

    const health = await connector.health();
    expect(health).toBeInstanceOf(HealthReport);
    expect(health.state).toBe("disabled");
    expect(health.detail).toBe("revoked");
    await expect(connector.backfill(null)).rejects.toMatchObject({
      code: "closed",
      message:
        "kizuki.screenpipe: connector was revoked; build a new instance",
    });
    await expect(connector.sync(null)).rejects.toBeInstanceOf(
      ScreenpipeConnectorError,
    );
    await expect(
      connector.purgeSource("screenpipe:app:acme-mail"),
    ).rejects.toBeInstanceOf(ScreenpipeConnectorError);
  });
});
