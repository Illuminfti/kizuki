import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_PLAN_IDS,
  ScreenpipeConnector,
} from "../src";
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
  test("an app plan lists every frame of that app under unreachable ids, nothing under source_record_ids", async () => {
    const fixture = createFixtureDatabase();
    const connector = new ScreenpipeConnector(
      { path: fixture.path },
      fixtureDeps("2026-01-09T00:00:00.000Z"),
    );

    expect(await connector.purgeSource("screenpipe:app:acme-mail")).toEqual({
      subject_id: "screenpipe:app:acme-mail",
      source_record_ids: [],
      unreachable_source_record_ids: ["frame:1", "frame:4", "frame:5"],
    });
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
