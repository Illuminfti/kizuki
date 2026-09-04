import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  SCREENPIPE_SCHEMA_FLOOR,
  SCREENPIPE_SCHEMA_VERIFIED,
  assertSchema,
  inspectSchema,
} from "../src/schema";
import { createScreenpipeConnector } from "../src/connector";
import { ScreenpipeConnectorError } from "../src/errors";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

describe("screenpipe schema inspection", () => {
  test("the fixture schema is verified", () => {
    const fixture = createFixtureDatabase();

    expect(inspectSchema(fixture.writer)).toEqual({
      ok: true,
      migrations_table: true,
      floor_applied: true,
      max_migration: SCREENPIPE_SCHEMA_VERIFIED,
      newer_than_verified: false,
      missing: [],
      incompatible: [],
      missing_indexes: [],
      detail: `screenpipe schema verified (max migration ${SCREENPIPE_SCHEMA_VERIFIED})`,
    });
  });

  test("a database without _sqlx_migrations is not a screenpipe database", () => {
    const db = new Database(":memory:", { safeIntegers: true });
    db.exec("CREATE TABLE frames (id INTEGER)");

    const report = inspectSchema(db);

    expect(report.ok).toBe(false);
    expect(report.detail).toBe(
      "not a screenpipe database (no _sqlx_migrations table)",
    );
    expect(() => assertSchema(db)).toThrow(
      "not a screenpipe database (no _sqlx_migrations table)",
    );
    db.close();
  });

  test("a database below the floor is refused", () => {
    const fixture = createFixtureDatabase({
      migrations: [20240703111257, 20260312000000],
      rows: false,
    });

    const report = inspectSchema(fixture.writer);

    expect(report.ok).toBe(false);
    expect(report.floor_applied).toBe(false);
    expect(report.max_migration).toBe(20260312000000);
    expect(report.detail).toBe(
      `screenpipe schema older than supported: migration ${SCREENPIPE_SCHEMA_FLOOR} not applied (max 20260312000000); update screenpipe`,
    );
  });

  test("a missing required column fails closed", async () => {
    const fixture = createFixtureDatabase();
    fixture.writer.exec("ALTER TABLE frames DROP COLUMN full_text");
    fixture.writer.close();
    const connector = new (await import("../src/connector"))
      .ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const db = new Database(fixture.path, {
      readonly: true,
      create: false,
      safeIntegers: true,
    });
    expect(inspectSchema(db).missing).toContain("frames.full_text");
    db.close();
    await expect(
      connector.connect(async () => {
        throw new Error("no secrets");
      }),
    ).rejects.toMatchObject({ code: "schema_mismatch" });
    await expect(connector.backfill(null)).rejects.toMatchObject({
      code: "schema_mismatch",
    });
    expect((await connector.health()).state).toBe("misconfigured");
    await connector.revoke();
  });

  test("a newer migration is read and reported", async () => {
    const fixture = createFixtureDatabase({
      migrations: [
        20240703111257,
        SCREENPIPE_SCHEMA_FLOOR,
        SCREENPIPE_SCHEMA_VERIFIED,
        20260901000000,
      ],
    });
    fixture.writer.close();
    const connector = createScreenpipeConnector({
      path: fixture.path,
      settle_seconds: 0,
    });

    const db = new Database(fixture.path, {
      readonly: true,
      create: false,
      safeIntegers: true,
    });
    const report = inspectSchema(db);
    db.close();
    expect(report.ok).toBe(true);
    expect(report.newer_than_verified).toBe(true);
    expect(report.detail).toBe(
      `screenpipe schema newer than verified: max migration 20260901000000 > ${SCREENPIPE_SCHEMA_VERIFIED}; required columns present`,
    );
    const health = await connector.health();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(report.detail);
    await connector.revoke();
  });

  test("an unsafe migration version fails closed", () => {
    const fixture = createFixtureDatabase();
    fixture.writer
      .query(
        `INSERT INTO _sqlx_migrations
           (version, description, installed_on, success, checksum, execution_time)
         VALUES (?, 'future fixture', ?, 1, X'', 0)`,
      )
      .run(9_223_372_036_854_775_807n, "2026-09-02T00:00:00Z");

    const report = inspectSchema(fixture.writer);

    expect(report.ok).toBe(false);
    expect(report.max_migration).toBeNull();
    expect(report.detail).toBe(
      "screenpipe schema mismatch: invalid migration version",
    );
    expect(() => assertSchema(fixture.writer)).toThrow(
      "screenpipe schema mismatch: invalid migration version",
    );
  });

  test("incompatible column affinity fails closed", () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.exec("DROP INDEX idx_frames_timestamp");
    fixture.writer.exec("DROP INDEX idx_frames_app_name_timestamp");
    fixture.writer.exec("ALTER TABLE frames DROP COLUMN timestamp");
    fixture.writer.exec("ALTER TABLE frames ADD COLUMN timestamp TEXT NOT NULL DEFAULT ''");
    fixture.writer.exec("CREATE INDEX idx_frames_timestamp ON frames(timestamp)");

    const report = inspectSchema(fixture.writer);

    expect(report.ok).toBe(false);
    expect(report.incompatible).toContain(
      "frames.timestamp expected NUMERIC affinity",
    );
    expect(report.detail).toContain("frames.timestamp expected NUMERIC affinity");
  });

  test("a missing cursor index fails closed", () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.exec("DROP INDEX idx_frames_timestamp");

    const report = inspectSchema(fixture.writer);

    expect(report.ok).toBe(false);
    expect(report.missing_indexes).toEqual(["frames(timestamp)"]);
    expect(report.detail).toBe(
      "screenpipe schema mismatch: missing index frames(timestamp)",
    );
  });

  test("schema is re-checked on every batch", async () => {
    const fixture = createFixtureDatabase();
    const connector = createScreenpipeConnector({
      path: fixture.path,
      settle_seconds: 0,
    });
    const first = await connector.sync(null);
    fixture.writer.exec("ALTER TABLE frames DROP COLUMN full_text");

    try {
      await connector.sync(first.cursor);
      throw new Error("expected sync to reject the changed schema");
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenpipeConnectorError);
      if (!(error instanceof ScreenpipeConnectorError)) return;
      expect(error.code).toBe("schema_mismatch");
    } finally {
      await connector.revoke();
    }
    expect(first.cursor).not.toBeNull();
  });
});
