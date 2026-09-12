import { afterEach, describe, expect, test } from "bun:test";
import { BATCH_LIMIT, ScreenpipeConnector, parseCursor, subjectId } from "../src";
import { inspectIdentity } from "../src/identity";
import { openReadOnly } from "../src/open";
import { planUnreachableSourceRecords } from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
  insertTranscription,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

async function digest(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

describe("screenpipe capture and deletion lifecycle", () => {
  test("a malformed row in a later page leaves the prior checkpoint replayable", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= BATCH_LIMIT; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: `frame ${id}`,
        });
      }
    })();
    insertFrame(fixture.writer, {
      id: BATCH_LIMIT + 1,
      timestamp: "not-a-timestamp",
      fullText: "must not emit",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const first = await connector.backfill(null);
    expect(first.events).toHaveLength(BATCH_LIMIT);
    expect(first.has_more).toBe(true);
    if (first.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(first.cursor).last_frame_id).toBe(BATCH_LIMIT);

    await expect(connector.backfill(first.cursor)).rejects.toMatchObject({
      code: "parse_error",
    });
    await expect(connector.backfill(first.cursor)).rejects.toMatchObject({
      code: "parse_error",
    });
    expect(
      (await connector.backfill(null)).events.map(
        ({ source_record_id }) => source_record_id,
      ),
    ).toEqual(first.events.map(({ source_record_id }) => source_record_id));
    await connector.revoke();
  });

  test("a malformed row after settled peers fails the whole batch", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "good",
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "bad",
      fullText: "must not leak",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    await expect(connector.backfill(null)).rejects.toMatchObject({
      code: "parse_error",
    });
    await connector.revoke();
  });

  test("an exact BATCH_LIMIT snapshot is exhausted without a trailing empty page", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= BATCH_LIMIT; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          fullText: `frame ${id}`,
        });
      }
    })();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const first = await connector.backfill(null);
    expect(first.events).toHaveLength(BATCH_LIMIT);
    expect(first.has_more).toBe(false);
    if (first.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(first.cursor).phase).toBe("exhausted");

    const drained = await connector.backfill(first.cursor);
    expect(drained.events).toEqual([]);
    expect(drained.has_more).toBe(false);
    await connector.revoke();
  });

  test("backfill ignores concurrent appends; sync merges them by occurrence including audio offset", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer
      .query(
        `INSERT INTO audio_chunks (id, file_path, timestamp, transcription_status)
         VALUES (1, '/tmp/a.mp4', '2026-01-01T00:00:00Z', 'transcribed')`,
      )
      .run();
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      fullText: "snapshot frame",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const snapshot = await connector.backfill(null);
    expect(snapshot.events.map(({ source_record_id }) => source_record_id)).toEqual(
      ["frame:1"],
    );
    expect(snapshot.has_more).toBe(false);

    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T00:01:00Z",
      fullText: "later frame",
    });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:30Z",
      transcription: "offset audio",
      startTime: 45,
    });
    const stillSnapshot = await connector.backfill(snapshot.cursor);
    expect(stillSnapshot.events).toEqual([]);

    const live = await connector.sync(snapshot.cursor);
    expect(live.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:2",
      "transcription:1",
    ]);
    expect(live.events.map(({ occurred_at }) => occurred_at)).toEqual([
      "2026-01-01T00:01:00.000Z",
      "2026-01-01T00:01:15.000Z",
    ]);
    await connector.revoke();
  });

  test("audio start_time is the merge key against OCR timestamps", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer
      .query(
        `INSERT INTO audio_chunks (id, file_path, timestamp, transcription_status)
         VALUES (1, '/tmp/a.mp4', '2026-01-01T09:59:00Z', 'transcribed')`,
      )
      .run();
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T10:00:00Z",
      fullText: "ocr",
    });
    insertTranscription(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T09:59:00Z",
      transcription: "before the frame",
      startTime: 30,
    });
    insertTranscription(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T09:59:00Z",
      transcription: "after the frame",
      startTime: 90,
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const batch = await connector.backfill(null);
    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "transcription:1",
      "frame:1",
      "transcription:2",
    ]);
    await connector.revoke();
  });

  test("source identity stays stable across batches and ignores later row edits", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      appName: "Acme Mail",
      fullText: "first",
    });
    const before = inspectIdentity(fixture.writer, fixture.path);
    fixture.writer
      .query("UPDATE frames SET full_text = ? WHERE id = 1")
      .run("edited after fingerprint");
    expect(inspectIdentity(fixture.writer, fixture.path).fingerprint).toBe(
      before.fingerprint,
    );

    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const first = await connector.backfill(null);
    expect(first.events[0]?.subjects[0]?.subject_id).toBe(
      subjectId("app", "Acme Mail"),
    );
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-01T00:01:00Z",
      appName: "Acme Mail",
      fullText: "second",
    });
    const live = await connector.sync(first.cursor);
    expect(live.events[0]?.subjects[0]?.subject_id).toBe(
      first.events[0]?.subjects[0]?.subject_id,
    );
    if (first.cursor === null || live.cursor === null) {
      throw new Error("expected screenpipe cursors");
    }
    expect(parseCursor(live.cursor).db_fingerprint).toBe(
      parseCursor(first.cursor).db_fingerprint,
    );
    await connector.revoke();
  });

  test("later source redaction is not reread once the row was consumed", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-01T00:00:00Z",
      browserUrl: "https://mail.acme.example/inbox/42?token=secret",
      fullText: "visible text",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const first = await connector.backfill(null);
    expect(first.events[0]?.text).toBe("visible text");
    expect(JSON.stringify(first.events[0]?.metadata)).not.toContain("secret");
    expect(JSON.stringify(first.events[0]?.subjects)).not.toContain("token");

    fixture.writer
      .query("UPDATE frames SET full_text = ?, browser_url = ? WHERE id = 1")
      .run("REDACTED", "https://mail.acme.example/inbox/42");
    const again = await connector.sync(first.cursor);
    expect(again.events).toEqual([]);
    await connector.revoke();
  });

  test("caught_up is not a completed snapshot", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-08T10:00:00Z",
      fullText: "settling",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 300 },
      { now: () => Date.parse("2026-01-08T10:01:00Z") },
    );
    const held = await connector.backfill(null);
    expect(held.events).toEqual([]);
    expect(held.has_more).toBe(true);
    if (held.cursor === null) throw new Error("expected a screenpipe cursor");
    expect(parseCursor(held.cursor).phase).toBe("caught_up");
    await connector.revoke();
  });

  test("planning through the read-only handle does not write or erase rows", async () => {
    const fixture = createFixtureDatabase();
    fixture.writer.close();
    const before = await digest(fixture.path);
    const reader = openReadOnly(fixture.path);
    try {
      const plan = planUnreachableSourceRecords(
        reader,
        subjectId("app", "Acme Mail"),
      );
      expect(plan).toEqual({
        ids: ["frame:1"],
        truncated: false,
        complete: true,
      });
    } finally {
      reader.close();
    }
    expect(await digest(fixture.path)).toBe(before);
  });

  test("source deletion is not a tombstone and purge does not claim erasure", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );
    const first = await connector.backfill(null);
    expect(first.events.some((event) => event.deleted)).toBe(false);
    expect(connector.manifest().capabilities.tombstones).toBe(false);
    expect(connector.manifest().capabilities.purge).toBe(false);

    fixture.writer.exec("DELETE FROM frames WHERE id = 1");
    const afterDelete = await connector.sync(first.cursor);
    expect(afterDelete.events.filter((event) => event.deleted)).toEqual([]);
    expect(
      afterDelete.events.some((event) => event.source_record_id === "frame:1"),
    ).toBe(false);

    await expect(
      connector.purgeSource(subjectId("app", "Acme Mail")),
    ).rejects.toMatchObject({ code: "not_supported" });
    expect(
      fixture.writer.query("SELECT id FROM frames WHERE id = 2").get(),
    ).not.toBeNull();
    await connector.revoke();
  });
});
