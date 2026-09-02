import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScreenpipeConnector } from "../src/connector";
import { openReadOnly } from "../src/open";
import { readFrames } from "../src/read";
import { ScreenpipeConnectorError } from "../src/errors";
import {
  cleanupFixtureDatabases,
  closeAndRemove,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
  insertTranscription,
} from "./helpers";

const looseDirectories = new Set<string>();

afterEach(() => {
  cleanupFixtureDatabases();
  for (const directory of looseDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  looseDirectories.clear();
});

describe("openReadOnly", () => {
  test("a missing file is misconfigured, not created", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "kizuki-screenpipe-"));
    looseDirectories.add(directory);
    const missing = path.join(directory, "missing.sqlite");

    expect(() => openReadOnly(missing)).toThrow(ScreenpipeConnectorError);
    try {
      openReadOnly(missing);
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenpipeConnectorError);
      if (error instanceof ScreenpipeConnectorError) {
        expect(error.code).toBe("misconfigured");
      }
    }
    expect(existsSync(missing)).toBe(false);
  });

  test("a non-database file is misconfigured", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "kizuki-screenpipe-"));
    looseDirectories.add(directory);
    const invalid = path.join(directory, "not.sqlite");
    writeFileSync(invalid, "plain text");

    try {
      openReadOnly(invalid);
      throw new Error("expected openReadOnly to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ScreenpipeConnectorError);
      if (!(error instanceof ScreenpipeConnectorError)) return;
      expect(error.code).toBe("misconfigured");
      expect(error.message).toContain("file is not a database");
    }
  });

  test("the handle refuses writes", () => {
    const fixture = createFixtureDatabase();
    fixture.writer.close();
    const db = openReadOnly(fixture.path);
    try {
      expect(() =>
        db.exec("INSERT INTO speakers (name) VALUES ('blocked')"),
      ).toThrow("attempt to write a readonly database");
    } finally {
      db.close();
      closeAndRemove(fixture);
    }
  });

  test("safeIntegers surfaces unsafe ids as parse_error", () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 9_007_199_254_740_993n,
      timestamp: "2026-01-01T00:00:00Z",
    });
    fixture.writer.close();
    const db = openReadOnly(fixture.path);
    try {
      expect(() => readFrames(db, 0, 1)).toThrow(
        "kizuki.screenpipe: row id is not a safe integer",
      );
    } finally {
      db.close();
      closeAndRemove(fixture);
    }
  });

  test("a negative source reference becomes no subject, not a failed batch", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      speakerId: -1,
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "transcription:1",
    ]);
    expect(batch.events[0]?.metadata["speaker_id"]).toBeNull();
    expect(
      batch.events[0]?.subjects.map(({ subject_id }) => subject_id),
    ).toEqual(["screenpipe:audio-device:fixture-microphone"]);
    await connector.revoke();
  });
});
