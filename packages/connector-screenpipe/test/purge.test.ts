import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
import {
  DISTINCT_SCAN_CAP,
  MAX_PLAN_IDS,
  ScreenpipeConnector,
  planSourceRecords,
  planUnreachableSourceRecords,
  subjectId,
} from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
  insertFrame,
  insertTranscription,
} from "./helpers";

function digest(path: string): Promise<string> {
  return Bun.file(path)
    .arrayBuffer()
    .then((bytes) =>
      new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    );
}

describe("ScreenpipeConnector source purge", () => {
  test("purgeSource is not supported and does not claim source deletion", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    expect(connector.manifest().capabilities.purge).toBe(false);
    await expect(
      connector.purgeSource("screenpipe:app:acme-mail"),
    ).rejects.toMatchObject({
      code: "not_supported",
    });
    await connector.revoke();
  });

  test("an app plan lists every frame of that app without deleting them", async () => {
    const fixture = createFixtureDatabase();

    expect(
      planUnreachableSourceRecords(fixture.writer, subjectId("app", "Acme Mail")),
    ).toEqual({
      ids: ["frame:1"],
      truncated: false,
      complete: true,
    });
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

    expect(
      planUnreachableSourceRecords(
        fixture.writer,
        "screenpipe:site:mail.acme.example",
      ),
    ).toEqual({
      ids: ["frame:2", "frame:9"],
      truncated: false,
      complete: true,
    });
  });

  test("a speaker plan and a device plan", async () => {
    const fixture = createFixtureDatabase();

    expect(
      planUnreachableSourceRecords(fixture.writer, "screenpipe:speaker:1"),
    ).toEqual({ ids: ["transcription:1"], truncated: false, complete: true });
    expect(
      planUnreachableSourceRecords(
        fixture.writer,
        subjectId("audio-device", "Display Audio (output)"),
      ),
    ).toEqual({ ids: ["transcription:2"], truncated: false, complete: true });
  });

  test("an unknown subject yields an empty plan", async () => {
    const fixture = createFixtureDatabase();
    insertTranscription(fixture.writer, {
      id: 4,
      timestamp: "2026-01-06T12:00:00Z",
      speakerId: 0,
    });

    for (const subject_id of [
      "conformance:subject",
      "screenpipe:site:",
      "screenpipe:speaker:0",
      "screenpipe:speaker:-1",
    ]) {
      expect(planUnreachableSourceRecords(fixture.writer, subject_id)).toEqual({ ids: [], truncated: false, complete: true });
    }
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

    const plan = planSourceRecords(fixture.writer, subjectId("app", "Bulk App"));

    expect(plan.ids).toHaveLength(MAX_PLAN_IDS);
    expect(plan.truncated).toBe(true);
    expect(plan.complete).toBe(false);
    expect(plan.continuation).toBeDefined();
    expect(plan.ids[0]).toBe("frame:1");
    expect(plan.ids.at(-1)).toBe(`frame:${MAX_PLAN_IDS}`);
    const next = planSourceRecords(
      fixture.writer,
      subjectId("app", "Bulk App"),
      Date.now,
      plan.continuation,
    );
    expect(next).toMatchObject({ ids: [`frame:${MAX_PLAN_IDS + 1}`], complete: true });
    expect(new Set([...plan.ids, ...next.ids]).size).toBe(MAX_PLAN_IDS + 1);
  });

  test("an exact 10,000-row plan is complete and a deadline returns a retryable continuation", () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= MAX_PLAN_IDS; id += 1) {
        insertFrame(fixture.writer, { id, timestamp: "2026-01-01T00:00:00Z", appName: "Exact" });
      }
    })();
    const exact = planSourceRecords(fixture.writer, subjectId("app", "Exact"));
    expect(exact).toMatchObject({ complete: true, truncated: false });
    expect(exact.ids).toHaveLength(MAX_PLAN_IDS);
    let tick = 0;
    const timedOut = planSourceRecords(
      fixture.writer,
      subjectId("app", "Exact"),
      () => (tick += 2_001),
    );
    expect(timedOut).toMatchObject({ ids: [], complete: false, truncated: true });
    expect(timedOut.continuation).toBeDefined();
  });

  test("continuations reject a different subject or database", () => {
    const first = createFixtureDatabase({ rows: false });
    first.writer.transaction(() => {
      for (let id = 1; id <= MAX_PLAN_IDS + 1; id += 1) {
        insertFrame(first.writer, { id, timestamp: "2026-01-01T00:00:00Z", appName: "Bound" });
      }
    })();
    const page = planSourceRecords(first.writer, subjectId("app", "Bound"));
    expect(() => planSourceRecords(first.writer, subjectId("app", "Other"), Date.now, page.continuation)).toThrow("does not match");
    const other = createFixtureDatabase({ rows: false });
    expect(() => planSourceRecords(other.writer, subjectId("app", "Bound"), Date.now, page.continuation)).toThrow("restart enumeration");
  });

  test("a continuation rejects changed rows even when the path, schema, and maxima stay the same", () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= MAX_PLAN_IDS + 1; id += 1) insertFrame(fixture.writer, { id, timestamp: "2026-01-01T00:00:00Z", appName: "Stable" });
    })();
    const page = planSourceRecords(fixture.writer, subjectId("app", "Stable"));
    fixture.writer.query("UPDATE frames SET window_name = ? WHERE id = 5000").run("replacement content");
    expect(() => planSourceRecords(fixture.writer, subjectId("app", "Stable"), Date.now, page.continuation)).toThrow("restart enumeration");
  });

  test("a continuation rejects a replacement database with the same path, schema, and maxima", () => {
    const fixture = createFixtureDatabase({ rows: false });
    const replacement = createFixtureDatabase({ rows: false });
    for (const database of [fixture.writer, replacement.writer]) {
      database.transaction(() => {
        for (let id = 1; id <= MAX_PLAN_IDS + 1; id += 1) {
          insertFrame(database, { id, timestamp: "2026-01-01T00:00:00Z", appName: "Replaced" });
        }
      })();
    }
    const page = planSourceRecords(fixture.writer, subjectId("app", "Replaced"));
    replacement.writer.close();
    renameSync(replacement.path, fixture.path);
    expect(() => planSourceRecords(fixture.writer, subjectId("app", "Replaced"), Date.now, page.continuation)).toThrow("restart enumeration");
  });

  test("a mutation during a page never returns a completeness claim", () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.exec("PRAGMA journal_mode = WAL");
    fixture.writer.transaction(() => {
      for (let id = 1; id <= MAX_PLAN_IDS + 1; id += 1) {
        insertFrame(fixture.writer, { id, timestamp: "2026-01-01T00:00:00Z", appName: "Race" });
      }
    })();
    const changer = new Database(fixture.path, { safeIntegers: true });
    let calls = 0;
    expect(() => planSourceRecords(fixture.writer, subjectId("app", "Race"), () => {
      calls += 1;
      if (calls === 2) changer.query("UPDATE frames SET window_name = ? WHERE id = 1").run("changed mid-page");
      return 0;
    })).toThrow("restart enumeration");
    changer.close();
  });

  test("distinct-value scans used for planning are capped", async () => {
    const fixture = createFixtureDatabase({ rows: false });
    fixture.writer.transaction(() => {
      for (let id = 1; id <= DISTINCT_SCAN_CAP + 25; id += 1) {
        insertFrame(fixture.writer, {
          id,
          timestamp: "2026-01-01T00:00:00Z",
          appName: `App ${String(id).padStart(4, "0")}`,
        });
      }
    })();

    const included = planSourceRecords(
      fixture.writer,
      subjectId("app", "App 0001"),
    );
    const excluded = planSourceRecords(
      fixture.writer,
      subjectId("app", `App ${String(DISTINCT_SCAN_CAP + 25).padStart(4, "0")}`),
    );
    expect(included.ids).toEqual(["frame:1"]);
    expect(included.complete).toBe(true);
    expect(excluded.ids).toEqual([`frame:${DISTINCT_SCAN_CAP + 25}`]);
    expect(excluded.complete).toBe(true);
  });

  test("planning never writes", async () => {
    const fixture = createFixtureDatabase();
    fixture.writer.close();
    const before = await digest(fixture.path);
    const connector = new ScreenpipeConnector(
      { path: fixture.path },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    await expect(
      connector.purgeSource("screenpipe:app:acme-mail"),
    ).rejects.toMatchObject({ code: "not_supported" });
    await connector.revoke();

    expect(await digest(fixture.path)).toBe(before);
  });
});
