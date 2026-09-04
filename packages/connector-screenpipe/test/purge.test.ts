import { afterEach, describe, expect, test } from "bun:test";
import {
  DISTINCT_SCAN_CAP,
  MAX_PLAN_IDS,
  ScreenpipeConnector,
  planSourceRecords,
  planUnreachableSourceRecords,
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
      planUnreachableSourceRecords(fixture.writer, "screenpipe:app:acme-mail"),
    ).toEqual(["frame:1", "frame:4", "frame:5"]);
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
    ).toEqual(["frame:2", "frame:9"]);
  });

  test("a speaker plan and a device plan", async () => {
    const fixture = createFixtureDatabase();

    expect(
      planUnreachableSourceRecords(fixture.writer, "screenpipe:speaker:1"),
    ).toEqual(["transcription:1"]);
    expect(
      planUnreachableSourceRecords(
        fixture.writer,
        "screenpipe:audio-device:display-audio-output",
      ),
    ).toEqual(["transcription:2"]);
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
      "screenpipe:app:",
      "screenpipe:site:",
      "screenpipe:audio-device:",
      "screenpipe:speaker:0",
      "screenpipe:speaker:-1",
    ]) {
      expect(planUnreachableSourceRecords(fixture.writer, subject_id)).toEqual(
        [],
      );
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

    const plan = planSourceRecords(fixture.writer, "screenpipe:app:bulk-app");

    expect(plan.ids).toHaveLength(MAX_PLAN_IDS);
    expect(plan.truncated).toBe(true);
    expect(plan.ids[0]).toBe("frame:1");
    expect(plan.ids.at(-1)).toBe(`frame:${MAX_PLAN_IDS}`);
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
      "screenpipe:app:app-0001",
    );
    const excluded = planSourceRecords(
      fixture.writer,
      `screenpipe:app:app-${String(DISTINCT_SCAN_CAP + 25).padStart(4, "0")}`,
    );
    expect(included.ids).toEqual(["frame:1"]);
    expect(excluded.ids).toEqual([]);
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
