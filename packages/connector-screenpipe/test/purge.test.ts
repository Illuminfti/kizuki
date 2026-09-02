import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MAX_PLAN_IDS,
  ScreenpipeConnector,
} from "../src";
import { TRIMMED_CODE_POINTS } from "../src/purge";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
  insertTranscription,
} from "./helpers";

afterEach(cleanupFixtureDatabases);

function digest(path: string): Promise<string> {
  return Bun.file(path)
    .arrayBuffer()
    .then((bytes) =>
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    );
}

describe("ScreenpipeConnector purge planning", () => {
  test("a frame of non-ASCII whitespace is absent from the plan", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    // The walk decides a frame has text with String.prototype.trim, which
    // removes every Unicode whitespace code point. A plan built on a smaller
    // set would name rows that never reached the ledger.
    const blanks = ["\u00a0", "\u3000", "\u2028", "  \ufeff"];
    blanks.forEach((text, index) => {
      insertFrame(fixture.writer, {
        id: index + 1,
        timestamp: "2026-01-05T09:00:00Z",
        appName: "Acme Mail",
        fullText: text,
      });
    });
    insertFrame(fixture.writer, {
      id: blanks.length + 1,
      timestamp: "2026-01-05T09:00:00Z",
      appName: "Acme Mail",
      fullText: "real text",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);
    const plan = await connector.purgeSource("screenpipe:app:acme-mail");

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      `frame:${blanks.length + 1}`,
    ]);
    expect(plan.unreachable_source_record_ids).toEqual([
      `frame:${blanks.length + 1}`,
    ]);
    await connector.revoke();
  });

  test("a frame the cutoff excludes is absent from the plan", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    insertFrame(fixture.writer, {
      id: 1,
      timestamp: "2026-01-05T09:00:00Z",
      appName: "Acme Mail",
      fullText: "before the cutoff",
    });
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-02-05T09:00:00Z",
      appName: "Acme Mail",
      fullText: "after the cutoff",
    });
    const connector = new ScreenpipeConnector(
      {
        path: fixture.path,
        settle_seconds: 0,
        since: "2026-02-01T00:00:00Z",
      },
      fixtureDeps("2026-03-01T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);
    const plan = await connector.purgeSource("screenpipe:app:acme-mail");

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:2",
    ]);
    // The cutoff kept frame 1 out of the ledger, so naming it in a plan would
    // tell the owner Kizuki holds evidence it never held.
    expect(plan.unreachable_source_record_ids).toEqual(["frame:2"]);
    await connector.revoke();
  });

  test("a frame whose text column holds a blob is absent from the plan", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    // TEXT affinity keeps a blob a blob, and the reader takes anything but
    // text as no text at all, so the walk skips this row.
    fixture.writer
      .query(
        `INSERT INTO frames
           (id, video_chunk_id, offset_index, timestamp, app_name, window_name,
            browser_url, device_name, focused, full_text, text_source,
            capture_trigger, snapshot_path, document_path)
         VALUES (1, NULL, 0, '2026-01-05T09:00:00Z', 'Acme Mail', NULL, NULL,
                 'Fixture Display', 1, X'6162', 'accessibility', 'fixture',
                 NULL, NULL)`,
      )
      .run();
    insertFrame(fixture.writer, {
      id: 2,
      timestamp: "2026-01-05T09:01:00Z",
      appName: "Acme Mail",
      fullText: "real text",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const batch = await connector.backfill(null);
    const plan = await connector.purgeSource("screenpipe:app:acme-mail");

    expect(batch.events.map(({ source_record_id }) => source_record_id)).toEqual([
      "frame:2",
    ]);
    expect(plan.unreachable_source_record_ids).toEqual(["frame:2"]);
    await connector.revoke();
  });

  test("the plan's blank set is the runtime's own trim set", () => {
    const runtime: number[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      if (String.fromCodePoint(point).trim().length === 0) runtime.push(point);
    }

    expect(TRIMMED_CODE_POINTS).toEqual(runtime);
  });

  test("an app plan lists the frames this connector emitted, nothing under source_record_ids", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path, settle_seconds: 0 },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    // Fixture frames 4 and 5 carry no text and frame 7 carries an unusable
    // timestamp, so none of them was ever ingested; a plan that named them
    // would overstate what Kizuki holds.
    expect(await connector.purgeSource("screenpipe:app:acme-mail")).toEqual({
      subject_id: "screenpipe:app:acme-mail",
      source_record_ids: [],
      unreachable_source_record_ids: ["frame:1"],
    });
    expect(await connector.purgeSource("screenpipe:app:notes")).toEqual({
      subject_id: "screenpipe:app:notes",
      source_record_ids: [],
      unreachable_source_record_ids: ["frame:6"],
    });

    const ingested = new Set(
      (await connector.backfill(null)).events.map(
        ({ source_record_id }) => source_record_id,
      ),
    );
    for (const subject of ["screenpipe:app:acme-mail", "screenpipe:app:notes"]) {
      for (const planned of (await connector.purgeSource(subject))
        .unreachable_source_record_ids) {
        expect(ingested.has(planned)).toBe(true);
      }
    }
    await connector.revoke();
  });

  test("a plan does not bind one parameter per matching name", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= 64; id += 1) {
        // Distinct names that all reduce to the same subject id: the count of
        // colliding names is provider-controlled and must not size the query.
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          appName: `Bulk${" ".repeat(id)}App`,
        });
      }
    })();
    const reader = new Database(fixture.path, {
      readonly: true,
      safeIntegers: true,
    });
    const statements = spyOn(reader, "query");
    const connector = new ScreenpipeConnector(
      { path: fixture.path },
      fixtureDeps("2026-01-09T00:00:00.000Z", () => reader),
    );

    const plan = await connector.purgeSource("screenpipe:app:bulk-app");

    expect(plan.unreachable_source_record_ids).toHaveLength(64);
    for (const [sql] of statements.mock.calls) {
      expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(4);
    }
    await connector.revoke();
  });

  test("a site plan matches by host only", async () => {
    const fixture = createFixtureDatabase();
    insertFrame(fixture.writer, {
      id: 9,
      timestamp: "2026-01-05T12:00:00Z",
      browserUrl: "https://mail.acme.example/another/private/path",
    });
    insertFrame(fixture.writer, {
      id: 10,
      timestamp: "2026-01-05T12:01:00Z",
      browserUrl: "https://other.example/mail.acme.example",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    expect(
      await connector.purgeSource("screenpipe:site:mail.acme.example"),
    ).toEqual({
      subject_id: "screenpipe:site:mail.acme.example",
      source_record_ids: [],
      unreachable_source_record_ids: ["frame:2", "frame:9"],
    });
    await connector.revoke();
  });

  test("a site plan follows the subject id of an address host", async () => {
    const fixture = createFixtureDatabase();
    insertFrame(fixture.writer, {
      id: 9,
      timestamp: "2026-01-05T12:00:00Z",
      browserUrl: "https://[2001:db8::1]/inbox",
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    expect(
      await connector.purgeSource("screenpipe:site:2001-db8-1-1pgckq5"),
    ).toEqual({
      subject_id: "screenpipe:site:2001-db8-1-1pgckq5",
      source_record_ids: [],
      unreachable_source_record_ids: ["frame:9"],
    });
    await connector.revoke();
  });

  test("a speaker plan and a device plan", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    expect(await connector.purgeSource("screenpipe:speaker:1")).toEqual({
      subject_id: "screenpipe:speaker:1",
      source_record_ids: [],
      unreachable_source_record_ids: ["transcription:1"],
    });
    expect(
      await connector.purgeSource(
        "screenpipe:audio-device:display-audio-output",
      ),
    ).toEqual({
      subject_id: "screenpipe:audio-device:display-audio-output",
      source_record_ids: [],
      unreachable_source_record_ids: ["transcription:2"],
    });
    await connector.revoke();
  });

  test("an unknown subject yields an empty plan", async () => {
    const fixture = createFixtureDatabase();
    insertTranscription(fixture.writer, {
      id: 4,
      timestamp: "2026-01-06T12:00:00Z",
      speakerId: 0,
    });
    const connector = new ScreenpipeConnector(
      { path: fixture.path },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    for (const subject_id of [
      "conformance:subject",
      "screenpipe:app:",
      "screenpipe:site:",
      "screenpipe:audio-device:",
      "screenpipe:speaker:0",
      "screenpipe:speaker:-1",
    ]) {
      expect(await connector.purgeSource(subject_id)).toEqual({
        subject_id,
        source_record_ids: [],
        unreachable_source_record_ids: [],
      });
    }
    await connector.revoke();
  });

  test("the plan is capped at MAX_PLAN_IDS", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= MAX_PLAN_IDS + 1; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          appName: "Bulk App",
        });
      }
    })();
    const connector = new ScreenpipeConnector(
      { path: fixture.path },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    const plan = await connector.purgeSource("screenpipe:app:bulk-app");

    expect(plan.unreachable_source_record_ids).toHaveLength(MAX_PLAN_IDS);
    expect(plan.unreachable_source_record_ids[0]).toBe("frame:1");
    expect(plan.unreachable_source_record_ids.at(-1)).toBe(
      `frame:${MAX_PLAN_IDS}`,
    );
    await connector.revoke();
  });

  test("purgeSource never writes", async () => {
    const fixture = createFixtureDatabase();
    fixture.writer.close();
    const before = await digest(fixture.path);
    const connector = new ScreenpipeConnector(
      { path: fixture.path },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    await connector.purgeSource("screenpipe:app:acme-mail");
    await connector.revoke();

    expect(await digest(fixture.path)).toBe(before);
  });
});
